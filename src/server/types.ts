// Core relay state and chat element typings.
export interface CursorWindow {
  id: string;
  title: string;
  url: string;
  wsUrl?: string;
}

/**
 * Working-state glyph Cursor renders on an agent's sidebar row, read straight
 * from its status icon. `working` = the animated dot-grid loader is present;
 * the rest come from the row's `ui-agent-status-dot` / aria-label. Null when the
 * row exposes no status glyph (e.g. "No agents yet").
 */
export type FolderAgentStatus =
  | 'working'
  | 'needs_attention'
  | 'error'
  | 'completed'
  | 'draft'
  | null;

/**
 * A chat/agent entry listed under a workspace folder.
 * Mirrors the sidebar rows in Cursor's "Cursor Agents" overview window.
 */
export interface FolderAgent {
  /** Sidebar row label, e.g. "Roblox factory game design". */
  title: string;
  /** data-composer-id when Cursor exposes one (used to switch reliably). */
  composerId: string;
  /** Stable section group id, e.g. "workspace:<hash>" or "repo:github.com/x/y". */
  sectionId: string;
  /** True for the agent currently open in this window. */
  isActive: boolean;
  /**
   * Per-agent working state straight from Cursor's own status glyph. This is the
   * authoritative source: unlike the per-window snapshot (which only knows the
   * active agent of each window), Cursor renders a status on EVERY sidebar row,
   * so multiple agents working at once each show their own loader.
   */
  agentStatus?: FolderAgentStatus;
  /** DOM selector path for the row, used as a switch fallback. */
  selectorPath: string;
}

/**
 * A workspace folder / repository as listed in Cursor's agent sidebar.
 * Cursor groups its chats under these; only some folders are currently open.
 */
export interface WorkspaceFolder {
  /** Display name, e.g. "FactoryTycoonGame" or "cursorremote". */
  name: string;
  /** Stable section group id ("workspace:…" / "repo:…"), used as a key. */
  sectionId: string;
  /** 'workspace' for local folders, 'repo' for git repositories. */
  kind: 'workspace' | 'repo';
  /** True when this folder is the one open in the relay's home window. */
  isCurrent: boolean;
  /** Agents/chats belonging to this folder. */
  agents: FolderAgent[];
}

/** Raw DOM element snapshot — what was actually in the DOM, independent of parsing. */
export interface RawElement {
  flatIndex: number;
  role?: string;
  kind?: string;
  messageId?: string;
  toolCallId?: string;
  toolStatus?: string;
  /** Key CSS class/element indicators found on this wrapper. */
  indicators: string[];
  /** First ~120 chars of textContent. */
  textPreview: string;
  /** What ChatElement type the parser decided this was (or 'skipped'). */
  parsedAs: string;
}

export interface RawSignals {
  shimmer: Array<{ text: string; inToolCall: boolean; inHeader: boolean }>;
  loadingIndicator: boolean;
  statusEl?: { text: string; classes: string };
  /** Per-element DOM inventory — raw attributes and indicator classes for every [data-flat-index]. */
  elements: RawElement[];
  /** Activity-related elements NOT inside any [data-flat-index] wrapper. */
  orphanIndicators: Array<{ cls: string; text: string; parentCls: string }>;
}

export interface ComposerQueueItem {
  id: string;
  text: string;
  /**
   * Anchored selector for this row's "Send now" control
   * (`[data-queue-action="send"|"steer"]` inside the row), used by the web
   * client to submit the message immediately without waiting for the queue.
   * Only present for the older toolbar shape; newer builds hover the row and
   * target the action by id/action instead (see ComposerQueueState.kind).
   */
  sendSelectorPath?: string;
  /** Anchored selector for this row's remove (✕) control. */
  removeSelectorPath?: string;
}

/**
 * Which of Cursor's two queue UIs is present, so the client knows how to act:
 *  - 'tray': newer `.ui-tray--queued` rows whose action buttons mount only on
 *    hover; the client asks the server to hover+click by row id and action.
 *  - 'toolbar': older `#composer-toolbar-section` rows with stable per-row
 *    selector paths the client can click directly.
 */
export type ComposerQueueKind = 'tray' | 'toolbar';

export interface ComposerQueueState {
  items: ComposerQueueItem[];
  /** e.g. "2 Queued" from toolbar header */
  queueLabel?: string;
  /** Which queue UI is present; defaults to the legacy 'toolbar' shape. */
  kind?: ComposerQueueKind;
}

