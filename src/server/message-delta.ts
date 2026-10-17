import type { ChatElement, MessageDelta } from './types.js';

export type { MessageDelta };

export type MessagePatchResult =
  | { kind: 'none' }
  | { kind: 'full'; messages: ChatElement[] }
  | { kind: 'delta'; messageDelta: MessageDelta };

/** Prefer a full replace when this many rows changed — deltas stop winning. */
export const MESSAGE_DELTA_UPSERT_CAP = 16;

/**
 * Diff two transcript arrays into either a full replace or a compact delta.
 *
 * `differs` is the structural equality check (typically SignatureCache.differs)
 * so streaming edits to the same id are detected without a second stringify
 * strategy here.
 */
export function computeMessagePatch(
  prev: ChatElement[],
  next: ChatElement[],
  differs: (a: unknown, b: unknown) => boolean
): MessagePatchResult {
  if (prev === next) return { kind: 'none' };
  if (!differs(prev, next)) return { kind: 'none' };

  // Empty → something, or something → empty: full replace is simplest and
  // keeps cold-start / clear-chat paths on the legacy `messages` field.
  if (prev.length === 0 || next.length === 0) {
    return { kind: 'full', messages: next };
  }

  const prevById = new Map<string, ChatElement>();
  for (const m of prev) prevById.set(m.id, m);

  const nextIds = new Set<string>();
  for (const m of next) nextIds.add(m.id);

  const removeIds: string[] = [];
  for (const m of prev) {
    if (!nextIds.has(m.id)) removeIds.push(m.id);
  }

  const upsert: ChatElement[] = [];
  for (const m of next) {
    const old = prevById.get(m.id);
    if (!old || differs(old, m)) upsert.push(m);
  }

  // No shared ids ⇒ different chat mounted; full replace.
  if (removeIds.length === prev.length && upsert.length === next.length) {
    return { kind: 'full', messages: next };
  }

  if (upsert.length > MESSAGE_DELTA_UPSERT_CAP || upsert.length > next.length / 2) {
    return { kind: 'full', messages: next };
  }

  const appendOnly = isAppendOnlyPrefix(prev, next, removeIds);
  const order = appendOnly ? undefined : next.map((m) => m.id);

  return {
    kind: 'delta',
    messageDelta: { upsert, removeIds, ...(order ? { order } : {}) },
  };
}

/**
 * True when `next` keeps every surviving previous id in the same relative
 * order at the front, and only adds/replaces at the trailing edge — the
 * streaming path (last assistant bubble grows, or a new tool row appears).
 */
function isAppendOnlyPrefix(
  prev: ChatElement[],
  next: ChatElement[],
  removeIds: string[]
): boolean {
  if (removeIds.length > 0) return false;
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].id !== next[i].id) return false;
  }
  return true;
}

/**
 * Apply a message delta to a local transcript (same rules as the web client).
 * Exported for unit tests so server and phone stay aligned.
 */
export function applyMessageDelta(
  messages: ChatElement[],
  delta: MessageDelta
): ChatElement[] {
  const remove = new Set(delta.removeIds ?? []);
  let msgs = remove.size > 0 ? messages.filter((m) => !remove.has(m.id)) : messages.slice();

  const byId = new Map<string, ChatElement>();
  for (const m of msgs) byId.set(m.id, m);
  for (const m of delta.upsert ?? []) byId.set(m.id, m);

  if (delta.order && delta.order.length > 0) {
    const ordered: ChatElement[] = [];
    const seen = new Set<string>();
    for (const id of delta.order) {
      const m = byId.get(id);
      if (m) {
        ordered.push(m);
        seen.add(id);
      }
    }
    for (const m of delta.upsert ?? []) {
      if (!seen.has(m.id)) ordered.push(m);
    }
    return ordered;
  }

  // Append-only path: replace existing ids in place, append unknown ids.
  msgs = msgs.slice();
  for (const m of delta.upsert ?? []) {
    const idx = msgs.findIndex((x) => x.id === m.id);
    if (idx >= 0) msgs[idx] = m;
    else msgs.push(m);
  }
  return msgs;
}
