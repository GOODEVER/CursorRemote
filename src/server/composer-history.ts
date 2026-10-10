import type { ChatElement, PlanTodo, ToolCallElement } from './types.js';
import { markdownToWebHtml } from './plan-files.js';

/**
 * Reads the FULL chat transcript for a composer from Cursor's global SQLite
 * store (`state.vscdb`).
 *
 * Why this exists: Cursor virtualizes the transcript DOM
 * (`virtualized-composer-messages-scroll-container`) and only mounts a handful
 * of message nodes at any scroll position, so `dom-extractor` can never return
 * more than ~6-13 messages no matter how long the chat is. The complete,
 * ordered history lives in the `cursorDiskKV` table as:
 *   - `composerData:<composerId>` → `fullConversationHeadersOnly[]` (ordered
 *     list of `{ bubbleId, type, grouping }`, including per-tool display hints)
 *   - `bubbleId:<composerId>:<bubbleId>` → the full bubble body (`text`,
 *     `richText`, `toolFormerData`, `assistantSuggestedDiffs`, …)
 *
 * We read both, join headers to bodies, and map to the shared `ChatElement`
 * union the web client already renders. This is a read-only, best-effort
 * source; any failure returns `null` so the relay silently falls back to DOM
 * extraction.
 */

type PreparedStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
};
type SqliteDatabase = {
  prepare: (sql: string) => PreparedStatement;
  close: () => void;
};
type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase;

let cachedCtor: DatabaseSyncCtor | null = null;
let ctorLoadFailed = false;

async function getDatabaseCtor(): Promise<DatabaseSyncCtor | null> {
  if (cachedCtor) return cachedCtor;
  if (ctorLoadFailed) return null;
  try {
    const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: DatabaseSyncCtor };
    cachedCtor = mod.DatabaseSync;
    return cachedCtor;
  } catch {
    ctorLoadFailed = true;
    return null;
  }
}

export interface ComposerHistoryResult {
  composerId: string;
  name: string;
  /** Chronological transcript, oldest first. */
  messages: ChatElement[];
  /** Total number of headers Cursor has for this composer. */
  total: number;
  /** True when older messages were dropped to honor `maxMessages`. */
  truncated: boolean;
}

export interface ComposerHistoryOptions {
  /** Path to Cursor's `state.vscdb`. Empty disables history loading. */
  dbPath: string;
  /** Keep at most this many trailing messages (0 = unlimited). Default 500. */
  maxMessages?: number;
  /** TTL for the per-composer result cache. Default 5000ms. */
  cacheTtlMs?: number;
  /** Max cached composers; LRU beyond this is dropped. Default 4. */
  cacheMaxEntries?: number;
}

interface RawHeader {
  bubbleId?: string;
  type?: number;
  grouping?: Record<string, unknown>;
}

interface RawBubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  richText?: string;
  toolFormerData?: {
    toolCallId?: string;
    name?: string;
    params?: string;
    result?: string;
    status?: string;
  } | null;
  allThinkingBlocks?: unknown;
  codeBlocks?: unknown;
  contextPieces?: unknown;
}

const DEFAULT_MAX_MESSAGES = 500;
const DEFAULT_CACHE_TTL_MS = 5000;
/** Bound the number of cached transcripts: each entry can hold up to
 * maxMessages mapped ChatElements (incl. rendered HTML), so an unbounded map
 * grows the heap by tens of MB per visited composer and never lets go
 * (observed: multi-GB heap after hours of browsing folders). */
const DEFAULT_CACHE_MAX_ENTRIES = 4;
/** Per-message text cap. Tool dumps in cursorDiskKV can be several MB each;
 * past a few thousand chars they are unreadable in the chat view anyway. */
const MAX_MESSAGE_TEXT_CHARS = 8000;
/** Total mapped-transcript char budget. Large histories of tool-heavy agent
 * chats previously pushed the heap past its cap when mapped+cached. */
const MAX_TOTAL_HISTORY_CHARS = 600_000;