export interface QuestionnaireOption {
  letter: string;
  label: string;
  isFreeform: boolean;
  selectorPath: string;
  /**
   * For freeform ("Other") rows: a selector used to reach the inline answer
   * editor. Cursor mounts that editor INSIDE the option row only after the row
   * is clicked, so this is the stable OPTION ROW path; the executor resolves
   * the text editor inside it at submit time.
   */
  freeformInputSelectorPath?: string;
}

export interface QuestionnaireQuestion {
  number: string;
  text: string;
  options: QuestionnaireOption[];
  isActive: boolean;
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  activeIndex: number;
  totalLabel: string;
  skipSelectorPath: string;
  continueSelectorPath: string;
  continueDisabled: boolean;
}

/**
 * A `/`-triggered slash command row from Cursor's composer tray
 * (`div[role="listbox"][aria-label="Slash commands"] button[role="option"]`).
 */
export interface SlashCommand {
  /** Slash token (without the leading `/`), e.g. "code-review". */
  id: string;
  /** Human label, e.g. "Code Review". */
  label: string;
  /** Supporting description, e.g. "Review code instead of editing it". */
  description: string;
  /** True when this row is the keyboard-highlighted option. */
  selected: boolean;
  /** 1-based position, used to click by index since React ids are unstable. */
  index: number;
}

export interface CursorState {
  connected: boolean;
  /** Health of DOM extraction independent from the CDP websocket connection. */
  extractorStatus: ExtractorStatus;
  /** Timestamp of the last successful extraction in ms since epoch. */
  lastExtractionAt: number | null;
  /** Number of consecutive failed extraction attempts since the last success. */
  consecutiveExtractionFailures: number;
  /** Most recent extraction error, or null after a successful extraction/reset. */
  lastExtractionError: string | null;
  agentStatus: AgentStatus;
  /** Live activity label; null means explicitly cleared on the wire. */
  agentActivityText: string | null;
  /** True only when the server believes work is actively in progress right now. */
  agentActivityLive: boolean;
  /** Provenance of the current activity signal, for transports/debugging. */
  agentActivitySource: ActivitySource;
  /**
   * Ground-truth "the agent is currently working and can be stopped" flag.
   * Set when Cursor's own Stop control is present in the DOM (the composer
   * send↔stop toggle, a "Stop generation" button, or a running tool's
   * "Stop command" control). Unlike `agentStatus` — which oscillates between
   * `running_tool` and false `waiting_approval`/`idle` across polls — this
   * stays true for the entire turn, so clients can keep the abort control
   * visible without flicker.
   */
  canAbort: boolean;
  /**
   * True when the extracted DOM has not changed for AGENT_STALL_MS even though
   * the state still claims the agent is working. Surfaces the case where Cursor
   * has actually finished (or frozen) while the phone still shows "working", so
   * the client can nudge with a Refresh button and the server can self-heal by
   * forcing a fresh extraction. Never claimed for an idle/blocked agent.
   */
  agentStalled: boolean;
  /** Timestamp of the last content change (ms since epoch); drives agentStalled. */
  agentStalledSince: number | null;
  messages: ChatElement[];
  pendingApprovals: Approval[];
  inputAvailable: boolean;
  chatTabs: ChatTab[];
  /** data-composer-id of the active composer in the extracted DOM. Stable
   *  across windows that share an agent via Cursor's global rail; differs
   *  for two genuinely different agents that happen to share a tab title. */
  activeComposerId: string;
  mode: ModeInfo;
  model: ModelInfo;
  windows: CursorWindow[];
  activeWindowId: string;
  /** Prompts queued in composer toolbar (outside transcript). */
  composerQueue: ComposerQueueState;
  /** Agent questionnaire widget (multiple-choice questions). */
  questionnaire: Questionnaire | null;
  /**
   * `/` slash-command menu options, populated only while the menu is open in the
   * focused Cursor composer. Empty array when the menu is closed.
   */
  slashCommands: SlashCommand[];
  /**
   * All workspace folders / repositories listed in Cursor's agent sidebar,
   * including folders that are not currently open. Each folder carries its
   * agents/chats. Populated from the "Cursor Agents" overview window when it is
   * available; empty otherwise.
   */
  folders: WorkspaceFolder[];
  _rawSignals?: RawSignals;
}

