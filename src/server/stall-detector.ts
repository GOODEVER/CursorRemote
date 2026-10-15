import type { AgentStatus, CursorState } from './types.js';

/**
 * How long the extracted DOM may stay byte-for-byte identical while the state
 * still claims the agent is working before we call it "stalled".
 *
 * Why this exists: Cursor's renderer can block its main thread (or get
 * background-throttled) while the *actual* agent has already finished. The DOM
 * extractor keeps succeeding — it just keeps returning the same frozen
 * snapshot, `canAbort` stays true, and the web client happily believes the
 * turn is still running forever. Nothing here is destructive: it only powers a
 * "no updates — refresh" nudge and an automatic forced re-extraction.
 *
 * A genuinely long-running tool (a multi-minute build) also produces no DOM
 * change, so this deliberately errs toward a gentle nudge rather than an error.
 */
export const AGENT_STALL_MS = 45_000;

/** A status that implies the agent is actively doing something. */
export function isWorkingStatus(status: AgentStatus): boolean {
  return status !== 'idle' && status !== 'waiting_approval' && status !== 'error';
}

/**
 * Whether the state asserts the agent is busy right now. Mirrors the client's
 * ground-truth `isAgentWorking()` so server and phone agree on "working".
 */
export function claimsWork(state: Pick<CursorState, 'canAbort' | 'agentActivityLive' | 'agentStatus'>): boolean {
  return !!state.canAbort || !!state.agentActivityLive || isWorkingStatus(state.agentStatus);
}

/**
 * Cheap fingerprint of everything that should move while the agent works.
 *
 * Deliberately excludes volatile bookkeeping (`lastExtractionAt`,
 * `extractorStatus`, failure counters): those change on *every* successful poll
 * and would otherwise make a frozen DOM look like it is still progressing.
 */
export function extractionContentKey(state: CursorState): string {
  const last = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
  return JSON.stringify([
    state.agentStatus,
    state.agentActivityText,
    !!state.canAbort,
    state.messages.length,
    last ? last.id : '',
    last ? last.type : '',
    state.pendingApprovals.length,
    state.questionnaire ? state.questionnaire.totalLabel : '',
    state.composerQueue?.items?.length ?? 0,
    state.chatTabs.length,
    state.activeComposerId,
  ]);
}

export interface StallTracker {
  contentKey: string;
  /** When the content key last changed (ms since epoch). */
  changedAt: number;
  stalled: boolean;
}

/**
 * Fold one extraction into the running stall tracker.
 *
 * `stalled` is true when the content has not moved for `AGENT_STALL_MS` *and*
 * the state still claims work — the exact "phone says working, Cursor is done"
 * mismatch. An idle/blocked agent never counts as stalled, so a quiet idle
 * session does not nag the user.
 */
export function detectStall(
  prev: StallTracker | null,
  state: CursorState,
  now: number,
  stallMs: number = AGENT_STALL_MS
): StallTracker {
  const contentKey = extractionContentKey(state);
  const changedAt = !prev || prev.contentKey !== contentKey ? now : prev.changedAt;
  const stalled = claimsWork(state) && now - changedAt >= stallMs;
  return { contentKey, changedAt, stalled };
}