const TOOL_LABELS: Record<string, string> = {
  read_file_v2: 'Read file',
  read_file: 'Read file',
  ripgrep_raw_search: 'Search',
  grep_search: 'Search',
  glob_file_search: 'Find files',
  list_dir: 'List files',
  run_terminal_command_v2: 'Run command',
  run_terminal_cmd: 'Run command',
  edit_file_v2: 'Edit file',
  edit_file: 'Edit file',
  apply_patch: 'Apply patch',
  todo_write: 'Update todos',
  web_search: 'Web search',
  fetch_rules: 'Fetch rules',
  create_goal: 'Create goal',
  update_goal: 'Update goal',
  task_v2: 'Run task',
  ask_question: 'Ask question',
  get_mcp_tools: 'Discover tools',
};

/** Composer ids are uuids; keep the guard cheap but strict. */
const COMPOSER_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

export class ComposerHistory {
  private dbPath: string;
  private maxMessages: number;
  private cacheTtlMs: number;
  private cacheMaxEntries: number;
  private cache = new Map<string, { at: number; result: ComposerHistoryResult | null }>();

  constructor(options: ComposerHistoryOptions) {
    this.dbPath = options.dbPath;
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheMaxEntries = Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
  }

  /** True when a database path is configured (loading is otherwise disabled). */
  get enabled(): boolean {
    return this.dbPath.length > 0;
  }

  /** Drop the cache for a composer (or all) — call after switching/opening. */
  invalidate(composerId?: string): void {
    if (composerId) this.cache.delete(composerId);
    else this.cache.clear();
  }