export interface ChatTab {
  composerId: string;
  title: string;
  isActive: boolean;
  status: string;
  selectorPath: string;
}

export interface ModeInfo {
  current: string;
  available: { id: string; label: string; icon: string }[];
}

export interface ModelInfo {
  current: string;
  currentId: string;
}

export type ExtractorStatus = 'idle' | 'waiting' | 'ok' | 'stale';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'waiting_approval'
  | 'error';

export type ActivitySource =
  | 'none'
  | 'shimmer'
  | 'loading_tool'
  | 'loading_indicator'
  | 'tail_thought';

export type ChatElement =
  | HumanMessage
  | AssistantMessage
  | ToolCallElement
  | ThoughtBlock
  | PlanBlock
  | TodoListBlock
  | RunCommand
  | LoadingIndicator;
export interface HumanMessage {
  type: 'human';
  id: string;
  flatIndex: number;
  text: string;
  mentions: { name: string; mentionType: string }[];
  /** Quoted / reply preview from composer (e.g. ProseMirror blockquote). */
  quoted?: { text: string };
}

export type DiffLineKind = 'add' | 'rem' | 'ctx' | 'meta' | 'hunk';

/** Native web/Telegram rendering: structured code or diff (no mirrored Monaco HTML). */
export interface CodeBlockItem {
  blockKind: 'code' | 'diff';
  filename?: string;
  language?: string;
  /** Flat joined text (search, fallback, simple pre) */
  code: string;
  /** Present when blockKind === 'diff'; line-level add/rem/ctx from live Monaco DOM */
  diffLines?: { kind: DiffLineKind; text: string }[];
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  flatIndex: number;
  text: string;
  html: string;
  codeBlocks: CodeBlockItem[];
}

export interface ToolCallElement {
  type: 'tool';
  id: string;
  flatIndex: number;
  toolCallId: string;
  status: 'loading' | 'completed';
  action: string;
  details: string;
  filename?: string;
  additions?: number;
  deletions?: number;
  summaryText?: string;
  actions?: RunAction[];
  blocked?: string;
  /** Structured diff/code for edit tools; web client renders natively */
  diffBlock?: CodeBlockItem;
}

export interface ThoughtBlock {
  type: 'thought';
  id: string;
  flatIndex: number;
  duration: string;
  action?: string;
  detail?: string;
  /** Cursor step-group: umbrella row (e.g. Explored) vs inner thinking row */
  thoughtKind?: 'step_summary' | 'thinking_step';
}

export interface PlanTodo {
  text: string;
  status: 'pending' | 'completed' | 'in_progress';
}

export interface PlanAction {
  label: string;
  type: 'view_plan' | 'build';
  selectorPath: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  flatIndex: number;
  label: string;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  description?: string;
  /** Raw markdown HTML from `.composer-create-plan-text .markdown-root` (web client). */
  descriptionHtml?: string;
  todos?: PlanTodo[];
  /** Hidden todo rows behind "N more" in Cursor (estimated). */
  todosMoreCount?: number;
  model?: string;
  /** Click to open plan-scoped model dropdown in Cursor. */
  modelDropdownSelectorPath?: string;
  actions?: PlanAction[];
}

export interface PlanModelOption {
  id: string;
  label: string;
  selected?: boolean;
}

export interface PlanFullData {
  todos: PlanTodo[];
  body: string;
  bodyHtml: string;
}

export interface TodoListBlock {
  type: 'todo_list';
  id: string;
  flatIndex: number;
  title: string;
  todosCompleted: number;
  todosTotal: number;
  todos: PlanTodo[];
}

export interface RunAction {
  label: string;
  type: 'run' | 'skip' | 'allow';
  selectorPath: string;
}

export interface RunCommand {
  type: 'run_command';
  id: string;
  flatIndex: number;
  toolCallId: string;
  description: string;
  candidates: string;
  command: string;
  actions: RunAction[];
}

export interface LoadingIndicator {
  type: 'loading';
  id: string;
  flatIndex: number;
  text?: string;
}

export interface Approval {
  id: string;
  description: string;
  actions: ApprovalAction[];
}

export interface ApprovalAction {
  label: string;
  type: 'approve' | 'reject' | 'approve_all';
  selectorPath: string;
}

