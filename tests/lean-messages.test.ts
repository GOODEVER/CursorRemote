import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripNonTailAssistantHtml } from '../src/server/lean-messages.js';
import type { ChatElement } from '../src/server/types.js';

function human(id: string, text: string): ChatElement {
  return { type: 'human', id, flatIndex: 0, text, mentions: [] };
}

function assistant(id: string, text: string, html: string): ChatElement {
  return { type: 'assistant', id, flatIndex: 0, text, html, codeBlocks: [] };
}

describe('stripNonTailAssistantHtml', () => {
  it('clears html on every assistant except the newest', () => {
    const msgs: ChatElement[] = [
      human('h1', 'hi'),
      assistant('a1', 'one', '<p>one</p>'),
      human('h2', 'more'),
      assistant('a2', 'two', '<p>two</p>'),
      { type: 'tool', id: 't1', flatIndex: 4, toolCallId: 'c1', status: 'completed', action: 'Read', details: 'f.ts', filename: 'f.ts' },
    ];
    const lean = stripNonTailAssistantHtml(msgs);
    assert.notEqual(lean, msgs);
    assert.equal((lean[1] as { html: string }).html, '');
    assert.equal((lean[1] as { text: string }).text, 'one');
    assert.equal((lean[3] as { html: string }).html, '<p>two</p>');
  });

  it('returns the same array when nothing to strip', () => {
    const msgs: ChatElement[] = [
      human('h1', 'hi'),
      assistant('a1', 'only', '<p>only</p>'),
    ];
    assert.equal(stripNonTailAssistantHtml(msgs), msgs);
  });

  it('returns empty / no-assistant inputs unchanged', () => {
    assert.deepEqual(stripNonTailAssistantHtml([]), []);
    const tools: ChatElement[] = [
      { type: 'tool', id: 't1', flatIndex: 0, toolCallId: 'c1', status: 'loading', action: 'Run', details: 'x', filename: '' },
    ];
    assert.equal(stripNonTailAssistantHtml(tools), tools);
  });
});
