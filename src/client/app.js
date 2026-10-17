/* global io */

(function () {
  'use strict';

  const AUTH_TOKEN_KEY = 'cursor-remote-token';
  const defaultState = {
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
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
    slashCommands: [],
    folders: [],
    activeComposerId: '',
  };

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function newCommandId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  async function checkAuth() {
    try {
      const res = await fetch('/health', {
        credentials: 'same-origin',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired) {
          if (data.sessionValid === true) return true;
          if (data.sessionValid === false) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = '/login';
            return false;
          }
          // Older relay without sessionValid: fall back to presence of stored token
          if (getAuthToken()) return true;
          window.location.href = '/login';
          return false;
        }
      }
    } catch { /* network error, proceed anyway */ }
    return true;
  }

  async function init() {
    if (!await checkAuth()) return;
    bootstrap();
  }

  function bootstrap() {

  let state = { ...defaultState };

  let userScrolledUp = false;
  let autoScrollJob = 0;
  let notificationPermission = 'default';
  // Edge-triggered notification bookkeeping. We notify only when the agent
  // newly asks a question / needs approval, or when it has genuinely finished.
  let hadQuestionnaire = false;
  let hadApproval = false;
  let notificationsPrimed = false;
  // Composer the edge state belongs to. Switching chats must re-prime rather
  // than treat "previous agent was working, new one is idle" as a finish —
  // that was the false ping when opening another folder.
  let notifyComposerId = '';
  // Auto-open bookkeeping: when the relay is pointed at Cursor's "Cursor Agents"
  // overview, no chat is mounted, so the transcript is empty until the user
  // taps an agent. We automatically open a chat (the relay's current one, or the
  // most recent agent) once per connection so the chats start loading on their
  // own instead of requiring a manual init click.
  const AUTO_OPEN_TRIES = 3;
  let autoOpenAttempts = 0;
  let autoOpenDone = false;
  let autoOpenPending = false;
  let autoOpenTimer = null;
  // "Finished" detection: the agent's status flaps between working and idle
  // mid-run, so we track whether it was working and debounce the idle reading.
  let wasWorking = false;
  let finishTimer = null;
  const FINISH_SETTLE_MS = 5000;
  let activePlanModal = null;
  let activePlanModelContext = null;
  // Questionnaire routing. `homeQuestionnaire` mirrors the home window's
  // questionnaire from state:full/state:patch; `remoteQuestionnaires` holds
  // questionnaires for non-home windows from `window:snapshot`. We render
  // whichever is present, preferring the home window, and remember the window a
  // remote question came from so answers target it.
  let homeQuestionnaire = null;
  const remoteQuestionnaires = new Map();
  let questionnaireWindowId = '';
  // Text a slash command left in the host composer; when set, sendMessage()
  // submits in place via send_prompt rather than retyping.
  let composerPrefilledText = '';
  const pendingCommandResults = new Map();

  // Commands sheet: the live local filter, the query the shown list belongs to
  // (to drop stale responses), and the debounce handle. Cursor's tray only ever
  // renders ~14 rows and never scrolls, so the filter is what unlocks the rest.
  let slashSearchQuery = '';
  let slashRenderedQuery = null;
  let slashSearchTimer = null;
  const SLASH_SEARCH_DEBOUNCE_MS = 220;

  // Recently / frequently used commands, kept per device in localStorage. Each
  // entry is { k (token), n (use count), t (last used, ms) }. Merged into the
  // unfiltered sheet as a "Recent" section and used to bias ordering.
  const SLASH_USAGE_KEY = 'cursor-remote-slash-usage';
  const SLASH_USAGE_MAX = 30;
  let slashUsage = loadSlashUsage();

  function loadSlashUsage() {
    try {
      const raw = localStorage.getItem(SLASH_USAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(e => e && typeof e.k === 'string' && e.k)
        .map(e => ({ k: e.k, n: Number(e.n) || 1, t: Number(e.t) || 0 }))
        .slice(0, SLASH_USAGE_MAX);
    } catch (_) {
      return [];
    }
  }

  function recordSlashUsage(token) {
    if (!token) return;
    const key = String(token).toLowerCase();
    const existing = slashUsage.find(e => e.k === key);
    if (existing) {
      existing.n += 1;
      existing.t = Date.now();
    } else {
      slashUsage.unshift({ k: key, n: 1, t: Date.now() });
    }
    // Most-recent first, then trim; used ordering is computed separately.
    slashUsage.sort((a, b) => b.t - a.t);
    slashUsage = slashUsage.slice(0, SLASH_USAGE_MAX);
    try {
      localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(slashUsage));
    } catch (_) { /* storage full / unavailable — recents are best-effort */ }
  }

  /** A command's usage rank for sorting: most-used first, tie-broken by recency. */
  function slashUsageRank(token) {
    const key = String(token || '').toLowerCase();
    const entry = slashUsage.find(e => e.k === key);
    if (!entry) return { used: 0, rank: -1, t: 0 };
    const index = slashUsage.indexOf(entry);
    return { used: entry.n, rank: index, t: entry.t };
  }

  /**
   * Per-window status for the agent open in each window, used to render a glyph
   * in the folder menu: a spinner while it is working, a "?" while it waits on a
   * question, and a "!" while it waits on an approval. Seeded from the home
   * window's live state and refreshed by each `window:snapshot` (which carries
   * the ground-truth `canAbort` flag plus the questionnaire/approval widgets).
   * Cursor's sidebar rows expose no per-agent status in the DOM (probed: no
   * aria-busy, no status class), so this server signal is the only reliable
   * source. Keyed by window so a window flipping to idle clears its own entry.
   * Each entry is timestamped so a window that stops reporting (closed) can be
   * pruned rather than leaving a ghost glyph behind.
   */
  const snapshotWorkingComposers = new Map();
  const WORKING_SNAPSHOT_TTL_MS = 30000;

  // Full transcript for the composer currently open, sourced from Cursor's
  // database (event `history:full`). Cursor virtualizes the transcript DOM and
  // only mounts the messages nearest its scroll position, so the live state
  // stream is clipped to a handful of items; we merge this history ahead of the
  // live tail in renderMessages() so switching folders shows the whole chat.
  // Paged history: first request is the newest page; older pages prepend while
  // hasMore. `oldestIndex` is the server header index of messages[0].
  let fullHistory = { composerId: '', messages: [], oldestIndex: 0, hasMore: false };
  const HISTORY_PAGE_LIMIT = 80;
  let historyPageInFlight = false;
  // Composer we are expecting a history payload for / last asked the server for.
  let pendingHistoryComposerId = '';
  let lastRequestedHistoryComposerId = '';
  // Composer the user explicitly picked (folder agent / tab). While set, the
  // automatic "load the composer Cursor is showing" logic must NOT fire, or the
  // stale `state.activeComposerId` (the server's DOM hasn't switched yet)
  // instantly re-requests the previous chat and yanks the user back — the
  // "switching folders instantly switches back" bug. Cleared once the server's
  // active composer catches up to the selection.
  let pinnedComposerId = '';
  // Safety release: if the server never reports the pinned composer as active
  // (e.g. it lives in another window), stop blocking auto-history after a while.
  let pinnedComposerTimer = null;
  const PINNED_COMPOSER_TIMEOUT_MS = 8000;
  // While a newly-created folder agent is being adopted, we must NOT render the
  // old transcript. Two stale sources would otherwise linger: the live DOM tail
  // (`state.messages`) still describes the previous composer until the relay
  // switches, and a late `history:full` for the previous composer can arrive
  // after the switch. While this is set, renderMessages() shows the empty state
  // unless the messages actually belong to the pinned (new) composer.
  let suppressTranscriptUntil = '';

  function isNearMessagesBottom() {
    const threshold = 80;
    return $messages.scrollTop + $messages.clientHeight >= $messages.scrollHeight - threshold;
  }

  // Scroll the transcript to the bottom, and keep it there while content grows.
  // The synchronous apply matters: requestAnimationFrame does NOT run in a
  // backgrounded tab, so a purely rAF-based scroll never happens while the user
  // is away and they return to a view stuck at the top. We scroll immediately
  // (layout is already up to date after the render), then re-pin on the next
  // couple of frames to catch async content (HTML bodies, images, reflow).
  function pinMessagesToBottom() {
    const jobId = ++autoScrollJob;
    const apply = () => {
      if (jobId !== autoScrollJob) return;
      if (userScrolledUp) return;
      if ($messages.scrollTop !== $messages.scrollHeight) {
        $messages.scrollTop = $messages.scrollHeight;
      }
    };
    apply();
    requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
    // Timers run even when the tab is backgrounded (unlike rAF), and catch
    // async content growth (HTML bodies, images) that lands after the frames.
    for (const delay of [60, 250, 700]) setTimeout(apply, delay);
  }

  function scheduleMessagesAutoScroll() {
    pinMessagesToBottom();
  }

  const $messages = document.getElementById('messages');
  const $emptyState = document.getElementById('empty-state');
  const $emptyPrimary = document.getElementById('empty-state-primary');
  const $emptyHint = document.getElementById('empty-state-hint');
  const $connDot = document.getElementById('connection-dot');
  const $connText = document.getElementById('connection-text');
  const $statusIcon = document.getElementById('agent-status-icon');
  const $statusText = document.getElementById('agent-status-text');
  const $headerRight = document.querySelector('#header .header-right');
  const $approvalBar = document.getElementById('approval-bar');
  const $approvalDesc = document.getElementById('approval-desc');
  const $btnApprove = document.getElementById('btn-approve');
  const $btnReject = document.getElementById('btn-reject');
  var questionnaireSelections = {};
  // Signature of the questionnaire DOM we last rendered. Used to skip a full
  // rebuild on every state:patch, which would otherwise destroy the inline
  // freeform ("Other") answer box the user is typing into (it lives inside the
  // option list that renderQuestionnaire() blanks out).
  var questionnaireRenderKey = '';
  // Freeform ("Other") drafts, keyed by question number. Selecting "Other" makes
  // Cursor remount its tray, so a poll can briefly report no questionnaire and
  // force a full rebuild that would wipe the inline textarea — persisting the
  // draft here lets us restore the box (with its text and focus) after any
  // re-render. `...Selector` remembers the row path; `...Active` marks which
  // question currently has its answer box open.
  var questionnaireFreeformDrafts = {};
  var questionnaireFreeformSelector = {};
  var questionnaireFreeformActive = {};
  const $questionnaireBar = document.getElementById('questionnaire-bar');
  const $questionnaireStepper = document.getElementById('questionnaire-stepper');
  const $questionnaireQuestions = document.getElementById('questionnaire-questions');
  const $btnQSkip = document.getElementById('btn-q-skip');
  const $btnQContinue = document.getElementById('btn-q-continue');
  const $input = document.getElementById('message-input');
  const $btnSend = document.getElementById('btn-send');
  const $btnAbort = document.getElementById('btn-abort');
  const $btnSlash = document.getElementById('btn-slash');
  const $toastContainer = document.getElementById('toast-container');

  const $windowBar = document.getElementById('window-bar');
  const $windowList = document.getElementById('window-list');
  const $tabBar = document.getElementById('tab-bar');
  const $tabList = document.getElementById('tab-list');
  const $btnNewChat = document.getElementById('btn-new-chat');
  const $pillMode = document.getElementById('pill-mode');
  const $pillModeIcon = document.getElementById('pill-mode-icon');
  const $pillModeText = document.getElementById('pill-mode-text');
  const $pillModel = document.getElementById('pill-model');
  const $pillModelText = document.getElementById('pill-model-text');
  const $sheetOverlay = document.getElementById('sheet-overlay');
  const $sheetMode = document.getElementById('sheet-mode');
  const $sheetModeList = document.getElementById('sheet-mode-list');
  const $sheetModel = document.getElementById('sheet-model');
  const $sheetModelList = document.getElementById('sheet-model-list');
  const $sheetPlanModel = document.getElementById('sheet-plan-model');
  const $sheetPlanModelHeader = document.getElementById('sheet-plan-model-header');
  const $sheetPlanModelList = document.getElementById('sheet-plan-model-list');
  const $sheetSlash = document.getElementById('sheet-slash');
  const $sheetSlashSearch = document.getElementById('slash-search');
  const $sheetSlashList = document.getElementById('sheet-slash-list');
  const $sheetFolders = document.getElementById('sheet-folders');
  const $sheetFoldersList = document.getElementById('sheet-folders-list');
  const $btnFolders = document.getElementById('btn-folders');
  const $foldersCount = document.getElementById('folders-count');
  const $btnNotify = document.getElementById('btn-notify');
  const $notifyIcon = document.getElementById('notify-icon');
  const $btnRefresh = document.getElementById('btn-refresh');
  const $finishedOverlay = document.getElementById('finished-overlay');
  const $finishedWhat = document.getElementById('finished-what');
  const $finishedWhere = document.getElementById('finished-where');
  const $finishedSnippet = document.getElementById('finished-snippet');
  const $questionOverlay = document.getElementById('question-overlay');
  const $questionOverlayPreview = document.getElementById('question-overlay-preview');
  const $btnOpenQuestions = document.getElementById('btn-open-questions');
  const $sheetNotify = document.getElementById('sheet-notify');
  const $notifyStatus = document.getElementById('notify-status');
  const $btnNotifyToggle = document.getElementById('btn-notify-toggle');
  const $notifyHint = document.getElementById('notify-hint');
  const $planModalOverlay = document.getElementById('plan-modal-overlay');
  const $planModalLabel = document.getElementById('plan-modal-label');
  const $planModalTitle = document.getElementById('plan-modal-title');
  const $planModalBody = document.getElementById('plan-modal-body');
  const $planModalClose = document.getElementById('plan-modal-close');

  const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    withCredentials: true,
    // Latency: skip the long-polling handshake phase. Over the Cloudflare
    // tunnel each polling round trip costs ~100-300ms, so starting on polling
    // and upgrading later made every command feel sluggish right after a
    // reconnect. The tunnel advertises websocket upgrades, so connect
    // WebSocket-first and fall back to polling only when WS is blocked.
    transports: ['websocket'],
    upgrade: false,
    auth: (cb) => {
      try {
        cb({ token: getAuthToken() || '' });
      } catch {
        cb({ token: '' });
      }
    },
  });

  function sendCommandAwaitResult(eventName, payload) {
    return new Promise((resolve) => {
      const commandId = payload.commandId;
      const timer = setTimeout(() => {
        pendingCommandResults.delete(commandId);
        resolve({ commandId, ok: false, error: 'Command timed out' });
      }, 12000);

      pendingCommandResults.set(commandId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      socket.emit(eventName, payload);
    });
  }

  let loggingOutForAuth = false;

  /**
   * Sign out ONLY when the server explicitly rejects our credentials.
   *
   * The old code also logged out after 5 cumulative connect errors and never
   * reset the counter on a successful reconnect. On a flaky phone connection
   * (weak cell signal, Cloudflare-tunnel reconnects) ordinary socket handshake
   * failures — "timeout", "websocket error", "xhr poll error" — are routine, so
   * five blips across a whole day silently signed the user out and killed
   * notifications until they logged back in. Network errors are now retried by
   * socket.io's reconnect loop instead.
   *
   * Even an explicit "Unauthorized" is confirmed against /health before wiping
   * the token, so a single transient rejection during a server restart cannot
   * throw away a perfectly valid session.
   */
  async function handlePossibleAuthFailure() {
    if (loggingOutForAuth) return;
    loggingOutForAuth = true;
    try {
      const res = await fetch('/health', {
        credentials: 'same-origin',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        // Server unreachable/erroring — treat as transient, keep the session.
        loggingOutForAuth = false;
        return;
      }
      const data = await res.json();
      if (data.authRequired && data.sessionValid === false) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        window.location.href = '/login';
        return;
      }
    } catch {
      // Network error — transient. Keep the session and let socket.io retry.
    }
    loggingOutForAuth = false;
  }

  socket.on('connect', () => {
    // Fresh connection: allow auto-open to run again.
    loggingOutForAuth = false;
    autoOpenDone = false;
    autoOpenAttempts = 0;
    autoOpenPending = false;
    if (autoOpenTimer) { clearTimeout(autoOpenTimer); autoOpenTimer = null; }
    renderAll();
  });
  socket.on('disconnect', () => renderAll());

  socket.on('connect_error', (err) => {
    // A genuine rejection of our credentials. Anything else is a transport
    // problem and must never sign the user out.
    if (err && err.message === 'Unauthorized') {
      void handlePossibleAuthFailure();
    }
    renderAll();
  });

  socket.on('state:full', (newState) => {
    state = { ...defaultState, ...newState };
    homeQuestionnaire = newState.questionnaire || null;
    noteActiveComposerChange(state.activeComposerId);
    recomputeQuestionnaire();
    renderAll();
  });

  socket.on('state:patch', (patch) => {
    // Incremental transcript updates: merge before Object.assign so a full
    // `messages` replace (legacy / chat switch) still wins when present.
    if (patch && patch.messageDelta && !patch.messages) {
      state.messages = applyMessageDelta(state.messages || [], patch.messageDelta);
    }
    const { messageDelta: _ignoredDelta, ...rest } = patch || {};
    Object.assign(state, rest);
    if ('questionnaire' in patch) homeQuestionnaire = patch.questionnaire || null;
    if ('activeComposerId' in patch) noteActiveComposerChange(patch.activeComposerId);
    recomputeQuestionnaire();
    renderAll();
  });

  // Full transcript for a composer (from Cursor's database). Merge it ahead of
  // the live DOM tail so the whole chat renders, regardless of Cursor's
  // transcript virtualization.
  socket.on('history:full', (payload) => {
    if (!payload || !Array.isArray(payload.messages)) return;
    const targetId = payload.composerId || '';
    const suppress = suppressTranscriptUntil;
    // Mid-create: reject every payload until we have pinned the new agent, or a
    // late read of the PREVIOUS composer would be adopted as current.
    if (suppress === '__pending__') return;
    // Mid-switch to a specific agent: only that agent's history is safe to show.
    if (suppress && targetId !== suppress) return;
    if (targetId && pendingHistoryComposerId && targetId !== pendingHistoryComposerId) return;
    // Not switching: drop a transcript for a composer that is not the one on
    // screen (and not the one we are waiting on) — the relay loads history
    // asynchronously, so a payload for the previous composer can land late.
    if (!suppress && targetId
      && targetId !== state.activeComposerId
      && targetId !== pinnedComposerId
      && targetId !== pendingHistoryComposerId) return;

    const oldestIndex = typeof payload.oldestIndex === 'number' ? payload.oldestIndex : 0;
    const hasMore = !!payload.hasMore;
    historyPageInFlight = false;

    // Older page for the same composer: prepend (server pages are oldest-first
    // within each page; an older page's messages sit before the ones we have).
    if (fullHistory.composerId && fullHistory.composerId === targetId
      && fullHistory.messages.length > 0
      && oldestIndex < fullHistory.oldestIndex) {
      const seen = new Set(fullHistory.messages.map((m) => m && m.id).filter(Boolean));
      const older = payload.messages.filter((m) => m && m.id && !seen.has(m.id));
      fullHistory = {
        composerId: targetId,
        messages: older.concat(fullHistory.messages),
        oldestIndex,
        hasMore,
      };
      renderAll();
      maybeRequestOlderHistory();
      return;
    }

    // Newest page (or first load): replace.
    fullHistory = {
      composerId: targetId,
      messages: payload.messages,
      oldestIndex,
      hasMore,
    };
    pendingHistoryComposerId = '';
    // A freshly loaded transcript is (re)rendered from scratch — land on the
    // newest message rather than wherever the previous chat was scrolled.
    resetScrollForNewTranscript();
    renderAll();
    maybeRequestOlderHistory();
  });

  // Per-window snapshots from the relay's window monitor. A question raised in
  // a window that is NOT the relay's CDP home window would otherwise never
  // reach the phone (state:patch only ever carries the home window). Surface
  // the questionnaire/approval here and remember which window it belongs to so
  // the answer can be routed back to it.
  socket.on('window:snapshot', (snapshot) => {
    if (!snapshot || !snapshot.windowId) return;
    // Track what each non-home window's open agent is doing so the folder menu
    // can show a status glyph: a spinner while it is working, a "?" while it is
    // blocked on a question, and a "!" while it waits on an approval. The
    // snapshot carries the ground-truth `canAbort` flag plus the questionnaire /
    // approval widgets. One entry per window (keyed by window) so a window that
    // stops reporting (closed) can be pruned instead of leaving a ghost glyph.
    const canAbort = !!snapshot.canAbort;
    const live = !!snapshot.agentActivityLive;
    const statusWorking = snapshot.agentStatus && snapshot.agentStatus !== 'idle'
      && snapshot.agentStatus !== 'waiting_approval'
      && snapshot.agentStatus !== 'error';
    const hasQ = !!(snapshot.questionnaire && snapshot.questionnaire.questions
      && snapshot.questionnaire.questions.length > 0);
    const hasA = !!(snapshot.pendingApprovals && snapshot.pendingApprovals.length > 0);
    if (snapshot.activeComposerId && (canAbort || live || statusWorking || hasQ || hasA)) {
      snapshotWorkingComposers.set(snapshot.windowId, {
        composerId: snapshot.activeComposerId,
        working: canAbort || live || statusWorking,
        question: hasQ,
        approval: hasA,
        at: Date.now(),
      });
    } else {
      snapshotWorkingComposers.delete(snapshot.windowId);
    }
    // The home window's questionnaire already arrives via state:full/patch;
    // only track non-home windows here so the two paths don't fight/duplicate.
    // (The working-composer bookkeeping above still runs for the home window so
    // a window flipping to idle clears its entry.)
    if (snapshot.windowId === state.activeWindowId) return;
    const q = snapshot.questionnaire;
    if (q && q.questions && q.questions.length > 0) {
      remoteQuestionnaires.set(snapshot.windowId, q);
    } else {
      remoteQuestionnaires.delete(snapshot.windowId);
    }
    recomputeQuestionnaire();
    renderAll();
  });

  socket.on('connection:status', (data) => {
    state.connected = data.connected;
    renderAll();
  });

  socket.on('command:result', (result) => {
    const pending = pendingCommandResults.get(result.commandId);
    if (pending) {
      pendingCommandResults.delete(result.commandId);
      pending(result);
      return;
    }
    if (!result.ok) showToast(result.error || 'Command failed', 'error');
  });

  // Only treat a scroll as "the user scrolled away" when they are actually not
  // near the bottom. Programmatic auto-scrolls also emit scroll events, so we
  // must NOT bump the job counter here — doing so cancelled our own async
  // re-pins and stranded the view part-way up a freshly grown transcript.
  $messages.addEventListener('scroll', () => {
    userScrolledUp = !isNearMessagesBottom();
  });

  // Returning to the tab: rAF was suspended while hidden, so re-pin to the
  // bottom if the user hadn't deliberately scrolled away.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !userScrolledUp) pinMessagesToBottom();
  });
  window.addEventListener('focus', () => {
    if (!userScrolledUp) pinMessagesToBottom();
  });

  $input.addEventListener('input', () => {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
    $btnSend.disabled = !$input.value.trim();
  });

  // Send-on-Enter behaves differently per primary input device:
  //   - Touch (mobile): Enter = newline (textarea default), tap Send to send.
  //     Mobile keyboards have no Shift+Enter so without this you can't write
  //     multi-line messages — reported as public#5.
  //   - Mouse/keyboard (desktop): Enter = send (preserved existing behavior),
  //     Shift+Enter = newline.
  // Cmd/Ctrl+Enter always sends, both platforms — for hardware keyboards
  // attached to phones/tablets and as a familiar shortcut on desktop.
  const isTouchPrimary = () => window.matchMedia('(pointer: coarse)').matches;
  $input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    if (e.shiftKey) return; // textarea default → newline
    if (isTouchPrimary()) return; // mobile: newline, send button only
    e.preventDefault();
    sendMessage();
  });

  $btnSend.addEventListener('click', sendMessage);

  $btnAbort.addEventListener('click', () => {
    socket.emit('command:stop_generation', { commandId: newCommandId(), type: 'stop_generation' });
    showToast('Stopping…', 'success');
  });

  $btnSlash.addEventListener('click', () => { void openSlashMenu(); });

  $sheetSlashSearch.addEventListener('input', () => {
    slashSearchQuery = $sheetSlashSearch.value;
    if (slashSearchTimer) clearTimeout(slashSearchTimer);
    // Debounce hard: each keystroke would otherwise drive a full CDP round-trip
    // (clear composer, type, wait for Cursor's filter).
    slashSearchTimer = setTimeout(() => {
      slashSearchTimer = null;
      if (activeSheet === 'slash') void refreshSlashSheet();
    }, SLASH_SEARCH_DEBOUNCE_MS);
  });

  $btnApprove.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
    if (!action) return;
    socket.emit('command:approve', {
      commandId: newCommandId(),
      approvalId: approval.id,
      selectorPath: action.selectorPath,
    });
    showToast('Approve sent', 'success');
  });

  $btnReject.addEventListener('click', () => {
    const approval = state.pendingApprovals[0];
    if (!approval) return;
    const action = approval.actions.find(a => a.type === 'reject');
    socket.emit('command:reject', {
      commandId: newCommandId(),
      approvalId: approval.id,
      // Omit selectorPath when Cursor exposed no explicit reject control; the
      // server falls back to a Skip/Reject/Cancel search and finally Escape.
      ...(action ? { selectorPath: action.selectorPath } : {}),
    });
    showToast('Reject sent', 'success');
  });

  $btnQSkip.addEventListener('click', () => {
    if (!state.questionnaire) return;
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath: state.questionnaire.skipSelectorPath,
      actionLabel: 'Skip',
      ...(questionnaireWindowId ? { windowId: questionnaireWindowId } : {}),
    });
    showToast('Skip sent', 'success');
  });

  $btnQContinue.addEventListener('click', () => {
    if (!state.questionnaire || state.questionnaire.continueDisabled) return;
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath: state.questionnaire.continueSelectorPath,
      actionLabel: 'Continue',
      ...(questionnaireWindowId ? { windowId: questionnaireWindowId } : {}),
    });
    showToast('Continue sent', 'success');
  });

  $btnNewChat.addEventListener('click', () => {
    socket.emit('command:new_chat', { commandId: newCommandId() });
    showToast('Creating new chat...', 'success');
  });

  $pillMode.addEventListener('click', () => openSheet('mode'));
  $pillModel.addEventListener('click', () => openSheet('model'));
  $btnFolders.addEventListener('click', () => openSheet('folders'));
  $sheetOverlay.addEventListener('click', closeSheet);
  if ($btnRefresh) {
    $btnRefresh.addEventListener('click', () => { void requestStateRefresh(); });
  }
  if ($finishedOverlay) {
    $finishedOverlay.addEventListener('click', hideFinishedBanner);
  }
  // Tapping anywhere on the question alert dismisses it; the "Open questions"
  // button dismisses it and scrolls the answer card into view instead.
  if ($questionOverlay) {
    $questionOverlay.addEventListener('click', () => hideQuestionAlert());
  }
  if ($btnOpenQuestions) {
    $btnOpenQuestions.addEventListener('click', (e) => {
      e.stopPropagation();
      hideQuestionAlert();
      openQuestionCard();
    });
  }
  $planModalClose.addEventListener('click', closePlanModal);
  $planModalOverlay.addEventListener('click', (e) => {
    if (e.target === $planModalOverlay) closePlanModal();
  });

  function sendMessage() {
    const text = $input.value.trim();
    if (!text) return;
    // If a slash command pre-filled the host composer, submit in place instead
    // of retyping (which would clobber the command's effect).
    if (composerPrefilledText) {
      socket.emit('command:send_prompt', {
        commandId: newCommandId(),
        type: 'send_prompt',
        text,
      });
    } else {
      socket.emit('command:send_message', { commandId: newCommandId(), text });
    }
    composerPrefilledText = '';
    $input.value = '';
    $input.style.height = 'auto';
    $btnSend.disabled = true;
    showToast('Message sent', 'success');
  }

  function renderAll() {
    renderConnectionStatus();
    renderAgentStatus();
    renderComposerQueue();
    renderWindows();
    renderMessages();
    renderApprovals();
    renderQuestionnaire();
    renderInputState();
    renderTabs();
    renderFoldersButton();
    renderModeModel();
    renderStallNudge();
    syncPlanModalFromState();
    maybeRequestHistory();
    maybeNotifyTransitions();
    maybeAutoOpenChat();
  }

  /**
   * Ask the relay to re-read Cursor right now. Used when the phone's view may
   * be out of sync — the "Refresh" header button and the stall nudge — e.g. the
   * remote still shows the agent working while Cursor has already finished.
   * The relay replies with a `state:full`, so no local state is guessed here.
   */
  async function requestStateRefresh() {
    if (!socket.connected) {
      showToast('Not connected to relay', 'error');
      return;
    }
    setRefreshBusy(true);
    const result = await sendCommandAwaitResult('command:refresh_state', {
      commandId: newCommandId(),
      type: 'refresh_state',
    });
    setRefreshBusy(false);
    if (!result.ok) {
      showToast(result.error || 'Refresh failed', 'error');
      return;
    }
    // The refresh clears the server-side stall flag; mirror that immediately so
    // the nudge disappears even before the state:full lands.
    hideStallNudge();
    showToast('Refreshed', 'success');
  }

  function setRefreshBusy(busy) {
    if ($btnRefresh) $btnRefresh.classList.toggle('refreshing', !!busy);
  }

  function hideStallNudge() {
    if ($btnRefresh) {
      $btnRefresh.classList.remove('stalled');
      $btnRefresh.classList.add('hidden');
    }
  }

  /**
   * Surface the "no updates" state as a compact indicator: the small header
   * refresh button swaps its glyph for a spinner while the server reports the
   * extracted state has frozen (agentStalled) and still claims the agent is
   * working. This is the "Cursor actually finished but the phone doesn't know"
   * case. The previous full-width banner was too large and covered the
   * transcript, so all its meaning now lives in this one tappable button —
   * which re-reads Cursor on tap. It is hidden for an idle session (no nagging).
   */
  function renderStallNudge() {
    if (!$btnRefresh) return;
    const stalled = !!state.agentStalled && isAgentWorking();
    // Offer a manual refresh whenever something looks off: the stall flag is
    // set, or the extractor itself is failing/behind.
    const extractorUnhealthy = state.connected && state.extractorStatus !== 'ok';
    const show = stalled || extractorUnhealthy;

    $btnRefresh.classList.toggle('hidden', !show);
    $btnRefresh.classList.toggle('stalled', stalled);

    const label = (state.agentActivityText || '').trim();
    const title = stalled
      ? (label
        ? 'Still "' + label + '"? Cursor may have finished — tap to refresh.'
        : 'No updates from Cursor. It may have finished — tap to refresh.')
      : 'Refresh state';
    $btnRefresh.title = title;
    $btnRefresh.setAttribute('aria-label', title);
  }

  /**
   * Ensure the full transcript for the currently-open composer is loaded. We
   * key off `state.activeComposerId` (now included in state patches) and ask the
   * server once per composer; the `history:full` response is merged into the
   * rendered transcript by renderMessages().
   */
  function maybeRequestHistory() {
    const activeId = state.activeComposerId || '';

    // A user selection is pending: wait for the server's active composer to
    // catch up to it, then release the pin. Until then, ignore the stale
    // activeComposerId so it can't override the chosen chat.
    if (pinnedComposerId) {
      if (activeId === pinnedComposerId) {
        pinnedComposerId = '';
        if (fullHistory.composerId === activeId) return;
        if (pendingHistoryComposerId === activeId) return;
        if (lastRequestedHistoryComposerId === activeId) return;
        requestHistory(activeId);
      }
      return;
    }

    const composerId = activeId;
    if (!composerId) return;
    if (fullHistory.composerId === composerId) return;
    if (pendingHistoryComposerId === composerId) return;
    if (lastRequestedHistoryComposerId === composerId) return;
    requestHistory(composerId);
  }

  function requestHistory(composerId) {
    if (!composerId) return;
    if (fullHistory.composerId === composerId) return; // already loaded
    // Clear any previous composer's transcript so we never show the wrong chat
    // while the new one loads.
    fullHistory = { composerId: '', messages: [], oldestIndex: 0, hasMore: false };
    pendingHistoryComposerId = composerId;
    lastRequestedHistoryComposerId = composerId;
    historyPageInFlight = true;
    // Newest page first — older pages follow via maybeRequestOlderHistory().
    socket.emit('request:history', { composerId, limit: HISTORY_PAGE_LIMIT });
  }

  /** Background-fetch older history pages until the server reports hasMore=false. */
  function maybeRequestOlderHistory() {
    if (historyPageInFlight) return;
    if (!fullHistory.composerId || !fullHistory.hasMore) return;
    if (typeof fullHistory.oldestIndex !== 'number' || fullHistory.oldestIndex <= 0) return;
    historyPageInFlight = true;
    socket.emit('request:history', {
      composerId: fullHistory.composerId,
      limit: HISTORY_PAGE_LIMIT,
      beforeIndex: fullHistory.oldestIndex,
    });
  }

  /**
   * Switching chats should always land at the newest message. `userScrolledUp`
   * is global and would otherwise persist from the previous chat (or from a
   * deliberate scroll-up) and leave the fresh transcript pinned at its top.
   */
  // Remember which composer the transcript belongs to so a host-side switch
  // (or the pinned-selection catching up on the server) also lands at the
  // bottom instead of wherever the previous chat was scrolled.
  let lastActiveComposerId = '';

  function resetScrollForNewTranscript() {
    userScrolledUp = false;
    autoScrollJob++;
    lastActiveComposerId = state.activeComposerId || '';
    pinMessagesToBottom();
  }

  function noteActiveComposerChange(composerId) {
    const next = composerId || '';
    // Once the server's active composer reaches the one we are adopting, the
    // fresh transcript is safe to render again.
    if (suppressTranscriptUntil && suppressTranscriptUntil !== '__pending__'
      && next === suppressTranscriptUntil) {
      suppressTranscriptUntil = '';
    }
    if (!lastActiveComposerId) { lastActiveComposerId = next; return; }
    if (next !== lastActiveComposerId) {
      lastActiveComposerId = next;
      // A different chat is now open; drop the previous chat's scroll state so
      // the new transcript renders at the newest message.
      userScrolledUp = false;
    }
  }

  /**
   * Explicitly select a composer (folder agent / tab tap). Loads its transcript
   * immediately and PINS it so the automatic "follow Cursor's active composer"
   * logic can't immediately switch back to the previously-open chat while the
   * server's DOM catches up.
   */
  function selectComposer(composerId) {
    if (!composerId) return;
    resetScrollForNewTranscript();
    pinnedComposerId = composerId;
    // Hide the previous chat's live tail until the server's active composer
    // catches up to this selection, so the switch never shows the old folder's
    // messages under the new chat's name.
    suppressTranscriptUntil = composerId;
    if (pinnedComposerTimer) clearTimeout(pinnedComposerTimer);
    pinnedComposerTimer = setTimeout(() => {
      pinnedComposerTimer = null;
      pinnedComposerId = '';
      // Never report the "waiting for the switch" state as current.
      if (suppressTranscriptUntil === composerId) suppressTranscriptUntil = '';
      // Consume whatever the server still reports as active so the next render
      // doesn't immediately re-request the previous (stale) chat and yank the
      // user back. A genuine later change still triggers a fresh load.
      lastRequestedHistoryComposerId = state.activeComposerId || '';
    }, PINNED_COMPOSER_TIMEOUT_MS);
    // Bypass the "already loaded" guard: the user may re-pick the same chat.
    fullHistory = { composerId: '', messages: [], oldestIndex: 0, hasMore: false };
    pendingHistoryComposerId = composerId;
    lastRequestedHistoryComposerId = composerId;
    historyPageInFlight = true;
    socket.emit('request:history', { composerId, limit: HISTORY_PAGE_LIMIT });
    // Render immediately so the previous chat's messages disappear at once,
    // instead of lingering until the next state patch arrives.
    renderAll();
  }

  /**
   * Apply a server messageDelta to the local live transcript. Mirrors
   * `applyMessageDelta` in src/server/message-delta.ts — keep them in sync.
   * When `order` is omitted the update is append-only (streaming path).
   */
  function applyMessageDelta(messages, delta) {
    if (!delta) return messages || [];
    const remove = new Set(delta.removeIds || []);
    let msgs = remove.size > 0
      ? (messages || []).filter((m) => m && !remove.has(m.id))
      : (messages || []).slice();

    const byId = new Map();
    for (const m of msgs) if (m && m.id) byId.set(m.id, m);
    for (const m of (delta.upsert || [])) if (m && m.id) byId.set(m.id, m);

    if (delta.order && delta.order.length > 0) {
      const ordered = [];
      const seen = new Set();
      for (const id of delta.order) {
        const m = byId.get(id);
        if (m) { ordered.push(m); seen.add(id); }
      }
      for (const m of (delta.upsert || [])) {
        if (m && m.id && !seen.has(m.id)) ordered.push(m);
      }
      return ordered;
    }

    msgs = msgs.slice();
    for (const m of (delta.upsert || [])) {
      if (!m || !m.id) continue;
      const idx = msgs.findIndex((x) => x && x.id === m.id);
      if (idx >= 0) msgs[idx] = m;
      else msgs.push(m);
    }
    return msgs;
  }

  /**
   * Merge the full-history transcript with the live DOM tail. History is
   * authoritative and ordered; the DOM only ever contributes the newest few
   * messages (nearest its scroll position). We rebuild the tail from live
   * messages whose ids appear in history (so streaming updates stay live), then
   * append any remaining live messages that history doesn't yet contain (e.g.
   * the message currently being generated).
   */
  function mergeHistoryWithLive(historyMsgs, liveMsgs) {
    if (!historyMsgs || historyMsgs.length === 0) return liveMsgs || [];
    if (!liveMsgs || liveMsgs.length === 0) return historyMsgs;

    const liveById = new Map();
    for (const m of liveMsgs) if (m && m.id) liveById.set(m.id, m);

    const historyIds = new Set();
    for (const m of historyMsgs) if (m && m.id) historyIds.add(m.id);

    // Live wins for streaming content, but when the relay strips HTML from
    // non-tail assistants (lean live payloads), keep history's rendered HTML.
    const merged = historyMsgs.map((h) => {
      if (!h || !h.id || !liveById.has(h.id)) return h;
      const live = liveById.get(h.id);
      if (live.type === 'assistant' && h.type === 'assistant' && !live.html && h.html) {
        return { ...live, html: h.html };
      }
      return live;
    });

    const extra = [];
    for (const m of liveMsgs) {
      if (m && m.id && !historyIds.has(m.id)) extra.push(m);
    }
    return extra.length > 0 ? merged.concat(extra) : merged;
  }

  /**
   * Open the chat the relay is already showing (or the most recent agent chat)
   * automatically so the transcript loads without a manual tap. Only runs when
   * logged in with an empty transcript and no chat actually open — i.e. Cursor
   * sitting on the "Cursor Agents" overview, where nothing is mounted yet.
   */
  function maybeAutoOpenChat() {
    if (autoOpenDone || autoOpenPending) return;
    const loggedIn = !!getAuthToken();
    if (!loggedIn) return;
    if (state.messages.length > 0) { autoOpenDone = true; return; }
    if (!state.connected) return;

    const target = pickAutoOpenAgent();
    if (!target) return;

    if (autoOpenAttempts >= AUTO_OPEN_TRIES) { autoOpenDone = true; return; }
    autoOpenAttempts += 1;
    autoOpenPending = true;
    socket.emit('command:open_folder_agent', {
      commandId: newCommandId(),
      type: 'open_folder_agent',
      composerId: target.composerId,
      tabTitle: target.title,
      selectorPath: target.selectorPath,
    });
    // Pin the target too: without it, the stale activeComposerId would request
    // the previous chat and override the auto-opened one.
    selectComposer(target.composerId);

    if (autoOpenTimer) clearTimeout(autoOpenTimer);
    autoOpenTimer = setTimeout(() => {
      autoOpenTimer = null;
      autoOpenPending = false;
      if (state.messages.length === 0) maybeAutoOpenChat();
    }, 2500);
  }

  /**
   * Prefer the relay's currently-open composer (it resolves to a real agent row
   * even when no chat is mounted); otherwise fall back to the last agent with a
   * real composer id — Cursor lists agents in recency order.
   */
  function pickAutoOpenAgent() {
    const folders = state.folders || [];
    const withIds = folders.flatMap(f => (f.agents || [])
      .filter(a => a && typeof a.composerId === 'string' && a.composerId.length > 0));

    const activeId = (state.activeComposerId || '').trim();
    if (activeId) {
      const match = withIds.find(a => a.composerId === activeId);
      if (match) return match;
      // Not listed in the sidebar (e.g. an open chat) — still safe to open it.
      return { composerId: activeId, title: '', selectorPath: '' };
    }

    const activeRow = withIds.find(a => a.isActive);
    if (activeRow) return activeRow;
    return withIds.length > 0 ? withIds[withIds.length - 1] : null;
  }

  function renderConnectionStatus() {
    const ui = getConnectionUiState();
    updateConnectionUI(ui.status, ui.label);
  }

  function updateConnectionUI(status, label) {
    $connDot.className = 'dot ' + status;
    const labels = { connected: 'Connected', disconnected: 'Disconnected', reconnecting: 'Connecting...' };
    $connText.textContent = label || labels[status] || status;
  }

  function getConnectionUiState() {
    const lastError = (state.lastExtractionError || '').trim();
    const timeoutLike = /timeout/i.test(lastError);

    if (!socket.connected) {
      return {
        status: 'disconnected',
        label: 'Relay disconnected',
        emptyPrimary: 'Waiting for relay connection...',
        emptyHint: 'Check that this page can reach the CursorRemote server.',
      };
    }

    if (!state.connected) {
      return {
        status: 'reconnecting',
        label: 'Waiting for Cursor',
        emptyPrimary: 'Connecting to Cursor IDE...',
        emptyHint: 'Make sure Cursor is running with<br><code>--remote-debugging-port=9222</code>',
      };
    }

    if (state.extractorStatus === 'stale') {
      return {
        status: 'reconnecting',
        label: timeoutLike ? 'Cursor backgrounded' : 'Cursor stalled',
        emptyPrimary: timeoutLike
          ? 'Cursor is connected but background-throttled.'
          : 'Cursor is connected but extraction is failing.',
        emptyHint: timeoutLike
          ? 'Bring Cursor to the foreground on macOS, then wait for the next snapshot.'
          : ('Last extractor error:<br><code>' + escapeHtml(lastError || 'unknown error') + '</code>'),
      };
    }

    if (state.extractorStatus === 'waiting') {
      return {
        status: 'reconnecting',
        label: 'Waiting for snapshot',
        emptyPrimary: 'Connected to Cursor, waiting for the first snapshot...',
        emptyHint: lastError
          ? ('Last extractor error:<br><code>' + escapeHtml(lastError) + '</code>')
          : 'The relay is connected to Cursor but has not captured a fresh DOM snapshot yet.',
      };
    }

    return {
      status: 'connected',
      label: 'Connected',
      emptyPrimary: 'Opening the current chat…',
      emptyHint: 'This chat has no messages yet. Send one below, or open another chat from the Folders button.',
    };
  }

  function renderAgentStatus() {
    const icons = {
      idle: '',
      thinking: '',
      generating: '',
      running_tool: '',
      waiting_approval: '!',
      error: '\u2715',
    };
    const labels = {
      idle: 'Idle', thinking: 'Thinking...', generating: 'Generating...',
      running_tool: 'Running tool...', waiting_approval: 'Needs approval', error: 'Error',
    };
    $statusIcon.textContent = icons[state.agentStatus] || '';
    const activity = (state.agentActivityText || '').trim();
    const activityLive = !!state.agentActivityLive;
    // When the ground-truth working flag is set but status momentarily reads
    // idle/error (transient poll gap), present it as working so the header
    // matches the abort control the user can see. Genuine `waiting_approval`
    // is left untouched so a real approval still reads as "Needs approval".
    const effectiveStatus = (state.canAbort
      && (state.agentStatus === 'idle' || state.agentStatus === 'error'))
      ? 'running_tool'
      : state.agentStatus;
    const baseLabel = labels[effectiveStatus] || state.agentStatus;
    if ($headerRight) {
      if (state.agentStatus !== 'idle' || state.canAbort) $headerRight.classList.remove('header-right-hidden');
      else $headerRight.classList.add('header-right-hidden');
    }
    if (activityLive && activity && state.agentStatus !== 'idle') {
      const max = 56;
      $statusText.textContent = activity.length > max ? activity.slice(0, max - 1) + '…' : activity;
      $statusText.classList.add('agent-status-shimmer');
    } else {
      $statusText.textContent = baseLabel;
      $statusText.classList.remove('agent-status-shimmer');
    }

    if (state.agentStatus === 'waiting_approval') $statusText.style.color = 'var(--accent-yellow)';
    else if (state.agentStatus === 'error') $statusText.style.color = 'var(--accent-red)';
    else $statusText.style.color = '';
  }

  function renderComposerQueue() {
    const bar = document.getElementById('composer-queue-bar');
    const labelEl = document.getElementById('composer-queue-label');
    const itemsEl = document.getElementById('composer-queue-items');
    if (!bar || !labelEl || !itemsEl) return;
    const q = state.composerQueue && Array.isArray(state.composerQueue.items)
      ? state.composerQueue
      : { items: [] };
    if (q.items.length === 0) {
      bar.classList.add('hidden');
      itemsEl.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
    // 'tray' = newer Cursor UI whose row buttons mount only on hover; the
    // server reveals+clicks them by id+action. 'toolbar' = older UI with stable
    // per-row selector paths we can click directly.
    const isTray = q.kind === 'tray';
    itemsEl.innerHTML = '';
    q.items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'composer-queue-row';
      const dot = document.createElement('span');
      dot.className = 'composer-queue-dot';
      const tx = document.createElement('span');
      tx.className = 'composer-queue-text';
      tx.textContent = it.text || '';
      row.appendChild(dot);
      row.appendChild(tx);

      const actions = document.createElement('div');
      actions.className = 'composer-queue-actions';

      const sendVia = (action) => {
        if (isTray) {
          socket.emit('command:queue_action', {
            commandId: newCommandId(),
            type: 'queue_action',
            queueItemId: it.id,
            queueAction: action,
          });
        } else {
          const selectorPath = action === 'send' ? it.sendSelectorPath : it.removeSelectorPath;
          if (!selectorPath) return;
          socket.emit('command:click_action', {
            commandId: newCommandId(),
            type: 'click_action',
            selectorPath,
          });
        }
      };

      const send = document.createElement('button');
      send.className = 'composer-queue-action composer-queue-send';
      send.type = 'button';
      send.textContent = 'Send now';
      send.title = 'Send now';
      send.disabled = !isTray && !it.sendSelectorPath;
      send.addEventListener('click', () => {
        sendVia('send');
        showToast('Sending queued message…', 'success');
      });
      actions.appendChild(send);

      const remove = document.createElement('button');
      remove.className = 'composer-queue-action composer-queue-remove';
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', 'Remove from queue');
      remove.disabled = !isTray && !it.removeSelectorPath;
      remove.addEventListener('click', () => {
        sendVia('remove');
      });
      actions.appendChild(remove);

      row.appendChild(actions);
      itemsEl.appendChild(row);
    });
  }

  // --- Message rendering ---

  function renderMessages() {
    // Full history (when loaded for the open composer) is the source of truth
    // for everything but the newest messages; the live DOM tail is merged in so
    // streaming stays live.
    let msgs = state.messages;
    // Only merge the full-history transcript when it belongs to the composer we
    // actually have open. Otherwise the leftover history of the PREVIOUS chat
    // would keep rendering after a switch (e.g. a folder agent was just created
    // but the relay's active composer hasn't updated yet), which made the new
    // chat look like it still held the old folder's messages. The permissive
    // `!fullHistory.composerId || !state.activeComposerId` fallback was the bug:
    // it treated "active composer unknown" as "history matches anything".
    if (fullHistory.messages.length > 0) {
      const historyMatchesComposer = !!fullHistory.composerId
        && !!state.activeComposerId
        && fullHistory.composerId === state.activeComposerId;
      if (historyMatchesComposer) {
        msgs = mergeHistoryWithLive(fullHistory.messages, state.messages);
      }
    }
    // While adopting a newly-created agent the live DOM tail still describes the
    // OLD composer. Hide it (show the empty state) until the server's active
    // composer matches, so the new chat never flashes the previous folder's
    // messages. `'__pending__'` means "not yet pinned to any target": suppress
    // unconditionally until adoptNewestComposer picks the new agent.
    if (suppressTranscriptUntil) {
      const target = suppressTranscriptUntil;
      const matchesTarget = target !== '__pending__' && state.activeComposerId === target;
      if (!matchesTarget) msgs = [];
    }

    if (msgs.length === 0) {
      const ui = getConnectionUiState();
      $emptyState.style.display = '';
      $messages.querySelectorAll('.chat-el').forEach(el => el.remove());
      $emptyPrimary.textContent = ui.emptyPrimary;
      $emptyHint.innerHTML = ui.emptyHint;
      return;
    }

    $emptyState.style.display = 'none';

    const existingEls = $messages.querySelectorAll('.chat-el');
    const existingIds = new Map();
    existingEls.forEach(el => existingIds.set(el.dataset.id, el));

    const newIds = new Set(msgs.map(m => m.id));

    existingEls.forEach(el => {
      if (!newIds.has(el.dataset.id)) el.remove();
    });

    msgs.forEach((msg, index) => {
      let el = existingIds.get(msg.id);

      if (!el) {
        el = createElement(msg);
        const allEls = $messages.querySelectorAll('.chat-el');
        if (index < allEls.length) {
          $messages.insertBefore(el, allEls[index]);
        } else {
          $messages.appendChild(el);
        }
      } else if (el.dataset.msgType !== msg.type) {
        const replacement = createElement(msg);
        el.replaceWith(replacement);
        el = replacement;
      } else {
        updateElement(el, msg);
      }
    });

    if (!userScrolledUp) scheduleMessagesAutoScroll();
  }

  function createElement(msg) {
    let el;
    switch (msg.type) {
      case 'human': el = createHumanEl(msg); break;
      case 'assistant': el = createAssistantEl(msg); break;
      case 'tool': el = createToolEl(msg); break;
      case 'thought': el = createThoughtEl(msg); break;
      case 'plan': el = createPlanEl(msg); break;
      case 'todo_list': el = createTodoListEl(msg); break;
      case 'run_command': el = createRunCommandEl(msg); break;
      case 'loading': el = createLoadingEl(msg); break;
      default: el = createFallbackEl(msg); break;
    }
    el.dataset.msgType = msg.type;
    return el;
  }

  function updateElement(el, msg) {
    switch (msg.type) {
      case 'human': updateHumanEl(el, msg); break;
      case 'assistant': updateAssistantEl(el, msg); break;
      case 'tool': updateToolEl(el, msg); break;
      case 'thought': updateThoughtEl(el, msg); break;
      case 'plan': updatePlanEl(el, msg); break;
      case 'todo_list': updateTodoListEl(el, msg); break;
      case 'run_command': updateRunCommandEl(el, msg); break;
      case 'loading': break;
    }
  }

  // --- Human message ---

  function createQuotedWidget(text) {
    const wrap = document.createElement('div');
    wrap.className = 'quoted-widget';
    const lab = document.createElement('div');
    lab.className = 'quoted-label';
    lab.textContent = 'Quoted';
    const body = document.createElement('div');
    body.className = 'quoted-text';
    body.textContent = text;
    wrap.appendChild(lab);
    wrap.appendChild(body);
    return wrap;
  }

  function createHumanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-human';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'human-bubble';

    if (msg.quoted && msg.quoted.text) {
      bubble.appendChild(createQuotedWidget(msg.quoted.text));
    }

    if (msg.mentions && msg.mentions.length > 0) {
      const mentionsRow = document.createElement('div');
      mentionsRow.className = 'mentions-row';
      msg.mentions.forEach(m => {
        const badge = document.createElement('span');
        badge.className = 'mention-badge';
        badge.textContent = m.name;
        mentionsRow.appendChild(badge);
      });
      bubble.appendChild(mentionsRow);
    }

    const text = document.createElement('div');
    text.className = 'human-text';
    text.textContent = msg.text;
    bubble.appendChild(text);
    el.appendChild(bubble);
    return el;
  }

  function updateHumanEl(el, msg) {
    const bubble = el.querySelector('.human-bubble');
    let qw = el.querySelector('.quoted-widget');
    if (msg.quoted && msg.quoted.text) {
      if (!qw && bubble) {
        qw = createQuotedWidget(msg.quoted.text);
        bubble.insertBefore(qw, bubble.firstChild);
      } else if (qw) {
        const body = qw.querySelector('.quoted-text');
        if (body) body.textContent = msg.quoted.text;
      }
    } else if (qw) {
      qw.remove();
    }
    const text = el.querySelector('.human-text');
    if (text) text.textContent = msg.text;
  }

  // --- Assistant message ---

  let codeBlockFsOverlay = null;

  function closeCodeBlockFullscreen() {
    if (!codeBlockFsOverlay) return;
    codeBlockFsOverlay.remove();
    codeBlockFsOverlay = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onCodeBlockFsKeydown);
  }

  function onCodeBlockFsKeydown(e) {
    if (e.key === 'Escape') closeCodeBlockFullscreen();
  }

  /** Full-screen overlay for long code/diff (mobile-friendly scroll + safe areas). */
  function openCodeBlockFullscreen(wrapper) {
    closeCodeBlockFullscreen();
    const viewport = wrapper.querySelector('.code-block-viewport');
    const headerEl = wrapper.querySelector('.code-block-header');
    const title = (headerEl && headerEl.textContent.trim()) || 'Code';

    const overlay = document.createElement('div');
    overlay.className = 'code-block-fs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const backdrop = document.createElement('div');
    backdrop.className = 'code-block-fs-backdrop';
    backdrop.addEventListener('click', closeCodeBlockFullscreen);

    const panel = document.createElement('div');
    panel.className = 'code-block-fs-panel';

    const panelHead = document.createElement('div');
    panelHead.className = 'code-block-fs-panel-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'code-block-fs-title';
    titleSpan.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'code-block-fs-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCodeBlockFullscreen();
    });
    panelHead.appendChild(titleSpan);
    panelHead.appendChild(closeBtn);

    const scroll = document.createElement('div');
    scroll.className = 'code-block-fs-scroll';
    if (viewport && viewport.firstElementChild) {
      scroll.appendChild(viewport.firstElementChild.cloneNode(true));
    }

    panel.appendChild(panelHead);
    panel.appendChild(scroll);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    codeBlockFsOverlay = overlay;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onCodeBlockFsKeydown);
    closeBtn.focus();
  }

  /** Native code/diff from server `CodeBlockItem` (no mirrored Monaco HTML). */
  function createNativeBlockFromItem(item, filenameFallback) {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block native-code-block';

    const title = (item.filename || item.language || filenameFallback || '').trim();
    const toolbar = document.createElement('div');
    toolbar.className =
      'code-block-toolbar' + (title ? '' : ' code-block-toolbar--actions-only');
    if (title) {
      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.textContent = title;
      toolbar.appendChild(header);
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'code-block-fullscreen-btn';
    expandBtn.setAttribute('aria-label', 'View full screen');
    expandBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCodeBlockFullscreen(wrapper);
    });
    toolbar.appendChild(expandBtn);
    wrapper.appendChild(toolbar);

    const viewport = document.createElement('div');
    viewport.className = 'code-block-viewport';

    const body = document.createElement('div');
    body.className = 'code-block-diff-plain';
    if (item.blockKind === 'diff' && item.diffLines && item.diffLines.length > 0) {
      for (const line of item.diffLines) {
        const row = document.createElement('div');
        const k = ['add', 'rem', 'ctx', 'meta', 'hunk'].includes(line.kind) ? line.kind : 'ctx';
        row.className = 'code-block-diff-line code-block-diff-line--' + k;
        row.textContent = line.text;
        body.appendChild(row);
      }
    } else {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = item.code || '';
      pre.appendChild(code);
      body.appendChild(pre);
      body.classList.add('code-block-diff-plain--raw');
    }
    viewport.appendChild(body);
    wrapper.appendChild(viewport);
    return wrapper;
  }

  function appendAssistantNativeBlocks(bubble, msg) {
    if (!bubble) return;
    bubble.querySelectorAll(':scope > .native-code-block').forEach((n) => n.remove());
    if (!msg.codeBlocks?.length) return;
    for (const item of msg.codeBlocks) {
      if (!item || (!item.code?.trim() && !(item.diffLines && item.diffLines.length))) continue;
      bubble.appendChild(createNativeBlockFromItem(item));
    }
  }

  function createAssistantEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-assistant';
    el.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';

    if (msg.html) {
      const content = document.createElement('div');
      content.className = 'assistant-content markdown-body';
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      bubble.appendChild(content);
    } else {
      const content = document.createElement('div');
      content.className = 'assistant-content';
      content.textContent = msg.text;
      bubble.appendChild(content);
    }

    appendAssistantNativeBlocks(bubble, msg);

    el.appendChild(bubble);
    return el;
  }

  function updateAssistantEl(el, msg) {
    const bubble = el.querySelector('.assistant-bubble');
    const content = el.querySelector('.assistant-content');
    if (!content) return;
    if (msg.html) {
      content.innerHTML = sanitizeHtml(msg.html);
      normalizeMarkdownCodeBlocks(content);
      content.classList.add('markdown-body');
    } else {
      content.textContent = msg.text;
      content.classList.remove('markdown-body');
    }
    appendAssistantNativeBlocks(bubble, msg);
  }

  // --- Tool call ---

  function createToolEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-tool';
    el.dataset.id = msg.id;

    const line = document.createElement('div');
    line.className = 'tool-line ' + msg.status;

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = msg.status === 'completed' ? '\u2713' : '\u2022';
    line.appendChild(icon);

    if (msg.summaryText) {
      const summary = document.createElement('span');
      summary.className = 'tool-summary';
      summary.textContent = msg.summaryText;
      line.appendChild(summary);
    } else {
      if (msg.action) {
        const action = document.createElement('span');
        action.className = 'tool-action';
        action.textContent = msg.action;
        line.appendChild(action);
      }
      if (msg.details) {
        const details = document.createElement('span');
        details.className = 'tool-details';
        details.textContent = msg.details;
        line.appendChild(details);
      }
    }

    if (msg.filename || msg.additions != null || msg.deletions != null) {
      const fileInfo = document.createElement('span');
      fileInfo.className = 'tool-file-info';

      if (msg.filename) {
        const fn = document.createElement('span');
        fn.className = 'tool-filename';
        fn.textContent = msg.filename;
        fileInfo.appendChild(fn);
      }
      if (msg.additions != null) {
        const add = document.createElement('span');
        add.className = 'tool-additions';
        add.textContent = '+' + msg.additions;
        fileInfo.appendChild(add);
      }
      if (msg.deletions != null) {
        const del = document.createElement('span');
        del.className = 'tool-deletions';
        del.textContent = '-' + msg.deletions;
        fileInfo.appendChild(del);
      }

      line.appendChild(fileInfo);
    }

    el.appendChild(line);

    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'tool-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      el.appendChild(actionsRow);
    }

    syncToolDiffHost(el, msg);
    return el;
  }

  /** Tool edit diff: native block from `diffBlock` (structured lines). */
  function syncToolDiffHost(el, msg) {
    const db = msg.diffBlock;
    const hasBody =
      db &&
      ((db.diffLines && db.diffLines.length > 0) || (db.code && String(db.code).trim().length > 0));
    let host = el.querySelector('.tool-diff-host');

    if (!hasBody) {
      if (host) {
        delete host._nativeDiffKey;
        host.remove();
      }
      return;
    }

    const key = JSON.stringify({
      bk: db.blockKind,
      c: db.code,
      d: db.diffLines,
      f: db.filename || msg.filename,
    });
    if (!host) {
      host = document.createElement('div');
      host.className = 'tool-diff-host';
      el.appendChild(host);
    }
    if (host._nativeDiffKey === key) return;
    host._nativeDiffKey = key;
    host.innerHTML = '';
    host.appendChild(createNativeBlockFromItem(db, msg.filename));
  }

  function updateToolEl(el, msg) {
    const fresh = createToolEl(msg);
    const newLine = fresh.querySelector('.tool-line');
    const oldLine = el.querySelector('.tool-line');
    if (newLine && oldLine) el.replaceChild(newLine, oldLine);

    const newActions = fresh.querySelector('.tool-actions-row');
    const oldActions = el.querySelector('.tool-actions-row');
    if (newActions && oldActions) {
      el.replaceChild(newActions, oldActions);
    } else if (newActions && !oldActions) {
      const diffHost = el.querySelector('.tool-diff-host');
      if (diffHost) el.insertBefore(newActions, diffHost);
      else el.appendChild(newActions);
    } else if (!newActions && oldActions) {
      oldActions.remove();
    }

    syncToolDiffHost(el, msg);
  }

  // --- Thought block ---

  function formatThoughtLine(msg) {
    const dur = (msg.duration || '').trim();
    const detail = (msg.detail || '').trim();
    if (msg.thoughtKind === 'step_summary') {
      const a = (msg.action || '').trim();
      return detail ? `${a || 'Steps'} — ${detail}` : (a || 'Steps');
    }
    if (msg.thoughtKind === 'thinking_step') {
      const a = (msg.action || '').trim();
      if (dur) return `${a || 'Step'} · ${dur}`;
      if (a) {
        if (/^thought$/i.test(a)) return 'Thought';
        if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, '')}…`;
        return a;
      }
      return 'Thinking…';
    }
    if (dur) return `Thought for ${dur}`;
    const action = (msg.action || '').trim();
    if (action) {
      if (/^thought$/i.test(action)) return 'Thought';
      if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
      return action;
    }
    return 'Thinking…';
  }

  function syncThoughtLineClasses(inner, msg) {
    inner.classList.remove('thought-line-summary', 'thought-line-step');
    if (msg.thoughtKind === 'step_summary') inner.classList.add('thought-line-summary');
    else if (msg.thoughtKind === 'thinking_step') inner.classList.add('thought-line-step');
  }

  function createThoughtEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-thought';
    el.dataset.id = msg.id;

    const inner = document.createElement('div');
    inner.className = 'thought-line';
    syncThoughtLineClasses(inner, msg);
    inner.textContent = formatThoughtLine(msg);
    el.appendChild(inner);
    return el;
  }

  function updateThoughtEl(el, msg) {
    const inner = el.querySelector('.thought-line');
    if (inner) {
      syncThoughtLineClasses(inner, msg);
      inner.textContent = formatThoughtLine(msg);
    }
  }

  // --- Plan block ---

  function emitClickAction(selectorPath, actionLabel) {
    socket.emit('command:click_action', {
      commandId: newCommandId(),
      selectorPath,
      actionLabel,
    });
  }

  function buildPlanFullContent(planData) {
    const content = document.createElement('div');
    content.className = 'plan-card plan-card-modal';

    if (Array.isArray(planData.todos) && planData.todos.length > 0) {
      const completed = planData.todos.filter((todo) => todo.status === 'completed').length;
      const summary = document.createElement('div');
      summary.className = 'plan-progress';
      summary.textContent = `To-dos ${completed}/${planData.todos.length}`;
      content.appendChild(summary);

      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      planData.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      content.appendChild(todoList);
    }

    if (planData.bodyHtml) {
      const body = document.createElement('div');
      body.className = 'plan-description markdown-body';
      body.innerHTML = sanitizeHtml(planData.bodyHtml);
      normalizeMarkdownCodeBlocks(body);
      content.appendChild(body);
    }

    return content;
  }

  function buildPlanModalContent(msg, planData) {
    if (planData) return buildPlanFullContent(planData);
    const modalMsg = {
      ...msg,
      actions: Array.isArray(msg.actions)
        ? msg.actions.filter((action) => action.type !== 'view_plan')
        : msg.actions,
    };
    const content = buildPlanCard(modalMsg);
    content.classList.add('plan-card-modal');
    return content;
  }

  function renderPlanModal(msg) {
    if (!msg) return;
    $planModalLabel.textContent = msg.label || '';
    $planModalLabel.style.display = msg.label ? '' : 'none';
    $planModalTitle.textContent = msg.title || 'Plan';
    $planModalBody.innerHTML = '';
    $planModalBody.appendChild(buildPlanModalContent(msg, activePlanModal && activePlanModal.fullData));
  }

  async function loadFullPlanIntoModal(msg) {
    if (!msg.label || !activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = true;
    const result = await sendCommandAwaitResult('command:get_plan_full', {
      commandId: newCommandId(),
      type: 'get_plan_full',
      planLabel: msg.label,
    });
    if (!activePlanModal || activePlanModal.id !== msg.id) return;
    activePlanModal.loading = false;
    if (!result.ok || !result.data) return;
    activePlanModal.fullData = result.data;
    renderPlanModal(msg);
  }

  function openPlanModal(msg) {
    activePlanModal = { id: msg.id, label: msg.label || '', fullData: null, loading: false };
    renderPlanModal(msg);
    $planModalOverlay.classList.remove('hidden');
    loadFullPlanIntoModal(msg);
  }

  function closePlanModal() {
    activePlanModal = null;
    $planModalOverlay.classList.add('hidden');
  }

  function syncPlanModalFromState() {
    if (!activePlanModal) return;
    const current = (state.messages || []).find((msg) => msg.type === 'plan' && msg.id === activePlanModal.id);
    if (current) {
      renderPlanModal(current);
      if (current.label && !activePlanModal.fullData && !activePlanModal.loading) {
        loadFullPlanIntoModal(current);
      }
    }
  }

  async function openPlanModelPicker(msg) {
    if (!msg.modelDropdownSelectorPath) {
      if (msg.model) showToast(`Plan model: ${msg.model}`, 'success');
      return;
    }

    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_plan_model_options', {
      commandId,
      type: 'get_plan_model_options',
      selectorPath: msg.modelDropdownSelectorPath,
    });

    const options = Array.isArray(result.data?.options) ? result.data.options : [];
    if (!result.ok || options.length === 0) {
      emitClickAction(msg.modelDropdownSelectorPath);
      if (!result.ok) showToast(result.error || 'Could not load plan models', 'error');
      return;
    }

    activePlanModelContext = {
      selectorPath: msg.modelDropdownSelectorPath,
      title: msg.title || 'Plan',
      options,
    };
    openSheet('plan-model');
  }

  function buildPlanCard(msg) {
    const card = document.createElement('div');
    card.className = 'plan-card plan-card-widget';

    if (msg.label) {
      const header = document.createElement('div');
      header.className = 'plan-widget-header';
      const icon = document.createElement('span');
      icon.className = 'plan-widget-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '\u2712';
      const fn = document.createElement('span');
      fn.className = 'plan-widget-filename';
      fn.textContent = msg.label;
      header.appendChild(icon);
      header.appendChild(fn);
      card.appendChild(header);
    }

    const title = document.createElement('div');
    title.className = 'plan-title';
    title.textContent = msg.title;
    card.appendChild(title);

    if (msg.descriptionHtml) {
      const desc = document.createElement('div');
      desc.className = 'plan-description markdown-body';
      desc.innerHTML = sanitizeHtml(msg.descriptionHtml);
      normalizeMarkdownCodeBlocks(desc);
      card.appendChild(desc);
    } else if (msg.description) {
      const desc = document.createElement('div');
      desc.className = 'plan-description';
      desc.textContent = msg.description;
      card.appendChild(desc);
    }

    if (msg.todos && msg.todos.length > 0) {
      const todoList = document.createElement('div');
      todoList.className = 'plan-todo-list';
      msg.todos.forEach((todo) => {
        const item = document.createElement('div');
        item.className = 'plan-todo-item';
        const dot = document.createElement('span');
        dot.className = 'plan-todo-dot plan-todo-' + todo.status;
        item.appendChild(dot);
        const text = document.createElement('span');
        text.className = 'plan-todo-text';
        text.textContent = todo.text;
        item.appendChild(text);
        todoList.appendChild(item);
      });
      card.appendChild(todoList);
    }

    if (msg.todosMoreCount && msg.todosMoreCount > 0) {
      const more = document.createElement('div');
      more.className = 'plan-todos-more';
      more.textContent = `${msg.todosMoreCount} more`;
      card.appendChild(more);
    }

    if (msg.todosTotal > 0) {
      const progress = document.createElement('div');
      progress.className = 'plan-progress';
      const track = document.createElement('div');
      track.className = 'plan-progress-track';
      const bar = document.createElement('div');
      bar.className = 'plan-progress-bar';
      const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
      bar.style.width = pct + '%';
      track.appendChild(bar);
      progress.appendChild(track);
      const progressText = document.createElement('span');
      progressText.className = 'plan-progress-text';
      progressText.textContent = msg.todosCompleted + '/' + msg.todosTotal;
      progress.appendChild(progressText);
      card.appendChild(progress);
    }

    const hasActions = (msg.actions && msg.actions.length > 0) || msg.modelDropdownSelectorPath || msg.model;
    if (hasActions) {
      const toolbar = document.createElement('div');
      toolbar.className = 'plan-actions-toolbar';

      const left = document.createElement('div');
      left.className = 'plan-actions-left';
      if (msg.actions) {
        const viewAct = msg.actions.find((a) => a.type === 'view_plan');
        if (viewAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-view';
          btn.textContent = viewAct.label || 'View Plan';
          btn.addEventListener('click', () => openPlanModal(msg));
          left.appendChild(btn);
        }
      }
      toolbar.appendChild(left);

      const center = document.createElement('div');
      center.className = 'plan-actions-center';
      if (msg.modelDropdownSelectorPath) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'plan-model-pill';
        const lab = document.createElement('span');
        lab.className = 'plan-model-pill-text';
        lab.textContent = msg.model || 'Model';
        const chev = document.createElement('span');
        chev.className = 'plan-model-pill-chev';
        chev.textContent = '\u25BE';
        pill.appendChild(lab);
        pill.appendChild(chev);
        pill.addEventListener('click', () => { void openPlanModelPicker(msg); });
        center.appendChild(pill);
      } else if (msg.model) {
        const badge = document.createElement('span');
        badge.className = 'plan-model-badge-inline';
        badge.textContent = msg.model;
        center.appendChild(badge);
      }
      toolbar.appendChild(center);

      const right = document.createElement('div');
      right.className = 'plan-actions-right';
      if (msg.actions) {
        const buildAct = msg.actions.find((a) => a.type === 'build');
        if (buildAct) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'plan-btn plan-btn-build';
          btn.textContent = buildAct.label || 'Build';
          btn.addEventListener('click', () => emitClickAction(buildAct.selectorPath, buildAct.label || 'Build'));
          right.appendChild(btn);
        }
      }
      toolbar.appendChild(right);
      card.appendChild(toolbar);
    }

    return card;
  }

  function createPlanEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-plan';
    el.dataset.id = msg.id;
    el.appendChild(buildPlanCard(msg));
    return el;
  }

  function updatePlanEl(el, msg) {
    const oldCard = el.querySelector('.plan-card');
    if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
  }

  // --- Standalone todo list (matches Telegram §3.9) ---

  function createTodoListEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-todo-list';
    el.dataset.id = msg.id;
    const card = document.createElement('div');
    card.className = 'todo-list-card';
    const head = document.createElement('div');
    head.className = 'todo-list-card-title';
    head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'todo-list-card-items';
    msg.todos.forEach((todo) => {
      const row = document.createElement('div');
      row.className = 'todo-list-card-row';
      const icon = document.createElement('span');
      icon.className = 'todo-list-card-icon';
      icon.textContent = todo.status === 'completed' ? '✅'
        : todo.status === 'in_progress' ? '🔵' : '⚪';
      const tx = document.createElement('span');
      tx.className = 'todo-list-card-text';
      tx.textContent = todo.text;
      row.appendChild(icon);
      row.appendChild(tx);
      list.appendChild(row);
    });
    card.appendChild(list);
    el.appendChild(card);
    return el;
  }

  function updateTodoListEl(el, msg) {
    const fresh = createTodoListEl(msg);
    const newCard = fresh.querySelector('.todo-list-card');
    const oldCard = el.querySelector('.todo-list-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Run command / tool inline actions (Skip, Run, Allow) ---

  function appendRunStyleActionButtons(container, actions) {
    actions.forEach(function (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.type === 'run' ? 'run-btn run-btn-run'
        : action.type === 'allow' ? 'run-btn run-btn-allow'
        : 'run-btn run-btn-skip';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        socket.emit('command:click_action', {
          commandId: newCommandId(),
          selectorPath: action.selectorPath,
          actionLabel: action.label,
        });
      });
      container.appendChild(btn);
    });
  }

  function createRunCommandEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-run-command';
    el.dataset.id = msg.id;

    const card = document.createElement('div');
    card.className = 'run-card';

    const header = document.createElement('div');
    header.className = 'run-header';
    const desc = document.createElement('span');
    desc.className = 'run-description';
    desc.textContent = msg.description;
    header.appendChild(desc);
    if (msg.candidates) {
      const cand = document.createElement('span');
      cand.className = 'run-candidates';
      cand.textContent = ' ' + msg.candidates;
      header.appendChild(cand);
    }
    card.appendChild(header);

    const cmdBlock = document.createElement('div');
    cmdBlock.className = 'run-command-block';
    const prompt = document.createElement('span');
    prompt.className = 'run-prompt';
    prompt.textContent = '$ ';
    cmdBlock.appendChild(prompt);
    const cmdText = document.createElement('span');
    cmdText.className = 'run-command-text';
    cmdText.textContent = msg.command;
    cmdBlock.appendChild(cmdText);
    card.appendChild(cmdBlock);

    if (msg.actions && msg.actions.length > 0) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'run-actions-row';
      appendRunStyleActionButtons(actionsRow, msg.actions);
      card.appendChild(actionsRow);
    }

    el.appendChild(card);
    return el;
  }

  function updateRunCommandEl(el, msg) {
    const oldCommand = (el.querySelector('.run-command-text')?.textContent || '').trim();
    const nextMsg = (!msg.command || !msg.command.trim()) && oldCommand
      ? { ...msg, command: oldCommand }
      : msg;
    const fresh = createRunCommandEl(nextMsg);
    const newCard = fresh.querySelector('.run-card');
    const oldCard = el.querySelector('.run-card');
    if (newCard && oldCard) el.replaceChild(newCard, oldCard);
  }

  // --- Loading indicator ---

  function createLoadingEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-loading';
    el.dataset.id = msg.id;

    const dots = document.createElement('div');
    dots.className = 'loading-dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot-anim';
      dots.appendChild(dot);
    }
    el.appendChild(dots);
    return el;
  }

  // --- Fallback ---

  function createFallbackEl(msg) {
    const el = document.createElement('div');
    el.className = 'chat-el el-fallback';
    el.dataset.id = msg.id;
    el.textContent = msg.text || msg.type || '...';
    return el;
  }

  // --- Sanitize HTML (strip scripts, event handlers) ---

  function sanitizeHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('script, iframe, object, embed, form').forEach(el => el.remove());
    tmp
      .querySelectorAll('.composer-message-codeblock, .composer-code-block-container, .ui-code-block')
      .forEach((el) => el.remove());
    tmp.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('on') || attr.name === 'srcdoc') {
          el.removeAttribute(attr.name);
        }
      }
      if (el.tagName === 'A') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return tmp.innerHTML;
  }

  function normalizeMarkdownCodeBlocks(root) {
    if (!root) return;
    function extractStructuredCodeText(el) {
      let out = '';
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent || '';
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'br') {
          out += '\n';
          return;
        }
        const before = out.length;
        node.childNodes.forEach(walk);
        const isLineLike =
          tag === 'div' ||
          tag === 'p' ||
          tag === 'li' ||
          node.matches?.('[data-line], .line');
        if (isLineLike && out.length > before && !out.endsWith('\n')) {
          out += '\n';
        }
      }
      walk(el);
      return out.replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n').trimEnd();
    }

    root.querySelectorAll('code').forEach((codeEl) => {
      if (codeEl.closest('pre')) return;
      if (
        codeEl.className.includes('md-inline-') ||
        codeEl.closest('p, li, a, h1, h2, h3, h4, h5, h6')
      ) {
        return;
      }

      const text = extractStructuredCodeText(codeEl);
      const looksBlockLike =
        text.includes('\n') ||
        !!codeEl.querySelector('br,[data-line],.line,div,p') ||
        /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
      if (!looksBlockLike) return;

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = codeEl.className || '';
      code.textContent = text;
      pre.appendChild(code);
      codeEl.replaceWith(pre);
    });
  }

  // --- Approvals ---

  function renderApprovals() {
    if (state.pendingApprovals.length > 0) {
      $approvalBar.classList.remove('hidden');
      const approval = state.pendingApprovals[0];
      $approvalDesc.textContent = approval.description || 'Action needs approval';

      const approveAction = approval.actions.find(a => a.type === 'approve' || a.type === 'approve_all');
      const rejectAction = approval.actions.find(a => a.type === 'reject');

      $btnApprove.disabled = !approveAction;
      // Reject stays clickable even without an explicit control — the server
      // falls back to a Skip/Reject/Cancel search, then Escape.
      $btnReject.disabled = false;
      if (approveAction) $btnApprove.textContent = approveAction.label || 'Accept';
      if (rejectAction) $btnReject.textContent = rejectAction.label || 'Reject';
      else $btnReject.textContent = 'Reject';
    } else {
      $approvalBar.classList.add('hidden');
    }
  }

  /**
   * Which questionnaire to render and which window it belongs to. Prefers the
   * home window's own questionnaire; otherwise surfaces the most recent
   * non-home window questionnaire so questions raised elsewhere still show up.
   */
  function activeQuestionnaire() {
    if (homeQuestionnaire && homeQuestionnaire.questions && homeQuestionnaire.questions.length > 0) {
      return { questionnaire: homeQuestionnaire, windowId: '' };
    }
    var best = null;
    remoteQuestionnaires.forEach(function (q, winId) {
      if (!q.questions || q.questions.length === 0) return;
      if (!best) best = { questionnaire: q, windowId: winId };
    });
    return best;
  }

  function recomputeQuestionnaire() {
    var active = activeQuestionnaire();
    state.questionnaire = active ? active.questionnaire : null;
    questionnaireWindowId = active ? active.windowId : '';
  }

  /**
   * Build a stable signature of the questionnaire's structure. When it is
   * unchanged we skip the DOM rebuild so an in-progress freeform ("Other")
   * answer box is not wiped by the every-poll `state:patch` -> renderAll().
   * Includes isActive (so advancing a question still highlights correctly) but
   * excludes volatile fields like continueDisabled that we patch in place.
   */
  function questionnaireSignature(q) {
    var parts = [q.totalLabel || ''];
    for (var i = 0; i < q.questions.length; i++) {
      var question = q.questions[i];
      var opts = [];
      for (var j = 0; j < question.options.length; j++) {
        var opt = question.options[j];
        opts.push(opt.letter + '|' + opt.label + '|' + (opt.isFreeform ? '1' : '0') + '|' + (opt.selectorPath || ''));
      }
      parts.push(question.number + '|' + question.text + '|' + (question.isActive ? '1' : '0') + '|' + opts.join('||'));
    }
    return parts.join('###');
  }

  function renderQuestionnaire() {
    var q = state.questionnaire;
    if (!q || !q.questions || q.questions.length === 0) {
      $questionnaireBar.classList.add('hidden');
      questionnaireSelections = {};
      questionnaireRenderKey = '';
      return;
    }
    $questionnaireBar.classList.remove('hidden');
    $questionnaireStepper.textContent = q.totalLabel || '';
    $btnQContinue.disabled = q.continueDisabled;

    // Same structure as last render -> only refresh volatile bits in place.
    // This preserves the inline freeform textarea (and its typed text) across
    // the constant state:patch re-renders.
    var key = questionnaireSignature(q);
    if (key === questionnaireRenderKey && $questionnaireQuestions.children.length > 0) {
      return;
    }
    questionnaireRenderKey = key;

    $questionnaireQuestions.innerHTML = '';
    for (var i = 0; i < q.questions.length; i++) {
      var question = q.questions[i];
      var qDiv = document.createElement('div');
      qDiv.className = 'questionnaire-question' + (question.isActive ? ' questionnaire-question-active' : '');

      var labelDiv = document.createElement('div');
      labelDiv.className = 'questionnaire-question-label';
      var numSpan = document.createElement('span');
      numSpan.className = 'questionnaire-question-number';
      numSpan.textContent = question.number;
      var textSpan = document.createElement('span');
      textSpan.textContent = question.text;
      labelDiv.appendChild(numSpan);
      labelDiv.appendChild(textSpan);
      qDiv.appendChild(labelDiv);

      var optionsDiv = document.createElement('div');
      optionsDiv.className = 'questionnaire-options';
      for (var j = 0; j < question.options.length; j++) {
        var opt = question.options[j];
        var optBtn = document.createElement('button');
        var isSelected = questionnaireSelections[question.number] === opt.letter;
        optBtn.className = 'questionnaire-option' + (isSelected ? ' questionnaire-option-selected' : '');
        var letterSpan = document.createElement('span');
        letterSpan.className = 'questionnaire-option-letter';
        letterSpan.textContent = opt.letter + ')';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = ' ' + opt.label;
        optBtn.appendChild(letterSpan);
        optBtn.appendChild(labelSpan);
        optBtn.dataset.selectorPath = opt.selectorPath;
        optBtn.dataset.questionNumber = question.number;
        optBtn.dataset.letter = opt.letter;
        optBtn.dataset.label = opt.label;
        optBtn.dataset.freeform = opt.isFreeform ? '1' : '';
        optBtn.dataset.freeformSelector = opt.freeformInputSelectorPath || '';
        optBtn.addEventListener('click', function() {
          questionnaireSelections[this.dataset.questionNumber] = this.dataset.letter;
          var siblings = this.parentNode.querySelectorAll('.questionnaire-option');
          for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('questionnaire-option-selected');
          this.classList.add('questionnaire-option-selected');
          socket.emit('command:click_action', {
            commandId: newCommandId(),
            selectorPath: this.dataset.selectorPath,
            actionLabel: this.dataset.label,
            ...(questionnaireWindowId ? { windowId: questionnaireWindowId } : {}),
          });
          // Freeform ("Other"): reveal a local text box so the user can compose
          // an answer; it is pushed into Cursor on submit. Record the row path +
          // active flag so the box survives a state:patch re-render.
          var ffHost = this.parentNode.querySelector('.questionnaire-freeform');
          if (this.dataset.freeform === '1') {
            questionnaireFreeformActive[this.dataset.questionNumber] = true;
            questionnaireFreeformSelector[this.dataset.questionNumber] = this.dataset.freeformSelector;
            if (!ffHost) {
              ffHost = buildFreeformAnswer(this.dataset.questionNumber, this.dataset.freeformSelector);
              this.parentNode.appendChild(ffHost);
            }
            var ta = ffHost.querySelector('.questionnaire-freeform-input');
            if (ta) ta.focus();
          } else {
            if (ffHost) ffHost.remove();
            delete questionnaireFreeformActive[this.dataset.questionNumber];
            delete questionnaireFreeformDrafts[this.dataset.questionNumber];
            showToast('Answer sent', 'success');
          }
        });
        optionsDiv.appendChild(optBtn);
      }
      qDiv.appendChild(optionsDiv);
      $questionnaireQuestions.appendChild(qDiv);
    }

    // Re-mount any inline "Other" answer box the rebuild above dropped.
    restoreFreeformAnswers();
  }

  /** Inline "Other" answer box for a freeform questionnaire option. */
  function buildFreeformAnswer(questionNumber, freeformSelector) {
    var wrap = document.createElement('div');
    wrap.className = 'questionnaire-freeform';
    var ta = document.createElement('textarea');
    ta.className = 'questionnaire-freeform-input';
    ta.rows = 1;
    ta.placeholder = 'Type your answer…';
    // Restore any draft the user already typed before a re-render wiped the box.
    ta.value = questionnaireFreeformDrafts[questionNumber] || '';
    var send = document.createElement('button');
    send.type = 'button';
    send.className = 'questionnaire-freeform-send';
    send.textContent = 'Send answer';
    send.disabled = !ta.value.trim();
    ta.addEventListener('input', function() {
      questionnaireFreeformDrafts[questionNumber] = ta.value;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
      send.disabled = !ta.value.trim();
    });
    send.addEventListener('click', function() {
      var text = ta.value.trim();
      if (!text) return;
      // Resolve the row path fresh: the tray may have remounted after "Other"
      // was selected, shifting the stored path.
      var selector = liveFreeformSelector(questionNumber) || freeformSelector || '';
      void submitFreeformAnswer(questionNumber, selector, text);
    });
    wrap.appendChild(ta);
    wrap.appendChild(send);
    return wrap;
  }

  /**
   * Re-mount the inline "Other" answer box after renderQuestionnaire() rebuilt
   * the option list (which drops the previously appended box). Restores the
   * draft text and returns focus to the input that was being edited.
   */
  function restoreFreeformAnswers() {
    var activeEl = document.activeElement;
    var refocus = null;
    for (var i = 0; i < $questionnaireQuestions.children.length; i++) {
      var qDiv = $questionnaireQuestions.children[i];
      var numEl = qDiv.querySelector('.questionnaire-question-number');
      if (!numEl) continue;
      var qNum = numEl.textContent;
      if (!questionnaireFreeformActive[qNum]) continue;
      var optionsDiv = qDiv.querySelector('.questionnaire-options');
      if (!optionsDiv) continue;
      // Prefer the freshly-extracted row path (the tray may have remounted and
      // shifted); fall back to the path recorded when "Other" was clicked.
      var selector = liveFreeformSelector(qNum) || questionnaireFreeformSelector[qNum] || '';
      questionnaireFreeformSelector[qNum] = selector;
      var ffHost = optionsDiv.querySelector('.questionnaire-freeform');
      var hadFocus = !!activeEl && ffHost && ffHost.contains(activeEl);
      if (!ffHost) {
        ffHost = buildFreeformAnswer(qNum, selector);
        optionsDiv.appendChild(ffHost);
        hadFocus = true;
      }
      if (hadFocus) refocus = ffHost.querySelector('.questionnaire-freeform-input');
    }
    if (refocus) refocus.focus();
  }

  /** Current freeform row path for a question number, straight from state. */
  function liveFreeformSelector(questionNumber) {
    var q = state.questionnaire;
    if (!q || !q.questions) return '';
    for (var i = 0; i < q.questions.length; i++) {
      if (q.questions[i].number !== questionNumber) continue;
      var opts = q.questions[i].options || [];
      for (var j = 0; j < opts.length; j++) {
        if (opts[j].isFreeform) return opts[j].freeformInputSelectorPath || opts[j].selectorPath || '';
      }
    }
    return '';
  }

  async function submitFreeformAnswer(questionNumber, freeformSelector, text) {
    if (freeformSelector) {
      const typeResult = await sendCommandAwaitResult('command:set_answer_text', {
        commandId: newCommandId(),
        type: 'set_answer_text',
        selectorPath: freeformSelector,
        text,
        ...(questionnaireWindowId ? { windowId: questionnaireWindowId } : {}),
      });
      if (!typeResult.ok) {
        showToast(typeResult.error || 'Could not type answer', 'error');
        return;
      }
    } else {
      // No known input selector: submit the raw text via the composer instead.
      socket.emit('command:send_message', { commandId: newCommandId(), text });
      showToast('Answer sent', 'success');
      questionnaireSelections[questionNumber] = '';
      clearFreeformAnswer(questionNumber);
      renderQuestionnaire();
      return;
    }
    // Advance the questionnaire.
    if (state.questionnaire && state.questionnaire.continueSelectorPath) {
      await sendCommandAwaitResult('command:click_action', {
        commandId: newCommandId(),
        selectorPath: state.questionnaire.continueSelectorPath,
        actionLabel: 'Continue',
        ...(questionnaireWindowId ? { windowId: questionnaireWindowId } : {}),
      });
    }
    questionnaireSelections[questionNumber] = '';
    clearFreeformAnswer(questionNumber);
    showToast('Answer sent', 'success');
    renderQuestionnaire();
  }

  /** Drop the inline "Other" answer box state for a question after it is sent. */
  function clearFreeformAnswer(questionNumber) {
    delete questionnaireFreeformDrafts[questionNumber];
    delete questionnaireFreeformActive[questionNumber];
    delete questionnaireFreeformSelector[questionNumber];
  }

  // The abort/stop control must be reachable for the entire turn, but the
  // server's `agentStatus` legitimately flips between `running_tool`,
  // `waiting_approval`, `thinking`, and even `idle` between poll cycles.
  // Keep the button visible with a short hold so those transient gaps don't
  // make it flicker away.
  let abortVisibleUntil = 0;
  let abortHoldTimer = null;
  const ABORT_HOLD_MS = 12000;

  function renderInputState() {
    $input.disabled = !state.inputAvailable && !state.connected;
    $btnSend.disabled = !$input.value.trim() || $input.disabled;

    // Show Stop while the agent is actively working. Prefer the ground-truth
    // `canAbort` flag (Cursor's own stop control / live tool spinner), which
    // stays true for the whole turn. `agentStatus` is only a secondary hint.
    const statusWorking = !!state.connected && state.agentStatus !== 'idle'
      && state.agentStatus !== 'waiting_approval' && state.agentStatus !== 'error';
    const groundTruth = !!state.canAbort;
    const live = !!state.connected && !!state.agentActivityLive;
    const workingNow = groundTruth || statusWorking || live;

    const now = Date.now();
    if (workingNow) {
      abortVisibleUntil = now + ABORT_HOLD_MS;
      if (abortHoldTimer) { clearTimeout(abortHoldTimer); abortHoldTimer = null; }
    } else if (now < abortVisibleUntil && !abortHoldTimer) {
      // Schedule a re-render for when the hold expires so the control hides
      // even if no further state patch arrives.
      abortHoldTimer = setTimeout(() => {
        abortHoldTimer = null;
        renderInputState();
      }, abortVisibleUntil - now);
    }
    $btnAbort.classList.toggle('hidden', !workingNow && now >= abortVisibleUntil);
  }

  /**
   * Edge-triggered notifications. Fires only when:
   *   - the agent NEWLY asks a question / needs approval, or
   *   - the agent has genuinely finished (was working, then stayed idle —
   *     status alone flaps mid-run, so we key off the ground-truth working
   *     signal and require the idle reading to settle).
   * Regular messages never trigger a notification (the old behaviour fired
   * one for every tool/command message, which bombarded the user).
   *
   * Two false-positive guards:
   *   - A transport drop (`connected: false`) must not look like a finish —
   *     `isAgentWorking()` is false while disconnected, which used to schedule
   *     a chime ~5s after locking the phone even when nothing had finished.
   *   - Switching the active composer (folder navigation) re-primes so the
   *     previous chat's "was working" bit is not attributed to the new idle one.
   */
  function maybeNotifyTransitions() {
    const hasQuestionnaire = !!(state.questionnaire && state.questionnaire.questions
      && state.questionnaire.questions.length > 0);
    const hasApproval = (state.pendingApprovals || []).length > 0;
    const working = isAgentWorking();
    const composerId = state.activeComposerId || '';

    // First render after load: adopt the current state without notifying.
    if (!notificationsPrimed) {
      notificationsPrimed = true;
      notifyComposerId = composerId;
      wasWorking = working;
      hadQuestionnaire = hasQuestionnaire;
      hadApproval = hasApproval;
      return;
    }

    // Composer switched (folder/agent open): adopt the new agent's signals.
    // Without this, opening an idle chat after watching a working one looks
    // like "working → idle" and pings "Agent finished" for the wrong chat.
    if (composerId !== notifyComposerId) {
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      notifyComposerId = composerId;
      wasWorking = working;
      hadQuestionnaire = hasQuestionnaire;
      hadApproval = hasApproval;
      return;
    }

    // Socket/CDP drop: never treat "not connected" as the agent finishing.
    // Cancel any settle timer started from a flaky reading; keep wasWorking so
    // a genuine finish that happened while we were offline is still announced
    // once we reconnect and see a settled idle state for the SAME composer.
    if (!state.connected) {
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      return;
    }

    if (hasQuestionnaire && !hadQuestionnaire) {
      hideFinishedBanner();
      showQuestionAlert();
      playAlertChime();
      fireNotification('Agent has a question for you', 'cursor-questionnaire');
    } else if (!hasQuestionnaire && hadQuestionnaire) {
      // Question answered/skipped: drop the alert (leave a real finish banner alone).
      hideQuestionAlert();
    } else if (hasApproval && !hadApproval) {
      hideFinishedBanner();
      playAlertChime();
      const approval = state.pendingApprovals[0];
      fireNotification((approval && approval.description) || 'Agent needs approval', 'cursor-approval');
    }

    if (working) {
      // Agent picked work back up (or is still going): cancel any pending
      // "finished" notification and remember we were working.
      hideFinishedBanner();
      wasWorking = true;
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    } else if (wasWorking && !finishTimer) {
      // Idle after having worked — debounce so transient gaps (idle between
      // tool steps) don't fire a premature "finished" notification.
      const finishForComposer = composerId;
      finishTimer = setTimeout(() => {
        finishTimer = null;
        // Composer changed or we lost the link while settling — abort.
        if (!state.connected) return;
        if ((state.activeComposerId || '') !== finishForComposer) {
          wasWorking = isAgentWorking();
          return;
        }
        const nowWorking = isAgentWorking();
        if (nowWorking) { wasWorking = true; return; }
        // Only announce a true finish — not a state the agent is blocked on
        // (waiting for approval, erroring, or asking a question).
        const blocked = state.agentStatus === 'waiting_approval'
          || state.agentStatus === 'error'
          || !!(state.questionnaire && state.questionnaire.questions
                && state.questionnaire.questions.length > 0);
        wasWorking = false;
        if (blocked) return;
        playChime();
        const finCtx = finishedContext();
        fireNotification(
          'Agent finished' + (finCtx.what ? ': ' + finCtx.what : '')
            + (finCtx.where ? ' (' + finCtx.where + ')' : ''),
          'cursor-finished'
        );
        showFinishedBanner();
      }, FINISH_SETTLE_MS);
    }

    hadQuestionnaire = hasQuestionnaire;
    hadApproval = hasApproval;
  }

  /** Ground-truth view of whether the agent is actively working right now. */
  function isAgentWorking() {
    if (!state.connected) return false;
    if (state.canAbort) return true;
    if (state.agentActivityLive) return true;
    return state.agentStatus !== 'idle'
      && state.agentStatus !== 'waiting_approval'
      && state.agentStatus !== 'error';
  }

  /**
   * Big visual "the agent finished" banner — a fake notification for people
   * who can't (or don't want to) grant real notification permission. Unlike an
   * OS notification this shows even while the app is focused (so the finish is
   * unmissable), but it never interrupts active typing. Click anywhere to
   * dismiss.
   */
  /**
   * Identify which agent/chat finished and where, so a phone watching several
   * agents at once can tell them apart. `what` prefers the active chat tab in
   * the current window, then the active agent of the finished agent's folder;
   * `where` is the workspace folder the finished agent belongs to (or the window
   * title when it isn't the generic "Cursor Agents" overview). Both fall back to
   * each other so the banner always names something, and either may be '' when
   * nothing is known.
   */
  function finishedContext() {
    const windows = state.windows || [];
    const activeWin = windows.find((w) => w.id === state.activeWindowId);
    const winTitle = (activeWin && activeWin.title) || '';

    const tabs = state.chatTabs || [];
    const activeTab = tabs.find((t) => t.isActive)
      || tabs.find((t) => t.composerId && t.composerId === state.activeComposerId);

    const folders = state.folders || [];
    const currentFolder = folders.find((f) => f.isCurrent);

    // Which agent most likely just finished: the active tab's composer, then the
    // relay's active composer. Resolve its FOLDER by scanning every folder's
    // agents — when the relay is homed on the "Cursor Agents" overview window,
    // Cursor marks no folder `isCurrent` (its title is the generic "Cursor
    // Agents"), so relying on isCurrent alone would leave the banner unable to
    // name the folder that finished.
    const targetComposerId = (activeTab && activeTab.composerId) || state.activeComposerId || '';
    let ownerFolder = null;
    let ownerAgent = null;
    if (targetComposerId) {
      for (const f of folders) {
        const a = (f.agents || []).find((x) => x.composerId && x.composerId === targetComposerId);
        if (a) { ownerFolder = f; ownerAgent = a; break; }
      }
    }
    if (!ownerFolder) ownerFolder = currentFolder || null;

    // The agent currently open in the finished agent's folder, for when no tab
    // list is mounted (plain workspace window rather than the unified overview).
    const folderAgent = ownerAgent
      || (ownerFolder ? (ownerFolder.agents || []).find((a) => a.isActive) : null);

    // The generic overview window title carries no identity; ignore it.
    const winTitleUsable = winTitle && !/^cursor\s*agents$/i.test(winTitle) ? winTitle : '';

    const folderName = (ownerFolder && ownerFolder.name) || '';
    const what = (activeTab && activeTab.title)
      || (folderAgent && folderAgent.title)
      || winTitleUsable
      || folderName;
    const where = folderName || winTitleUsable;
    return { what: what || '', where: where || '' };
  }

  /** One-line preview of the newest assistant/user content, for the banner. */
  function finishedSnippet() {
    let msgs = state.messages || [];
    if (fullHistory.messages.length > 0) {
      const matches = !fullHistory.composerId || !state.activeComposerId
        || fullHistory.composerId === state.activeComposerId;
      if (matches) msgs = mergeHistoryWithLive(fullHistory.messages, state.messages);
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m) continue;
      let text = '';
      if (m.type === 'assistant' || m.type === 'human') text = m.text || '';
      else if (m.type === 'plan') text = m.title || m.label || '';
      else if (m.type === 'tool') text = [m.action, m.details].filter(Boolean).join(' ');
      if (!text) continue;
      const clean = String(text).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      return clean.length > 120 ? clean.slice(0, 119) + '\u2026' : clean;
    }
    return '';
  }

  function showFinishedBanner() {
    if (!$finishedOverlay) return;
    const input = document.getElementById('message-input');
    const typing = !!input
      && (document.activeElement === input || (input.value || '').trim().length > 0);
    if (typing) return;

    const ctx = finishedContext();
    const snippet = finishedSnippet();
    if ($finishedWhat) {
      $finishedWhat.textContent = ctx.what;
      $finishedWhat.classList.toggle('hidden', !ctx.what);
    }
    if ($finishedWhere) {
      $finishedWhere.textContent = ctx.where ? `in ${ctx.where}` : '';
      $finishedWhere.classList.toggle('hidden', !ctx.where);
    }
    if ($finishedSnippet) {
      $finishedSnippet.textContent = snippet;
      $finishedSnippet.classList.toggle('hidden', !snippet);
    }

    $finishedOverlay.classList.remove('hidden');
  }

  function hideFinishedBanner() {
    if (!$finishedOverlay) return;
    $finishedOverlay.classList.add('hidden');
  }

  /**
   * Big visual "the agent asked a question" alert — the question counterpart to
   * the finished banner. Shown the moment a question first appears so it is
   * unmissable even without notification permission; tapping "Open questions"
   * reveals the answer card, tapping elsewhere dismisses it.
   */
  function showQuestionAlert() {
    if (!$questionOverlay) return;
    const input = document.getElementById('message-input');
    const typing = !!input
      && (document.activeElement === input || (input.value || '').trim().length > 0);
    if (typing) return;
    if ($questionOverlayPreview) {
      const q = state.questionnaire && state.questionnaire.questions
        ? state.questionnaire.questions[state.questionnaire.activeIndex]
          || state.questionnaire.questions[0]
        : null;
      const preview = (q && q.text) ? q.text : '';
      $questionOverlayPreview.textContent = preview.length > 140
        ? preview.slice(0, 139) + '…'
        : preview;
      $questionOverlayPreview.style.display = preview ? '' : 'none';
    }
    // Never show both the finished and question banners at once.
    hideFinishedBanner();
    $questionOverlay.classList.remove('hidden');
  }

  function hideQuestionAlert() {
    if (!$questionOverlay) return;
    $questionOverlay.classList.add('hidden');
  }

  /** Reveal the answer card and scroll it into view. */
  function openQuestionCard() {
    const bar = document.getElementById('questionnaire-bar');
    if (bar) {
      bar.classList.remove('hidden');
      bar.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  function fireNotification(text, tag) {
    if (document.hasFocus()) return;
    if (typeof Notification === 'undefined') return;
    var ntag = tag || 'cursor-agent';
    var show = function () {
      try {
        new Notification('CursorRemote', { body: text, tag: ntag });
      } catch (_) { /* some browsers throw if blocked */ }
    };
    if (notificationPermission === 'granted') { show(); return; }
    if (notificationPermission === 'denied') return;
    // Permission not yet decided — request it. Browsers may reject this when
    // there's no user gesture, so we also pre-request on first interaction.
    try {
      Notification.requestPermission().then(function (perm) {
        notificationPermission = perm;
        if (perm === 'granted') show();
      });
    } catch (_) { /* ignore */ }
  }

  // --- Window rendering ---

  function renderWindows() {
    const windows = state.windows || [];
    if (windows.length <= 1) {
      $windowBar.classList.add('hidden');
      return;
    }
    $windowBar.classList.remove('hidden');

    const existingBtns = $windowList.querySelectorAll('.window-item');
    const existingMap = new Map();
    existingBtns.forEach(b => existingMap.set(b.dataset.id, b));

    const newIds = new Set(windows.map(w => w.id));
    existingBtns.forEach(b => {
      if (!newIds.has(b.dataset.id)) b.remove();
    });

    windows.forEach((win) => {
      let btn = existingMap.get(win.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'window-item';
        btn.dataset.id = win.id;
        btn.addEventListener('click', () => {
          socket.emit('command:switch_window', {
            commandId: newCommandId(),
            windowId: win.id,
          });
          showToast('Switching window...', 'success');
        });
        $windowList.appendChild(btn);
      }

      const isActive = win.id === state.activeWindowId;
      btn.className = 'window-item' + (isActive ? ' active' : '');
      btn.textContent = win.title || 'Cursor';
    });
  }

  // --- Tab rendering ---

  function renderTabs() {
    const tabs = state.chatTabs || [];
    if (tabs.length <= 1) {
      $tabBar.classList.add('hidden');
      return;
    }
    $tabBar.classList.remove('hidden');

    const existingBtns = $tabList.querySelectorAll('.tab-item');
    const existingMap = new Map();
    existingBtns.forEach(b => existingMap.set(b.dataset.title, b));

    const newTitles = new Set(tabs.map(t => t.title));
    existingBtns.forEach(b => {
      if (!newTitles.has(b.dataset.title)) b.remove();
    });

    tabs.forEach((tab, i) => {
      let btn = existingMap.get(tab.title);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tab-item';
        btn.dataset.title = tab.title;
        btn.addEventListener('click', () => {
          socket.emit('command:switch_tab', {
            commandId: newCommandId(),
            tabTitle: tab.title,
            selectorPath: tab.selectorPath,
            composerId: tab.composerId,
          });
          selectComposer(tab.composerId);
        });
        $tabList.appendChild(btn);
      }

      btn.className = 'tab-item' + (tab.isActive ? ' active' : '');
      btn.textContent = tab.title || `Chat ${i + 1}`;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Mode / Model rendering ---

  const MODE_ICONS = {
    agent: '\u221E',
    plan: '\u2611',
    debug: '\uD83D\uDC1B',
    chat: '\uD83D\uDCAC',
  };

  const MODE_LABELS = {
    agent: 'Agent',
    plan: 'Plan',
    debug: 'Debug',
    chat: 'Ask',
  };

  function renderModeModel() {
    const mode = state.mode || { current: 'agent', available: [] };
    const model = state.model || { current: 'Auto', currentId: '' };

    $pillModeIcon.textContent = MODE_ICONS[mode.current] || '';
    $pillModeText.textContent = MODE_LABELS[mode.current] || mode.current;
    $pillModelText.textContent = model.current || 'Auto';
  }

  renderAll();

  // --- Bottom sheet logic ---

  let activeSheet = null;
  // Agent row awaiting archive confirmation in the folders drawer, keyed by
  // composerId (falling back to title). Survives a state-push re-render so the
  // armed Cancel/Archive pair stays put instead of snapping back to the icon.
  let pendingArchiveKey = '';

  function openSheet(type) {
    closeSheet();
    activeSheet = type;
    $sheetOverlay.classList.remove('hidden');

    if (type === 'mode') {
      $sheetMode.classList.remove('hidden');
      renderModeSheet();
    } else if (type === 'model') {
      $sheetModel.classList.remove('hidden');
      if (cachedModelOptions) {
        renderModelSheet(cachedModelOptions);
      } else {
        renderModelSheetLoading();
      }
      fetchModelOptions().then(options => {
        if (activeSheet !== 'model') return;
        if (options) {
          renderModelSheet(options);
        } else if (!cachedModelOptions) {
          renderModelSheet(null);
        }
      });
    } else if (type === 'plan-model') {
      $sheetPlanModel.classList.remove('hidden');
      renderPlanModelSheet();
    } else if (type === 'slash') {
      $sheetSlash.classList.remove('hidden');
    } else if (type === 'folders') {
      $sheetFolders.classList.remove('hidden');
      renderFoldersSheet();
    } else if (type === 'notify') {
      $sheetNotify.classList.remove('hidden');
      renderNotifySheet();
    }
  }
  function closeSheet(options) {
    const skipSlashCancel = !!(options && options.keepSlashMenu);
    const wasSlash = activeSheet === 'slash';
    $sheetOverlay.classList.add('hidden');
    $sheetMode.classList.add('hidden');
    $sheetModel.classList.add('hidden');
    $sheetPlanModel.classList.add('hidden');
    $sheetSlash.classList.add('hidden');
    $sheetFolders.classList.add('hidden');
    $sheetNotify.classList.add('hidden');
    activeSheet = null;
    // Leaving the slash sheet without picking a row must also close the host
    // composer's tray (and drop the stray "/") — mirror the app's Escape.
    if (wasSlash && !skipSlashCancel) {
      socket.emit('command:cancel_slash_menu', { commandId: newCommandId(), type: 'cancel_slash_menu' });
    }
    if (wasSlash) {
      // Drop the filter so the next open starts clean and a paused debounce from
      // a previous session can't fire against the re-opened sheet.
      slashSearchQuery = '';
      slashRenderedQuery = null;
      if (slashSearchTimer) { clearTimeout(slashSearchTimer); slashSearchTimer = null; }
      if ($sheetSlashSearch) $sheetSlashSearch.value = '';
    }
  }

  function renderModeSheet() {
    $sheetModeList.innerHTML = '';
    const modes = [
      { id: 'agent', label: 'Agent', icon: '\u221E' },
      { id: 'plan', label: 'Plan', icon: '\u2611' },
      { id: 'debug', label: 'Debug', icon: '\uD83D\uDC1B' },
      { id: 'chat', label: 'Ask', icon: '\uD83D\uDCAC' },
    ];
    const current = (state.mode || {}).current || 'agent';

    modes.forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (m.id === current ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-icon">${m.icon}</span>` +
        `<span>${escapeHtml(m.label)}</span>` +
        (m.id === current ? '<span class="sheet-item-check">\u2713</span>' : '');
      btn.addEventListener('click', () => {
        socket.emit('command:set_mode', { commandId: newCommandId(), modeId: m.id });
        closeSheet();
        showToast(`Mode: ${m.label}`, 'success');
      });
      $sheetModeList.appendChild(btn);
    });
  }

  let cachedModelOptions = null;

  async function fetchModelOptions() {
    const commandId = newCommandId();
    const result = await sendCommandAwaitResult('command:get_model_options', {
      commandId,
      type: 'get_model_options',
    });
    if (result.ok && Array.isArray(result.data?.options)) {
      cachedModelOptions = result.data.options;
      return result.data.options;
    }
    return null;
  }

  function renderModelSheet(options) {
    $sheetModelList.innerHTML = '';

    if (!options || options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'No models available';
      $sheetModelList.appendChild(empty);
      return;
    }

    const currentId = ((state.model || {}).currentId || '');
    const currentName = ((state.model || {}).current || '').toLowerCase();

    options.forEach(opt => {
      const isSelected = (currentId && opt.id === currentId) || opt.selected ||
        currentName === opt.label.toLowerCase();
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (isSelected ? ' selected' : '');

      let inner = '<span class="sheet-item-label">' + escapeHtml(opt.label) + '</span>';
      const right = [];
      if (isSelected) right.push('<span class="sheet-item-check">\u2713</span>');
      inner += '<span class="sheet-item-right">' + right.join('') + '</span>';

      btn.innerHTML = inner;
      btn.addEventListener('click', () => {
        socket.emit('command:set_model', { commandId: newCommandId(), modelId: opt.id });
        closeSheet();
        showToast(`Model: ${opt.label}`, 'success');
      });
      $sheetModelList.appendChild(btn);
    });
  }

  function renderModelSheetLoading() {
    $sheetModelList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sheet-loading';
    loading.textContent = 'Loading models…';
    $sheetModelList.appendChild(loading);
  }

  function renderPlanModelSheet() {
    $sheetPlanModelList.innerHTML = '';
    const ctx = activePlanModelContext;
    $sheetPlanModelHeader.textContent = ctx && ctx.title ? `Plan Model · ${ctx.title}` : 'Plan Model';
    if (!ctx || !Array.isArray(ctx.options) || ctx.options.length === 0) return;

    ctx.options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'sheet-item' + (opt.selected ? ' selected' : '');
      btn.innerHTML =
        `<span class="sheet-item-label">${escapeHtml(opt.label)}</span>` +
        `<span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ''}</span>`;
      btn.addEventListener('click', async () => {
        const result = await sendCommandAwaitResult('command:set_plan_model', {
          commandId: newCommandId(),
          type: 'set_plan_model',
          selectorPath: ctx.selectorPath,
          planModelId: opt.id,
        });
        if (!result.ok) {
          showToast(result.error || 'Could not set plan model', 'error');
          return;
        }
        closeSheet();
        showToast(`Plan model: ${opt.label}`, 'success');
      });
      $sheetPlanModelList.appendChild(btn);
    });
  }

  // --- Commands sheet (mirrors Cursor's `/` tray) ---

  // Cursor's tray only renders ~14 rows and never scrolls, so the search box is
  // the only way to reach the rest of the commands: it re-opens the tray at
  // `/<query>` and Cursor filters its own list. Results are cached per query so
  // backspacing is instant and each distinct query costs at most one CDP trip.
  const slashOptionsCache = new Map();

  async function openSlashMenu() {
    slashSearchQuery = '';
    slashRenderedQuery = null;
    slashOptionsCache.clear();
    if (slashSearchTimer) { clearTimeout(slashSearchTimer); slashSearchTimer = null; }
    if ($sheetSlashSearch) $sheetSlashSearch.value = '';
    // Re-read usage from storage on each open: another tab (or a previous
    // session) may have updated it, and it keeps a stale in-memory list from
    // outliving a hidden/restored page.
    slashUsage = loadSlashUsage();
    openSheet('slash');
    renderSlashSheetLoading();
    await fetchAndRenderSlash('');
  }

  /** Re-query for the current search text (debounced by the input handler). */
  async function refreshSlashSheet() {
    const query = slashSearchQuery.trim();
    if (slashOptionsCache.has(query)) {
      slashRenderedQuery = query;
      renderSlashSheet(slashOptionsCache.get(query), query);
      return;
    }
    renderSlashSheetLoading();
    await fetchAndRenderSlash(query);
  }

  async function fetchAndRenderSlash(query) {
    const result = await sendCommandAwaitResult('command:get_slash_menu', {
      commandId: newCommandId(),
      type: 'get_slash_menu',
      slashQuery: query,
    });
    if (activeSheet !== 'slash') return;
    // Stale-response guard: a slower earlier response must not overwrite a newer
    // query's results (typing "re" then "review" fires two round-trips).
    if (query !== slashSearchQuery.trim()) return;
    if (result.ok && result.data && result.data.open) {
      const options = result.data.options || [];
      slashOptionsCache.set(query, options);
      slashRenderedQuery = query;
      renderSlashSheet(options, query);
    } else {
      slashRenderedQuery = query;
      renderSlashSheet([], query);
      if (!result.ok) {
        showToast(result.error || 'Could not open commands', 'error');
      }
    }
  }

  function renderSlashSheetLoading() {
    $sheetSlashList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'sheet-loading';
    loading.textContent = 'Opening commands…';
    $sheetSlashList.appendChild(loading);
  }

  function renderSlashSheet(options, query) {
    $sheetSlashList.innerHTML = '';
    const q = (query || '').trim();
    if (!options || options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = q ? `No commands match “${q}”` : 'No commands available';
      $sheetSlashList.appendChild(empty);
      return;
    }

    if (q) {
      // While searching, keep Cursor's own relevance order — it already ranks
      // by best match across the token and the description.
      options.forEach(opt => $sheetSlashList.appendChild(buildSlashRow(opt)));
      return;
    }

    // No filter: surface recently/frequently used commands first, then the rest
    // in Cursor's order. Recents are per-device, from localStorage.
    const recentIds = slashUsage.map(e => e.k);
    const recent = options
      .filter(opt => recentIds.includes(String(opt.id || '').toLowerCase()))
      .sort((a, b) => {
        const ra = slashUsageRank(a.id);
        const rb = slashUsageRank(b.id);
        if (rb.used !== ra.used) return rb.used - ra.used;
        return ra.rank - rb.rank;
      })
      .slice(0, 5);

    if (recent.length > 0) {
      $sheetSlashList.appendChild(buildSlashSection('Recent'));
      recent.forEach(opt => $sheetSlashList.appendChild(buildSlashRow(opt)));
      const rest = options.filter(opt => !recent.includes(opt));
      if (rest.length > 0) {
        $sheetSlashList.appendChild(buildSlashSection('All commands'));
        rest.forEach(opt => $sheetSlashList.appendChild(buildSlashRow(opt)));
      }
    } else {
      options.forEach(opt => $sheetSlashList.appendChild(buildSlashRow(opt)));
    }
  }

  function buildSlashSection(text) {
    const header = document.createElement('div');
    header.className = 'slash-section-header';
    header.textContent = text;
    return header;
  }

  function buildSlashRow(opt) {
    const btn = document.createElement('button');
    btn.className = 'sheet-item sheet-item-slash' + (opt.selected ? ' selected' : '');
    const main = document.createElement('div');
    main.className = 'slash-row-main';
    const token = document.createElement('span');
    token.className = 'slash-token';
    token.textContent = '/' + (opt.id || opt.label);
    const label = document.createElement('span');
    label.className = 'sheet-item-label';
    label.textContent = opt.label || '';
    main.appendChild(token);
    main.appendChild(label);
    btn.appendChild(main);
    if (opt.description) {
      const desc = document.createElement('div');
      desc.className = 'slash-desc';
      desc.textContent = opt.description;
      btn.appendChild(desc);
    }
    btn.addEventListener('click', () => { void chooseSlashCommand(opt); });
    return btn;
  }

  // --- Folders drawer ---

  /**
   * Per-composer status for the folder menu, combining the home window's live
   * state with the per-window snapshots (non-home windows). Each entry says
   * whether that agent is working and/or blocked waiting on the user (a
   * multiple-choice question or a tool approval), so `renderFoldersSheet` can
   * pick the right glyph. Precedence for the single-slot glyph is decided by the
   * caller: waiting-on-you outranks working.
   */
  function composerStatusMap() {
    const map = new Map();
    const now = Date.now();
    for (const [windowId, entry] of snapshotWorkingComposers) {
      // Prune a window that stopped reporting (closed) so its glyph doesn't
      // linger forever: a live snapshot refreshes `at` on every window cycle.
      if (now - entry.at > WORKING_SNAPSHOT_TTL_MS) {
        snapshotWorkingComposers.delete(windowId);
        continue;
      }
      map.set(entry.composerId, {
        working: !!entry.working,
        question: !!entry.question,
        approval: !!entry.approval,
      });
    }
    const homeComposerId = (state.activeComposerId || '').trim();
    if (homeComposerId) {
      // The home window's questionnaire is mirrored in `state.questionnaire`
      // and its approvals in `state.pendingApprovals`; the working flag uses the
      // ground-truth state. OR with whatever the home window's own snapshot put
      // here so a transient null on one path can't mask a real pending question.
      const prev = map.get(homeComposerId);
      const homeQuestion = !!(homeQuestionnaire && homeQuestionnaire.questions
        && homeQuestionnaire.questions.length > 0);
      const homeApproval = (state.pendingApprovals || []).length > 0;
      map.set(homeComposerId, {
        working: isAgentWorking() || !!(prev && prev.working),
        question: homeQuestion || !!(prev && prev.question),
        approval: homeApproval || !!(prev && prev.approval),
      });
    }
    return map;
  }

  /**
   * Status glyph for a single folder-menu row, from BOTH sources:
   *  - Cursor's own per-row status (`agent.agentStatus`, read from the sidebar
   *    status icon) — the authoritative source, present on every agent row, so
   *    several agents working at once EACH get their own spinner. This is why
   *    the folder menu previously showed only one: the window-snapshot path below
   *    knows only the active agent of each window.
   *  - the per-window snapshot / home state (`statusById`) as a secondary signal
   *    for question/approval routing (which Cursor's status icon doesn't expose).
   * Waiting on the user outranks working. Returns null when there is nothing to
   * show.
   */
  function folderRowStatus(agent, statusById) {
    const s = agent && agent.composerId ? statusById.get(agent.composerId) : null;
    const dot = agent ? agent.agentStatus : null;
    const working = dot === 'working' || !!(s && s.working);
    const question = !!(s && s.question);
    const approval = !!(s && s.approval);
    // Cursor only flags needs-attention as one state; treat it as "waiting for
    // your input" so it reads like the question/approval badges.
    const needsAttention = dot === 'needs_attention';
    return {
      working,
      question,
      approval,
      needsAttention,
      needsYou: question || approval || needsAttention,
    };
  }

  function renderFoldersButton() {
    const folders = state.folders || [];
    if (folders.length === 0) {
      $btnFolders.classList.add('hidden');
      return;
    }
    $btnFolders.classList.remove('hidden');
    let agentCount = 0;
    for (const f of folders) agentCount += (f.agents || []).length;
    $foldersCount.textContent = agentCount > 0 ? `/ ${folders.length}` : `${folders.length}`;
    // Surface a "needs you" dot on the header button when any agent is blocked
    // on a question/approval (or Cursor flags needs-attention), so the banner in
    // the folder menu is discoverable without opening the drawer first.
    const statusById = composerStatusMap();
    let needsInput = 0;
    for (const f of folders) {
      for (const a of (f.agents || [])) {
        if (folderRowStatus(a, statusById).needsYou) needsInput++;
      }
    }
    $btnFolders.classList.toggle('needs-input', needsInput > 0);
    if (needsInput > 0) {
      $btnFolders.title = needsInput === 1
        ? '1 agent is waiting for you'
        : `${needsInput} agents are waiting for you`;
    } else {
      $btnFolders.removeAttribute('title');
    }
    if (activeSheet === 'folders') renderFoldersSheet();
  }

  function renderFoldersSheet() {
    $sheetFoldersList.innerHTML = '';
    const folders = state.folders || [];
    if (folders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sheet-empty';
      empty.textContent = 'No folders found yet.';
      $sheetFoldersList.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      const section = document.createElement('div');
      section.className = 'folder-section';

      const header = document.createElement('div');
      header.className = 'folder-header' + (folder.isCurrent ? ' current' : '');
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.textContent = folder.kind === 'repo' ? '\u{1F4E6}' : '\u{1F4C1}';
      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = folder.name;
      header.appendChild(icon);
      header.appendChild(name);
      if (folder.isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'folder-badge';
        badge.textContent = 'open';
        header.appendChild(badge);
      }

      // "New Agent" button on every folder header — lets you create an agent
      // in any folder (including ones showing "No agents yet") directly from
      // the remote.
      const newAgent = document.createElement('button');
      newAgent.className = 'folder-new-agent';
      newAgent.setAttribute('aria-label', 'New agent in ' + folder.name);
      newAgent.title = 'New agent in ' + folder.name;
      newAgent.textContent = '+';
      newAgent.addEventListener('click', (e) => {
        e.stopPropagation();
        createFolderAgent(folder);
      });
      header.appendChild(newAgent);
      section.appendChild(header);

      // Clicking the folder header itself also creates a new agent there —
      // "select itself inside of it, so I can create a new agent".
      header.addEventListener('click', () => createFolderAgent(folder));

      const agents = folder.agents || [];
      if (agents.length === 0) {
        const none = document.createElement('button');
        none.className = 'folder-agent-empty';
        none.type = 'button';
        none.title = 'Create a new agent in ' + folder.name;
        none.textContent = 'No agents yet — tap to create one';
        none.addEventListener('click', () => createFolderAgent(folder));
        section.appendChild(none);
      } else {
        const statusById = composerStatusMap();
        agents.forEach((agent) => {
          const st = folderRowStatus(agent, statusById);
          const key = agent.composerId || agent.title || '';
          // Waiting on the user outranks "working": a blocked agent is not
          // making progress, so the "needs you" glyph is the useful signal.
          const isWorking = st.working && !st.needsYou;
          const isQuestion = st.needsYou;

          // The row is a flex wrapper holding the tap-to-open button plus the
          // archive control. Keeping the spinner/status classes on `.folder-agent`
          // preserves the existing row semantics (and its tests).
          const row = document.createElement('div');
          row.className = 'folder-agent-row';

          const btn = document.createElement('button');
          btn.className = 'folder-agent'
            + (agent.isActive ? ' active' : '')
            + (isWorking ? ' working' : '')
            + (isQuestion ? ' needs-input' : '');
          const label = document.createElement('span');
          label.className = 'folder-agent-title';
          label.textContent = agent.title || 'Untitled';
          btn.appendChild(label);
          // Status glyph, pinned to the end of the row. A "?" for a pending
          // question, "!" for a pending approval, and a "!" for Cursor's own
          // "needs attention" flag (all mean the agent is blocked on you);
          // otherwise a spinner while it is working. The aria-label/role keep it
          // discoverable for screen readers.
          if (isQuestion) {
            const badge = document.createElement('span');
            badge.className = 'folder-agent-needs';
            // "!" for an approval or Cursor's needs-attention; "?" for a
            // question. If it's both, the question glyph wins (the more common
            // "needs you" case).
            const isApprovalOnly = (st.approval || st.needsAttention) && !st.question;
            badge.textContent = isApprovalOnly ? '!' : '?';
            badge.setAttribute('role', 'status');
            badge.setAttribute('aria-label',
              isApprovalOnly ? 'Waiting for your approval' : 'Waiting for your answer');
            badge.title = isApprovalOnly ? 'Waiting for your approval' : 'Waiting for your answer';
            btn.appendChild(badge);
          } else if (isWorking) {
            const spinner = document.createElement('span');
            spinner.className = 'folder-agent-spinner';
            spinner.setAttribute('aria-label', 'Agent is working');
            spinner.setAttribute('role', 'status');
            btn.appendChild(spinner);
          }
          btn.title = agent.title || 'Untitled';
          btn.addEventListener('click', () => {
            socket.emit('command:open_folder_agent', {
              commandId: newCommandId(),
              type: 'open_folder_agent',
              composerId: agent.composerId,
              tabTitle: agent.title,
              selectorPath: agent.selectorPath,
            });
            selectComposer(agent.composerId);
            showToast(`Opening ${agent.title}...`, 'success');
            closeSheet();
          });
          row.appendChild(btn);
          row.appendChild(buildArchiveControl(agent, folder, key));
          section.appendChild(row);
        });
      }
      $sheetFoldersList.appendChild(section);
    });
  }

  /**
   * Trailing archive control for an agent row.
   *
   * Archiving is destructive and mobile taps are easy to mis-hit, so the first
   * tap only arms the row ("Cancel"/"Archive" replace the single icon); the
   * second tap confirms. The armed key lives in `pendingArchiveKey` so a state
   * push mid-confirm re-renders the same row still armed.
   */
  function buildArchiveControl(agent, folder, key) {
    const wrap = document.createElement('div');
    wrap.className = 'folder-agent-actions';

    if (pendingArchiveKey === key) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'folder-agent-cancel';
      cancel.textContent = 'Cancel';
      cancel.setAttribute('aria-label', `Keep ${agent.title || 'agent'}`);
      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingArchiveKey = '';
        renderFoldersSheet();
      });

      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'folder-agent-confirm';
      confirm.textContent = 'Archive';
      confirm.setAttribute('aria-label', `Confirm archive ${agent.title || 'agent'}`);
      confirm.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingArchiveKey = '';
        archiveFolderAgent(agent);
      });

      wrap.appendChild(cancel);
      wrap.appendChild(confirm);
      return wrap;
    }

    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'folder-agent-archive';
    archive.textContent = '\u{1F5C4}';
    archive.setAttribute('aria-label', `Archive ${agent.title || 'agent'}`);
    archive.title = `Archive ${agent.title || 'Untitled'}`;
    archive.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingArchiveKey = key;
      renderFoldersSheet();
    });
    wrap.appendChild(archive);
    return wrap;
  }

  /**
   * Archive an agent row via Cursor's own sidebar Archive button. Cursor hides
   * the row from the sidebar (and stops it first if it is still running); the
   * relay re-extracts and pushes a fresh snapshot so the drawer drops the row
   * immediately.
   */
  async function archiveFolderAgent(agent) {
    showToast(`Archiving ${agent.title || 'agent'}...`, 'success');
    const result = await sendCommandAwaitResult('command:archive_folder_agent', {
      commandId: newCommandId(),
      type: 'archive_folder_agent',
      composerId: agent.composerId,
      tabTitle: agent.title,
      archiveAction: 'archive',
    });
    if (!result || !result.ok) {
      showToast(result?.error || `Could not archive ${agent.title || 'agent'}`, 'error');
      return;
    }
    showToast(`Archived ${agent.title || 'agent'}`, 'success');
    // If the archived chat was the one open, its transcript no longer applies.
    if (agent.composerId && agent.composerId === pinnedComposerId) {
      pinnedComposerId = '';
    }
    await requestStateRefresh();
  }

  /**
   * Create a new agent in a folder via the host's section "+" button.
   *
   * When a transcript is already open, the previous chat's messages keep
   * rendering until the relay reports the new composer — which made it look
   * like nothing happened. Clear the transcript up front (and unpin any
   * selection) so the UI reflects the fresh agent immediately, then refresh
   * state so the new composer is picked up as soon as Cursor mounts it.
   */
  async function createFolderAgent(folder) {
    // Drop the previous chat's full history so the populated transcript does
    // not linger. The new agent has no history yet, so the merged render falls
    // back to the live (empty) DOM tail until history arrives.
    fullHistory = { composerId: '', messages: [], oldestIndex: 0, hasMore: false };
    pendingHistoryComposerId = '';
    historyPageInFlight = false;
    pinnedComposerId = '';
    if (pinnedComposerTimer) clearTimeout(pinnedComposerTimer);
    resetScrollForNewTranscript();
    renderAll();

    closeSheet();
    showToast(`Creating new agent in ${folder.name}...`, 'success');

    // Remember the composer ids we already know, so after the click we can tell
    // which agent Cursor actually opened as new. The old code just called
    // requestStateRefresh(), then whichever composer happened to be active was
    // followed — which could still be the PREVIOUS folder's agent, making the
    // new chat show the wrong transcript.
    const knownComposerIds = new Set();
    for (const f of (state.folders || [])) {
      for (const a of (f.agents || [])) {
        if (a && a.composerId) knownComposerIds.add(a.composerId);
      }
    }

    // The previous chat's live DOM tail keeps arriving until the relay switches
    // composers; blank the transcript in the meantime so the new agent doesn't
    // appear to contain the old folder's messages. '__pending__' suppresses
    // unconditionally until adoptNewestComposer pins the new agent.
    suppressTranscriptUntil = '__pending__';

    const result = await sendCommandAwaitResult('command:create_folder_agent', {
      commandId: newCommandId(),
      type: 'create_folder_agent',
      sectionId: folder.sectionId,
      folderName: folder.name,
    });
    if (!result || !result.ok) {
      showToast(result?.error || `Could not create agent in ${folder.name}`, 'error');
      suppressTranscriptUntil = '';
      renderAll();
      return;
    }
    // Force a re-read so the newly-created composer/agent shows up without
    // waiting for the next poll (and, on the relay side, so its history loads).
    await requestStateRefresh();
    await adoptNewestComposer(knownComposerIds, folder);
  }

  /**
   * After creating a folder agent, wait (briefly) for Cursor's extracted state to
   * list a composer we had not seen before, then open it explicitly. This makes
   * the switch deterministic instead of racing the relay's "active composer may
   * or may not have updated yet" behaviour. If nothing new shows up (e.g. Cursor
   * reused an empty composer instead of creating one), it falls back to opening
   * the folder's active agent so the user still lands somewhere sensible.
   */
  async function adoptNewestComposer(knownIds, folder) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const fresh = findUnknownComposer(state.folders || [], knownIds);
      if (fresh) {
        // selectComposer() clears the suppression via noteActiveComposerChange,
        // but set the target here so the very next render is already unlocked.
        suppressTranscriptUntil = '';
        selectComposer(fresh);
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
      await requestStateRefresh();
    }
    // Nothing new showed up. Clear the suppress gate so whatever the server
    // reports renders (rather than leaving the screen blank), and fall back to
    // the folder's active agent when one is known.
    suppressTranscriptUntil = '';
    const activeAgent = (folder.agents || []).find((a) => a && a.composerId && a.isActive)
      || (folder.agents || []).find((a) => a && a.composerId);
    if (activeAgent && activeAgent.composerId) selectComposer(activeAgent.composerId);
    renderAll();
  }

  function findUnknownComposer(folders, knownIds) {
    for (const f of folders) {
      for (const a of (f.agents || [])) {
        if (a && a.composerId && !knownIds.has(a.composerId)) return a.composerId;
      }
    }
    return '';
  }


  async function chooseSlashCommand(opt) {
    const result = await sendCommandAwaitResult('command:click_slash_command', {
      commandId: newCommandId(),
      type: 'click_slash_command',
      slashId: opt.id,
      slashIndex: opt.index,
      // Pass the active filter so the server re-opens the SAME filtered list if
      // the tray was lost between the read and the click.
      slashQuery: (slashRenderedQuery || '').trim(),
    });
    if (!result.ok) {
      showToast(result.error || 'Could not run command', 'error');
      return;
    }
    recordSlashUsage(opt.id || opt.label);
    closeSheet({ keepSlashMenu: true });
    const composerText = (result.data && result.data.composerText) || '';
    // Mirror the host composer: prefill what the slash command left behind so
    // the user can append a prompt (or just hit Send for command-only actions).
    $input.value = composerText;
    $input.dispatchEvent(new Event('input'));
    composerPrefilledText = (composerText && composerText.trim()) ? composerText : '';
    if (composerText) {
      showToast(`/${opt.label || opt.id} — add your prompt`, 'success');
      $input.focus();
    } else {
      showToast(`/${opt.label || opt.id} applied`, 'success');
    }
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    $toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // Pre-request notification permission on the first user interaction — browsers
  // require a user gesture for this, and we can't rely on one existing at the
  // moment the agent finishes (usually while the tab is backgrounded).
  function primeNotificationPermission() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      notificationPermission = Notification.permission;
      return;
    }
    try {
      Notification.requestPermission().then(function (perm) {
        notificationPermission = perm;
      });
    } catch (_) { /* ignore */ }
  }
  ['pointerdown', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, primeNotificationPermission, { once: true });
  });
  // Same first-user-gesture hook unlocks the Web Audio context below, so the
  // in-page chime can play later even though it fires without a gesture.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    window.addEventListener(evt, unlockAudio, { once: true });
  });

  /**
   * Short in-page sounds. Browsers cannot attach a custom sound to a push, and
   * a service worker cannot play audio at all, so this is the only way to give
   * an audible cue — and it works even while the app is focused (when the OS
   * notification is suppressed). Synthesized with the Web Audio API rather than
   * shipping an asset, and deliberately quiet (low gain).
   *
   * Autoplay policy requires a prior user gesture on the page, which the
   * unlock listeners above provide; if that never happened, `state` stays
   * 'suspended' and the sounds are silently skipped.
   */
  let audioContext = null;
  function unlockAudio() {
    if (typeof window === 'undefined' || (!window.AudioContext && !window.webkitAudioContext)) return;
    try {
      if (!audioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioContext = new Ctx();
      }
      if (audioContext.state === 'suspended') void audioContext.resume();
    } catch (_) { /* ignore */ }
  }

  /**
   * Play a sequence of tones: [frequency, offsetSeconds, durationSeconds, peakGain].
   * Shared by the finished and "needs you" motifs so they stay consistent and
   * easy to retune.
   */
  function playTones(tones, type) {
    if (!audioContext || audioContext.state !== 'running') return;
    try {
      const now = audioContext.currentTime;
      tones.forEach(function (tone) {
        const freq = tone[0];
        const offset = tone[1] || 0;
        const duration = tone[2] || 0.16;
        const peak = tone[3] || 0.14;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = type || 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(peak, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(now + offset);
        osc.stop(now + offset + duration + 0.04);
      });
    } catch (_) { /* ignore */ }
  }

  /** "The agent finished": two ascending sine blips. */
  function playChime() {
    playTones([[880, 0], [1174.66, 0.14]]);
  }

  /**
   * "The agent needs you" (asked a question / wants approval): a rising
   * three-note triangle motif. Deliberately distinct from the finished chime —
   * different timbre and a longer, more insistent shape — so a glance-free
   * listener can tell "it wants something" from "it's done".
   */
  function playAlertChime() {
    playTones([
      [659.25, 0, 0.14, 0.16],
      [987.77, 0.16, 0.14, 0.16],
      [1318.51, 0.32, 0.24, 0.16],
    ], 'triangle');
  }

  // --- Web Push (real notifications via service worker + VAPID) ---
  // Needed so notifications arrive when the page is backgrounded/closed,
  // which the in-page Notification API cannot do on mobile.
  let pushReady = false;
  let pushSubscribed = false;
  let pushPublicKey = '';

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)
      || typeof window.PushManager === 'undefined') {
      return false;
    }
    // Service workers + Push require a secure context. localhost counts as
    // secure; a plain-http LAN IP (e.g. http://192.168.x.x) does not.
    return window.isSecureContext !== false;
  }

  function insecureContext() {
    return typeof window.isSecureContext !== 'undefined' && !window.isSecureContext;
  }

  async function initPush() {
    if (!pushSupported()) return;
    try {
      var reg = await navigator.serviceWorker.register('sw.js');
      pushReady = true;
      var res = await fetch('/api/push/public-key');
      if (!res.ok) return;
      var data = await res.json();
      pushPublicKey = (data && data.publicKey) || '';
      if (!pushPublicKey) return;
      // Reflect an existing subscription (no prompt).
      var existing = await reg.pushManager.getSubscription();
      pushSubscribed = !!existing;
      if (existing) {
        try {
          await syncPushSubscription(existing);
        } catch (e) {
          // Browser holds a subscription the server does not (or cannot store).
          // Reflect reality so the user can re-enable instead of being told "ON".
          pushSubscribed = false;
        }
      }
    } catch (e) {
      // Push is optional; ignore failures (e.g. insecure origin).
    }
  }

  // Encode a raw key buffer as base64url, the format the server expects.
  function b64urlFromBuffer(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return window.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Some Chromium builds expose `PushSubscription.toJSON()`, but not all of
  // them (and Vanadium has been seen without it). Falling back to getKey() +
  // base64url keeps subscription working instead of throwing into a silent
  // catch that left the UI claiming "ON" while the server had nothing.
  function subscriptionToPayload(sub) {
    if (typeof sub.toJSON === 'function') {
      try {
        var j = sub.toJSON();
        if (j && j.endpoint && j.keys && j.keys.p256dh && j.keys.auth) return j;
      } catch (_) { /* fall through to getKey */ }
    }
    var p256dh = typeof sub.getKey === 'function' ? sub.getKey('p256dh') : null;
    var auth = typeof sub.getKey === 'function' ? sub.getKey('auth') : null;
    return {
      endpoint: sub.endpoint,
      keys: {
        p256dh: p256dh ? b64urlFromBuffer(p256dh) : '',
        auth: auth ? b64urlFromBuffer(auth) : '',
      },
    };
  }

  async function syncPushSubscription(sub) {
    var json = subscriptionToPayload(sub);
    if (!json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) {
      throw new Error('could not read push keys from this browser');
    }
    var res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    // Surface server-side rejection instead of silently pretending to be
    // subscribed (the UI used to claim "ON" even when the POST failed).
    if (!res.ok) {
      var detail = '';
      try { detail = (await res.json()).error || ''; } catch (_) { /* ignore */ }
      throw new Error('server rejected subscription' + (detail ? ': ' + detail : ''));
    }
  }

  async function enablePush() {
    if (!pushSupported()) {
      showToast('Push not supported in this browser', 'error');
      return;
    }
    try {
      var perm = await Notification.requestPermission();
      notificationPermission = perm;
      if (perm !== 'granted') {
        showToast('Notifications blocked — allow them in browser settings', 'error');
        return;
      }
      var reg = await navigator.serviceWorker.ready;
      if (!pushPublicKey) {
        var res = await fetch('/api/push/public-key');
        var data = await res.json();
        pushPublicKey = (data && data.publicKey) || '';
      }
      if (!pushPublicKey) {
        showToast('Push is not enabled on the server', 'error');
        return;
      }
      var sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushPublicKey),
      });
      await syncPushSubscription(sub);
      pushSubscribed = true;
      showToast('Push notifications enabled', 'success');
      renderNotifySheet();
    } catch (e) {
      showToast('Could not enable push: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  async function disablePush() {
    if (!pushSupported()) return;
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) {
        var endpoint = sub.endpoint;
        await sub.unsubscribe();
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      }
      pushSubscribed = false;
      showToast('Push notifications disabled', 'success');
      renderNotifySheet();
    } catch (e) {
      showToast('Could not disable push', 'error');
    }
  }

  function renderNotifySheet() {
    if (!$notifyStatus || !$btnNotifyToggle) return;
    var pwa = typeof window.matchMedia === 'function'
      && window.matchMedia('(display-mode: standalone)').matches;
    var statusText;
    if (insecureContext()) {
      $notifyStatus.textContent =
        'Notifications need a secure (HTTPS) connection. Open this app over HTTPS ' +
        '(e.g. a tunnel or reverse proxy with a certificate), or use localhost on this device.';
      $btnNotifyToggle.disabled = true;
      $btnNotifyToggle.textContent = 'HTTPS required';
      return;
    }
    if (!pushSupported()) {
      statusText = 'Push is not supported in this browser.';
      $btnNotifyToggle.disabled = true;
      $btnNotifyToggle.textContent = 'Unavailable';
    } else if (pushSubscribed) {
      statusText = 'Push notifications are ON for this device.';
      $btnNotifyToggle.disabled = false;
      $btnNotifyToggle.textContent = 'Turn off';
      $btnNotifyToggle.classList.add('notify-toggle-off');
    } else {
      statusText = 'Push notifications are OFF for this device.';
      $btnNotifyToggle.disabled = false;
      $btnNotifyToggle.textContent = 'Enable notifications';
      $btnNotifyToggle.classList.remove('notify-toggle-off');
    }
    $notifyStatus.textContent = statusText;
    $notifyHint.textContent = pwa
      ? 'You will be notified when the agent asks a question, needs approval, or finishes. '
        + 'A big green banner also appears in the app when the agent finishes, even without push.'
      : 'Tip: add this app to your Home Screen for reliable notifications. '
        + 'You will be notified when the agent asks a question, needs approval, or finishes. '
        + 'A big green banner also appears in the app when the agent finishes, even without push.';
  }

  if ($btnNotify) {
    $btnNotify.addEventListener('click', () => openSheet('notify'));
  }
  if ($btnNotifyToggle) {
    $btnNotifyToggle.addEventListener('click', () => {
      if (pushSubscribed) void disablePush();
      else void enablePush();
    });
  }
  void initPush();

  } // end bootstrap

  init();
})();