export interface SelectorStrategy {
  strategies: string[];
  textMatch?: string[];
}

export interface SelectorConfig {
  chatContainer: SelectorStrategy;
  approveButton: SelectorStrategy;
  rejectButton: SelectorStrategy;
  chatInput: SelectorStrategy;
  agentStatus: SelectorStrategy;
  [key: string]: SelectorStrategy;
}

export interface CommandPayload {
  commandId: string;
  type: 'send_message' | 'send_prompt' | 'approve' | 'reject' | 'approve_all' | 'switch_tab' | 'open_folder_agent' | 'create_folder_agent' | 'new_chat' | 'set_mode' | 'set_model' | 'click_action' | 'queue_action' | 'get_plan_full' | 'get_plan_model_options' | 'set_plan_model' | 'get_slash_menu' | 'click_slash_command' | 'cancel_slash_menu' | 'set_answer_text' | 'stop_generation' | 'refresh_state';
  /** For 'queue_action': the queued row id and the action to run on it. */
  queueItemId?: string;
  queueAction?: 'send' | 'remove';
  text?: string;
  approvalId?: string;
  actionType?: string;
  selectorPath?: string;
  actionLabel?: string;
  composerId?: string;
  modeId?: string;
  modelId?: string;
  planLabel?: string;
  planModelId?: string;
  tabTitle?: string;
  windowId?: string;
  /** Target folder section (Cursor agent overview) for create_folder_agent. */
  sectionId?: string;
  /** Folder display name, fallback when sectionId lookup fails. */
  folderName?: string;
  /** Slash token (without leading "/") targeted by click_slash_command. */
  slashId?: string;
  /** 1-based index of the slash row, fallback when slashId is ambiguous. */
  slashIndex?: number;
}

export interface CommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface ServerConfig {
  cdpUrl: string;
  serverPort: number;
  serverHost: string;
  pollIntervalMs: number;
  /**
   * Poll interval used once the DOM has settled and the agent is idle. An idle
   * Cursor is the common steady state, so dropping to this slower cadence cuts
   * the CDP/DOM read cost dramatically without an idle session feeling laggy.
   * Set <= `pollIntervalMs` to disable idle backoff (always poll at the base
   * rate). Any content change, agent activity, or user command snaps back to
   * `pollIntervalMs` immediately.
   */
  idlePollIntervalMs: number;
  debounceMs: number;
  selectorsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  webappPassword: string;
  windowTitleQualifier: boolean;
  dataDir: string;
  /**
   * Absolute path to Cursor's global SQLite store (`state.vscdb`). Used to read
   * the FULL chat transcript (Cursor virtualizes the DOM and only mounts a few
   * messages, so the DOM alone can never yield full history). Empty string
   * disables history loading.
   */
  cursorStateDb: string;
  /**
   * Max messages restored from the full-history source (0 = unlimited). Cursor
   * mounts only a handful of transcript nodes, so this bounds how much of a very
   * long chat is sent to the client on switch.
   */
  historyMaxMessages: number;
  webPush: WebPushConfig;
  telegram: TelegramConfig;
  /** Native TLS settings for the web server (https/wss). */
  tls: TlsConfig;
  /**
   * Trust `X-Forwarded-*` headers from a fronting reverse proxy so client IPs
   * and protocol detection are correct when TLS is terminated upstream.
   */
  trustProxy: boolean;
}

export interface WebPushConfig {
  enabled: boolean;
  /** VAPID contact (mailto: or https: URL) required by push services. */
  subject: string;
}

/**
 * Native TLS termination for the relay's web server. When `enabled`, the server
 * listens with https/wss using the PEM files named here instead of plain http.
 * Leave disabled to terminate TLS at a reverse proxy instead (set trustProxy).
 */
export interface TlsConfig {
  enabled: boolean;
  /** Path to the PEM certificate (or full chain, e.g. Let's Encrypt fullchain.pem). */
  certPath: string;
  /** Path to the PEM private key (e.g. Let's Encrypt privkey.pem). */
  keyPath: string;
  /** Optional PEM CA chain appended to the served chain (rarely needed). */
  caPath: string;
  /**
   * Passphrase for an encrypted private key, if any. Read from
   * TLS_KEY_PASSPHRASE in the environment and never persisted to disk.
   */
  passphrase: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  preRegisteredUsers: number[];
  impl: 'grammy' | 'raw';
}
