import { EventEmitter } from 'events';
import type { CursorState, CursorWindow } from './types.js';
import { AGENT_ACTIVITY_STALE_MS } from './activity-stale.js';
import { detectStall, type StallTracker } from './stall-detector.js';
import { SignatureCache } from './signature-cache.js';
import { applyMessageDelta, computeMessagePatch } from './message-delta.js';
import type { PollTiming } from './poll-timing.js';
import type { MessageDelta } from './types.js';

function emptyState(): CursorState {
  return {
    connected: false,
    extractorStatus: 'idle',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'idle',
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: 'none',
    canAbort: false,
    agentStalled: false,
    agentStalledSince: null,
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
    slashCommands: [],
    folders: [],
  };
}

export class StateManager extends EventEmitter {
  private currentState: CursorState = emptyState();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Partial<CursorState> | null = null;
  private debounceMs: number;
  private consecutiveNulls = 0;
  private readonly nullWarningThreshold = 10;
  private _generation = 0;
  /** When the current activity string first appeared (unchanged since). */
  private activityStableSince: number | null = null;
  private activityStableText: string | undefined = undefined;
  /**
   * After staleness clears `agentActivityText`, the DOM often keeps sending the same
   * string every poll; suppress that exact label until it changes or clears (Telegram
   * does not re-post activity when the snapshot is otherwise unchanged).
   */
  private activitySuppressedMatch: string | undefined = undefined;
  /** Tracks whether the extracted DOM has stopped changing while still "working". */
  private stallTracker: StallTracker | null = null;

  /** Memoizes serialized state values so the diff never re-serializes the same
   *  transcript/sub-object twice (see SignatureCache). */
  private signatures = new SignatureCache();
  /** Optional rolling timers for the extract → diff → emit path. */
  private timing: PollTiming | null = null;

  get generation(): number {
    return this._generation;
  }

  constructor(debounceMs: number, timing?: PollTiming | null) {
    super();
    this.debounceMs = debounceMs;
    this.timing = timing ?? null;
  }

  getCurrentState(): CursorState {
    return this.currentState;
  }

  /**
   * Record a successful poll that did not need a full re-extract (fingerprint
   * matched). Refreshes extractor health locally without emitting a patch —
   * clients do not need `lastExtractionAt` every 300ms.
   */
  touchSuccessfulExtraction(): void {
    this.consecutiveNulls = 0;
    const connected = this.currentState.connected;
    this.currentState = {
      ...this.currentState,
      extractorStatus: connected ? 'ok' : 'idle',
      lastExtractionAt: Date.now(),
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
    };
  }

  /**
   * Called by the DOM extractor on each poll cycle.
   * Diffs against previous state and emits patches.
   */
  onExtraction(newState: CursorState | null): void {
    if (newState === null) {
      this.onExtractionFailure('Extraction returned null');
      return;
    }

    this.consecutiveNulls = 0;
    this._generation++;
    // Preserve bridge-managed fields that the DOM extractor should not own.
    const now = Date.now();
    newState.connected = this.currentState.connected;
    newState.extractorStatus = this.currentState.connected ? 'ok' : 'idle';
    newState.lastExtractionAt = now;
    newState.consecutiveExtractionFailures = 0;
    newState.lastExtractionError = null;
    newState.windows = this.currentState.windows;
    newState.activeWindowId = this.currentState.activeWindowId;
    // The folder tree lives only in the "Cursor Agents" overview window, pulled
    // in via updateFolders(). The home extractor returns an empty array, so keep
    // the aggregated folders unless this extraction actually found some.
    if (!newState.folders || newState.folders.length === 0) {
      newState.folders = this.currentState.folders;
    }

    const stateForApply = this.applyActivityStaleness(newState);

    // Detect the "phone says working, Cursor actually finished/frozen" case: the
    // content has not moved for AGENT_STALL_MS while the state still claims work.
    // Measured against the RAW extraction (`newState`), not `stateForApply`: the
    // activity-text staleness clear at 30s would otherwise reset the stall clock
    // — a frozen agent would report "Thinking" for 30s, go idle, and silently
    // re-arm without ever crossing the threshold.
    this.stallTracker = detectStall(this.stallTracker, newState, now);
    const stalledState: CursorState = {
      ...stateForApply,
      agentStalled: this.stallTracker.stalled,
      agentStalledSince: this.stallTracker.stalled ? this.stallTracker.changedAt : null,
    };

    const diffStarted = this.timing ? Date.now() : 0;
    const patch = this.diff(this.currentState, stalledState);
    if (this.timing) {
      this.timing.record({ diffMs: Date.now() - diffStarted });
    }
    if (!patch) return;

    // Canonical state always holds the full transcript; messageDelta is
    // wire-only (added in diff) and is never copied onto currentState.
    this.currentState = stalledState;
    this.schedulePatch(patch);
  }

