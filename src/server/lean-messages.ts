import type { ChatElement } from './types.js';

/**
 * Drop rendered HTML from every assistant bubble except the newest one.
 *
 * The live DOM only mounts a handful of rows, but each still carries a full
 * `.markdown-root` innerHTML blob. Older rows are almost always already in
 * `history:page` / `history:full` on the phone; keeping their HTML on every
 * poll/upsert is pure waste. The trailing assistant keeps `html` so streaming
 * updates still render richly.
 */
export function stripNonTailAssistantHtml(messages: ChatElement[]): ChatElement[] {
  if (!messages || messages.length === 0) return messages;

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return messages;

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.type !== 'assistant' || i === lastAssistant) return m;
    if (!m.html) return m;
    changed = true;
    return { ...m, html: '' };
  });
  return changed ? out : messages;
}