  async getHistory(composerId: string): Promise<ComposerHistoryResult | null> {
    if (!this.enabled || !COMPOSER_ID_RE.test(composerId)) return null;

    const now = Date.now();
    const cached = this.cache.get(composerId);
    if (cached && now - cached.at < this.cacheTtlMs) {
      // LRU touch: re-insert so the entry counts as most-recent.
      this.cache.delete(composerId);
      this.cache.set(composerId, cached);
      return cached.result;
    }

    let result: ComposerHistoryResult | null = null;
    try {
      result = await this.readComposer(composerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[composer-history] Failed to read ${composerId.substring(0, 8)}: ${msg}`);
      result = null;
    }
    this.cache.set(composerId, { at: now, result });
    this.evictOverLimit(composerId);
    return result;
  }

  /** Keep the newest `cacheMaxEntries` entries (LRU by insertion order). */
  private evictOverLimit(justInserted: string): void {
    while (this.cache.size > this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      if (oldestKey === justInserted) break; // never evict the entry we just set
      this.cache.delete(oldestKey);
    }
  }

  private async readComposer(composerId: string): Promise<ComposerHistoryResult | null> {
    const Ctor = await getDatabaseCtor();
    if (!Ctor) return null;

    const db = new Ctor(this.dbPath, { readOnly: true });
    try {
      const composerRow = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${composerId}`);
      if (!composerRow || typeof composerRow.value !== 'string') return null;

      const composer = safeParse<{ name?: string; fullConversationHeadersOnly?: RawHeader[] }>(
        composerRow.value
      );
      if (!composer) return null;

      const headers = Array.isArray(composer.fullConversationHeadersOnly)
        ? composer.fullConversationHeadersOnly
        : [];
      const total = headers.length;

      const startIndex =
        this.maxMessages > 0 && total > this.maxMessages ? total - this.maxMessages : 0;
      const window = headers.slice(startIndex);
      if (window.length === 0) {
        return { composerId, name: composer.name ?? '', messages: [], total, truncated: false };
      }

      // Fetch each bubble body individually with a prepared statement instead
      // of one `LIKE` sweep. The LIKE sweep materialized EVERY row for the
      // composer in one array — long agent chats hold hundreds of MB of tool
      // output in cursorDiskKV, which spiked the heap past its cap and OOM'd
      // the relay. Per-key lookups only touch the windowed rows.
      const bubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      const prefix = `bubbleId:${composerId}:`;
      const messages: ChatElement[] = [];
      let totalChars = 0;
      for (let i = 0; i < window.length; i++) {
        const header = window[i];
        if (!header || typeof header.bubbleId !== 'string' || !header.bubbleId) continue;
        const grouping = header.grouping ?? {};
        if (grouping.isRenderable === false) continue;

        let bubble: RawBubble | null = null;
        try {
          const row = bubbleStmt.get(prefix + header.bubbleId);
          if (row && typeof row.value === 'string') bubble = safeParse<RawBubble>(row.value);
        } catch {
          /* missing/corrupt body → treat as null */
        }
        const mapped = mapHeader(header, bubble, startIndex + i);
        if (!mapped) continue;
        // Drop enormous text payloads (crashed tool dumps etc.) — they are not
        // readable in the chat view anyway and each one can be several MB.
        if (mapped.type === 'assistant') {
          const text = mapped.text;
          if (text.length > MAX_MESSAGE_TEXT_CHARS) {
            mapped.text = text.slice(0, MAX_MESSAGE_TEXT_CHARS) + '…';
            mapped.html = markdownToWebHtml(mapped.text);
          }
        } else if (mapped.type === 'thought' && mapped.detail && mapped.detail.length > MAX_MESSAGE_TEXT_CHARS) {
          mapped.detail = mapped.detail.slice(0, MAX_MESSAGE_TEXT_CHARS) + '…';
        }
        totalChars += mapped.type === 'assistant' ? mapped.text.length : (mapped as { detail?: string }).detail?.length ?? 0;
        messages.push(mapped);
        // Hard stop if the mapped transcript would exceed the byte budget.
        if (totalChars > MAX_TOTAL_HISTORY_CHARS) break;
      }

      return {
        composerId,
        name: composer.name ?? '',
        messages,
        total,
        truncated: startIndex > 0,
      };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function baseName(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

function truncate(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Resolve a human label for a tool from its machine name. */
function toolLabel(name: string, caseKind: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  // MCP tools are namespaced as `mcp-<provider>-<tool>` (e.g. `mcp-cursor-ide-browser-browser_navigate`).
  const mcpMatch = name.match(/^mcp-.*?-([a-z0-9_]+)$/i);
  if (mcpMatch) {
    const tool = mcpMatch[1].replace(/_/g, ' ').trim();
    return tool ? `${tool.charAt(0).toUpperCase()}${tool.slice(1)}` : 'MCP tool';
  }
  if (caseKind === 'editToolCall') return 'Edit file';
  if (caseKind === 'shellToolCall') return 'Run command';
  if (caseKind === 'readToolCall') return 'Read file';
  if (caseKind === 'grepToolCall' || caseKind === 'globToolCall') return 'Search';
  if (caseKind === 'taskToolCall') return 'Run task';
  if (caseKind === 'mcpToolCall') return 'MCP tool';
  return name ? name.replace(/_/g, ' ') : 'Tool';
}

function mapHeader(
  header: RawHeader,
  bubble: RawBubble | null,
  flatIndex: number
): ChatElement | null {
  const bubbleId = header.bubbleId as string;
  const grouping = header.grouping ?? {};
  const caseKind = str(grouping.toolCallCase);

  if (header.type === 1) {
    const text = str(bubble?.text) || str(grouping.textPreview);
    return {
      type: 'human',
      id: bubbleId,
      flatIndex,
      text,
      mentions: [],
    };
  }

  const tool = bubble?.toolFormerData;
  if (tool && tool.name) {
    const todos = mapTodoWrite(tool, grouping, bubbleId, flatIndex);
    if (todos) return todos;
    return mapTool(tool, grouping, caseKind, bubbleId, flatIndex);
  }

  const thoughts = mapThinkingBlocks(bubble, bubbleId, flatIndex);
  const text = (str(bubble?.text) || str(grouping.textPreview)).trim();
  const assistant = text
    ? {
        type: 'assistant' as const,
        id: bubbleId,
        flatIndex,
        text,
        html: markdownToWebHtml(text),
        codeBlocks: [],
      }
    : null;

  // Prefer thinking blocks when the bubble carries no visible text (rare).
  if (!assistant && thoughts.length > 0) return thoughts[0];
  return assistant;
}

function mapTodoWrite(
  tool: NonNullable<RawBubble['toolFormerData']>,
  grouping: Record<string, unknown>,
  bubbleId: string,
  flatIndex: number
): ChatElement | null {
  if (tool.name !== 'todo_write' && grouping.toolCallCase !== 'updateTodosToolCall') return null;
  const params = tool.params ? safeParse<{ todos?: unknown }>(tool.params) : null;
  const raw = params && Array.isArray(params.todos) ? params.todos : [];
  const todos: PlanTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const content = str(record.content) || str(record.text);
    if (!content) continue;
    const status = str(record.status);
    todos.push({
      text: content,
      status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
    });
  }
  if (todos.length === 0) return null;
  return {
    type: 'todo_list',
    id: bubbleId,
    flatIndex,
    title: 'Todos',
    todosCompleted: todos.filter((t) => t.status === 'completed').length,
    todosTotal: todos.length,
    todos,
  };
}

function mapTool(
  tool: NonNullable<RawBubble['toolFormerData']>,
  grouping: Record<string, unknown>,
  caseKind: string,
  bubbleId: string,
  flatIndex: number
): ToolCallElement {
  const name = tool.name ?? '';
  const params = tool.params ? safeParse<Record<string, unknown>>(tool.params) : null;
  const displayPath = str(grouping.toolDisplayPath);
  const isEdit = caseKind === 'editToolCall' || name === 'edit_file_v2' || name === 'edit_file';
  const isShell = caseKind === 'shellToolCall' || /terminal/.test(name);
  const status =
    tool.status === 'loading' || grouping.toolFormerStatus === 'loading' ? 'loading' : 'completed';

  const toolCallId = tool.toolCallId || str(grouping.toolCallId) || bubbleId;

  const element: ToolCallElement = {
    type: 'tool',
    id: `tool:${toolCallId}`,
    flatIndex,
    toolCallId,
    status,
    action: toolLabel(name, caseKind),
    details: '',
    actions: [],
  };

  if (displayPath) element.filename = baseName(displayPath);

  if (isEdit) {
    element.filename = baseName(displayPath) || element.filename;
    const additions = num(grouping.editLinesAdded);
    const deletions = num(grouping.editLinesRemoved);
    if (additions !== undefined) element.additions = additions;
    if (deletions !== undefined) element.deletions = deletions;
  } else if (isShell) {
    const command = str(params?.command);
    if (command) element.details = truncate(command, 180);
  } else {
    element.details = toolDetail(name, params, displayPath);
  }

  return element;
}

function toolDetail(
  name: string,
  params: Record<string, unknown> | null,
  displayPath: string
): string {
  if (!params) return displayPath ? baseName(displayPath) : '';
  const direct =
    str(params.pattern) ||
    str(params.globPattern) ||
    str(params.searchTerm) ||
    str(params.query) ||
    str(params.question) ||
    str(params.title);
  if (direct) return truncate(direct, 160);
  const p =
    str(params.targetFile) ||
    str(params.relativeWorkspacePath) ||
    str(params.effectiveUri) ||
    str(params.path);
  if (p) return baseName(p);
  if (displayPath) return baseName(displayPath);
  return '';
}

function mapThinkingBlocks(
  bubble: RawBubble | null,
  bubbleId: string,
  flatIndex: number
): ChatElement[] {
  const raw = bubble?.allThinkingBlocks;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: ChatElement[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const text = str(record.text) || str(record.thinking) || str(record.content);
    if (!text.trim()) return;
    out.push({
      type: 'thought',
      id: `${bubbleId}-t${i}`,
      flatIndex,
      duration: str(record.duration),
      detail: text.trim(),
      thoughtKind: 'thinking_step',
    });
  });
  return out;
}