  onExtractionFailure(message: string | null): void {
    this.consecutiveNulls++;
    if (this.consecutiveNulls === this.nullWarningThreshold) {
      console.warn(
        `[state-manager] ${this.nullWarningThreshold} consecutive failed extractions. ` +
        'Selectors may need updating or the Cursor window may be background-throttled.'
      );
    }

    const connected = this.currentState.connected;
    const nextState: CursorState = {
      ...this.currentState,
      extractorStatus:
        connected && this.currentState.lastExtractionAt != null ? 'stale' : connected ? 'waiting' : 'idle',
      consecutiveExtractionFailures: this.currentState.consecutiveExtractionFailures + 1,
      lastExtractionError: message,
      // A failed extraction is not a stalled one — that signal needs a fresh
      // reading. The failing extractor already drives its own "Cursor stalled"
      // UI, so clear the content-stall flag to avoid two competing banners.
      agentStalled: false,
      agentStalledSince: null,
    };

    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.schedulePatch(patch);
  }

  /**
   * Drop `agentActivityText` after AGENT_ACTIVITY_STALE_MS with no text change
   * (same semantics as Telegram's ephemeral activity deletion) so the web header
   * does not show "Thinking" forever when Telegram has already removed the line.
   */
  private applyActivityStaleness(newState: CursorState): CursorState {
    const text = newState.agentActivityText?.trim()
      ? newState.agentActivityText.trim()
      : null;

    if (!text) {
      this.activityStableSince = null;
      this.activityStableText = undefined;
      this.activitySuppressedMatch = undefined;
      if (newState.agentActivityText === null || newState.agentActivityText === '') {
        return newState;
      }
      return {
        ...newState,
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (
      this.activitySuppressedMatch != null &&
      text === this.activitySuppressedMatch
    ) {
      return {
        ...newState,
        agentStatus:
          newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
            ? newState.agentStatus
            : 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
      };
    }

    if (this.activitySuppressedMatch != null && text !== this.activitySuppressedMatch) {
      this.activitySuppressedMatch = undefined;
    }

    const now = Date.now();
    if (text === this.activityStableText && this.activityStableSince != null) {
      if (now - this.activityStableSince >= AGENT_ACTIVITY_STALE_MS) {
        this.activityStableSince = null;
        this.activityStableText = undefined;
        this.activitySuppressedMatch = text;
        return {
          ...newState,
          agentStatus:
            newState.agentStatus === 'waiting_approval' || newState.agentStatus === 'error'
              ? newState.agentStatus
              : 'idle',
          agentActivityText: null,
          agentActivityLive: false,
          agentActivitySource: 'none',
        };
      }
      return newState;
    }

    this.activityStableText = text;
    this.activityStableSince = now;
    return newState;
  }

  /**
   * Re-arm the stall detector after a forced/manual refresh.
   *
   * Clears `agentStalled` immediately (so the phone's "no updates" nudge
   * disappears the moment the user taps Refresh) and restarts the content
   * baseline, so the warning only returns if the DOM freezes *again* for a
   * full AGENT_STALL_MS window.
   */
  resetStall(): void {
    this.stallTracker = null;
    if (!this.currentState.agentStalled && this.currentState.agentStalledSince === null) return;
    const nextState: CursorState = {
      ...this.currentState,
      agentStalled: false,
      agentStalledSince: null,
    };
    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.emit('state:patch', patch);
  }

  onConnectionChanged(connected: boolean): void {
    // A reconnect means the previous extraction baseline is no longer valid.
    this.stallTracker = null;
    const nextState: CursorState = {
      ...this.currentState,
      connected,
      extractorStatus: connected ? 'waiting' : 'idle',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStalled: false,
      agentStalledSince: null,
    };
    const patch = this.diff(this.currentState, nextState);
    if (!patch) return;
    this.currentState = nextState;
    this.emit('state:patch', patch);
    this.emit('connection:changed', connected);
  }

  updateWindows(windows: CursorWindow[], activeWindowId: string): void {
    const changed =
      this.currentState.activeWindowId !== activeWindowId ||
      JSON.stringify(this.currentState.windows) !== JSON.stringify(windows);
    if (!changed) return;
    this.currentState = { ...this.currentState, windows, activeWindowId };
    this.emit('state:patch', { windows, activeWindowId });
  }

  /** Push per-window mode/model into global state (e.g. from a cached snapshot on window switch). */
  updateModeModel(mode: CursorState['mode'], model: CursorState['model']): void {    const modeChanged = this.currentState.mode?.current !== mode?.current;
    const modelChanged = this.currentState.model?.current !== model?.current
      || this.currentState.model?.currentId !== model?.currentId;
    if (!modeChanged && !modelChanged) return;
    const patch: Partial<CursorState> = {};
    if (modeChanged) patch.mode = mode;
    if (modelChanged) patch.model = model;
    this.currentState = { ...this.currentState, ...patch };
    this.emit('state:patch', patch);
  }

  /**
   * Push the workspace folder list into global state. The folder tree only
   * exists in Cursor's "Cursor Agents" overview window, whereas the relay's
   * home window may be a plain workspace window that has none — so the window
   * monitor feeds the folders in from whichever window exposes them.
   */
  updateFolders(folders: CursorState['folders']): void {
    const next = folders ?? [];
    if (JSON.stringify(this.currentState.folders ?? []) === JSON.stringify(next)) return;
    this.currentState = { ...this.currentState, folders: next };
    this.emit('state:patch', { folders: next });
  }

  private diff(
    prev: CursorState,
    next: CursorState
  ): Partial<CursorState> | null {
    const patch: Partial<CursorState> = {};
    let hasChange = false;

    if (prev.connected !== next.connected) {
      patch.connected = next.connected;
      hasChange = true;
    }

    if (prev.extractorStatus !== next.extractorStatus) {
      patch.extractorStatus = next.extractorStatus;
      hasChange = true;
    }

    if (prev.lastExtractionAt !== next.lastExtractionAt) {
      patch.lastExtractionAt = next.lastExtractionAt;
      hasChange = true;
    }

    if (prev.consecutiveExtractionFailures !== next.consecutiveExtractionFailures) {
      patch.consecutiveExtractionFailures = next.consecutiveExtractionFailures;
      hasChange = true;
    }

    if (prev.lastExtractionError !== next.lastExtractionError) {
      patch.lastExtractionError = next.lastExtractionError;
      hasChange = true;
    }

    if (prev.agentStatus !== next.agentStatus) {
      patch.agentStatus = next.agentStatus;
      hasChange = true;
    }

    if (prev.agentActivityText !== next.agentActivityText) {
      patch.agentActivityText = next.agentActivityText;
      hasChange = true;
    }

    if (prev.agentActivityLive !== next.agentActivityLive) {
      patch.agentActivityLive = next.agentActivityLive;
      hasChange = true;
    }

    if (prev.agentActivitySource !== next.agentActivitySource) {
      patch.agentActivitySource = next.agentActivitySource;
      hasChange = true;
    }

    if (prev.canAbort !== next.canAbort) {
      patch.canAbort = next.canAbort;
      hasChange = true;
    }

    if (prev.agentStalled !== next.agentStalled) {
      patch.agentStalled = next.agentStalled;
      hasChange = true;
    }

    if (prev.agentStalledSince !== next.agentStalledSince) {
      patch.agentStalledSince = next.agentStalledSince;
      hasChange = true;
    }

    if (prev.activeComposerId !== next.activeComposerId) {
      patch.activeComposerId = next.activeComposerId;
      hasChange = true;
    }

    if (prev.inputAvailable !== next.inputAvailable) {
      patch.inputAvailable = next.inputAvailable;
      hasChange = true;
    }

    if (this.signatures.differs(prev.messages, next.messages)) {
      const msgPatch = computeMessagePatch(
        prev.messages,
        next.messages,
        (a, b) => this.signatures.differs(a, b)
      );
      if (msgPatch.kind === 'full') {
        patch.messages = msgPatch.messages;
        hasChange = true;
      } else if (msgPatch.kind === 'delta') {
        patch.messageDelta = msgPatch.messageDelta;
        hasChange = true;
      }
    }

    if (this.signatures.differs(prev.pendingApprovals, next.pendingApprovals)) {
      patch.pendingApprovals = next.pendingApprovals;
      hasChange = true;
    }

    if (this.signatures.differs(prev.chatTabs, next.chatTabs)) {
      patch.chatTabs = next.chatTabs;
      hasChange = true;
    }

    if (prev.mode?.current !== next.mode?.current) {
      patch.mode = next.mode;
      hasChange = true;
    }

    if (prev.model?.current !== next.model?.current || prev.model?.currentId !== next.model?.currentId) {
      patch.model = next.model;
      hasChange = true;
    }

    if (this.signatures.differs(prev.windows, next.windows)) {
      patch.windows = next.windows;
      hasChange = true;
    }

    if (prev.activeWindowId !== next.activeWindowId) {
      patch.activeWindowId = next.activeWindowId;
      hasChange = true;
    }

    if (this.signatures.differs(prev.composerQueue, next.composerQueue)) {
      patch.composerQueue = next.composerQueue;
      hasChange = true;
    }

    if (this.signatures.differs(prev.questionnaire, next.questionnaire)) {
      patch.questionnaire = next.questionnaire;
      hasChange = true;
    }

    if (this.signatures.differs(prev.slashCommands ?? [], next.slashCommands ?? [])) {
      patch.slashCommands = next.slashCommands ?? [];
      hasChange = true;
    }

    if (this.signatures.differs(prev.folders ?? [], next.folders ?? [])) {
      patch.folders = next.folders ?? [];
      hasChange = true;
    }

    return hasChange ? patch : null;
  }

  private schedulePatch(patch: Partial<CursorState>): void {
    this.pendingPatch = this.pendingPatch
      ? this.mergePatches(this.pendingPatch, patch)
      : patch;

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingPatch) {
          this.emit('state:patch', this.pendingPatch);
          this.pendingPatch = null;
        }
      }, this.debounceMs);
    }
  }

  /**
   * Coalesce two patches in the debounce window. Message deltas must merge by
   * id — a naive `{ ...a, ...b }` would drop earlier upserts when two streaming
   * ticks land inside DEBOUNCE_MS.
   */
  private mergePatches(
    a: Partial<CursorState>,
    b: Partial<CursorState>
  ): Partial<CursorState> {
    const merged: Partial<CursorState> = { ...a, ...b };

    const aMsg = 'messages' in a || 'messageDelta' in a;
    const bMsg = 'messages' in b || 'messageDelta' in b;
    if (!aMsg && !bMsg) return merged;

    // Latest full replace wins and clears any delta.
    if (b.messages) {
      delete merged.messageDelta;
      merged.messages = b.messages;
      return merged;
    }

    // Apply a delta onto a pending full snapshot.
    if (a.messages && b.messageDelta) {
      merged.messages = applyMessageDelta(a.messages, b.messageDelta);
      delete merged.messageDelta;
      return merged;
    }

    // Two deltas: union upserts/removes; prefer the newer order when present.
    if (a.messageDelta && b.messageDelta) {
      merged.messageDelta = mergeMessageDeltas(a.messageDelta, b.messageDelta);
      delete merged.messages;
      return merged;
    }

    if (b.messageDelta) {
      merged.messageDelta = b.messageDelta;
      delete merged.messages;
    }
    return merged;
  }
}

function mergeMessageDeltas(a: MessageDelta, b: MessageDelta): MessageDelta {
  const removeIds = [...new Set([...(a.removeIds ?? []), ...(b.removeIds ?? [])])];
  const byId = new Map<string, CursorState['messages'][number]>();
  for (const m of a.upsert ?? []) byId.set(m.id, m);
  for (const m of b.upsert ?? []) byId.set(m.id, m);
  for (const id of removeIds) byId.delete(id);
  const order = b.order ?? a.order;
  return {
    upsert: [...byId.values()],
    removeIds,
    ...(order ? { order } : {}),
  };
}
