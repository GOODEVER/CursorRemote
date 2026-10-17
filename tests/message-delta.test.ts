import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMessageDelta,
  computeMessagePatch,
  MESSAGE_DELTA_UPSERT_CAP,
} from '../src/server/message-delta.js';
import { SignatureCache } from '../src/server/signature-cache.js';
import type { ChatElement, HumanMessage, AssistantMessage } from '../src/server/types.js';

function human(id: string, text: string): HumanMessage {
  return { type: 'human', id, flatIndex: 0, text, mentions: [] };
}

function assistant(id: string, text: string, html?: string): AssistantMessage {
  return {
    type: 'assistant',
    id,
    flatIndex: 0,
    text,
    html: html ?? `<p>${text}</p>`,
    codeBlocks: [],
  };
}

const cache = new SignatureCache();
const differs = (a: unknown, b: unknown) => cache.differs(a, b);

describe('computeMessagePatch', () => {
  it('returns none when transcripts are structurally equal', () => {
    const msgs = [human('h1', 'hi')];
    // Fresh array, same content — SignatureCache still stringifies once each.
    const next = [human('h1', 'hi')];
    assert.equal(computeMessagePatch(msgs, next, differs).kind, 'none');
  });

  it('uses a delta when only the trailing assistant message grows', () => {
    const prev: ChatElement[] = [
      human('h1', 'do the thing'),
      assistant('a1', 'Working', '<p>Working</p>'),
    ];
    const next: ChatElement[] = [
      human('h1', 'do the thing'),
      assistant('a1', 'Working on it…', '<p>Working on it…</p>'),
    ];
    const result = computeMessagePatch(prev, next, differs);
    assert.equal(result.kind, 'delta');
    if (result.kind !== 'delta') return;
    assert.equal(result.messageDelta.upsert.length, 1);
    assert.equal(result.messageDelta.upsert[0].id, 'a1');
    assert.deepEqual(result.messageDelta.removeIds, []);
    assert.equal(result.messageDelta.order, undefined, 'append-only omits order');
  });

  it('uses a delta when a new tool row is appended', () => {
    const prev: ChatElement[] = [human('h1', 'hi'), assistant('a1', 'ok')];
    const next: ChatElement[] = [
      human('h1', 'hi'),
      assistant('a1', 'ok'),
      {
        type: 'tool',
        id: 't1',
        flatIndex: 2,
        toolCallId: 'tc1',
        status: 'loading',
        action: 'Edit',
        details: 'file.ts',
        filename: 'file.ts',
      },
    ];
    const result = computeMessagePatch(prev, next, differs);
    assert.equal(result.kind, 'delta');
    if (result.kind !== 'delta') return;
    assert.equal(result.messageDelta.upsert.length, 1);
    assert.equal(result.messageDelta.upsert[0].id, 't1');
  });

  it('full-replaces when the chat switches (no shared ids)', () => {
    const prev: ChatElement[] = [human('old1', 'previous chat')];
    const next: ChatElement[] = [human('new1', 'new chat')];
    const result = computeMessagePatch(prev, next, differs);
    assert.equal(result.kind, 'full');
    if (result.kind !== 'full') return;
    assert.equal(result.messages[0].id, 'new1');
  });

  it('full-replaces when too many rows change', () => {
    const prev: ChatElement[] = [];
    const next: ChatElement[] = [];
    for (let i = 0; i < MESSAGE_DELTA_UPSERT_CAP + 2; i++) {
      prev.push(human(`h${i}`, `p${i}`));
      next.push(human(`h${i}`, `n${i}`));
    }
    const result = computeMessagePatch(prev, next, differs);
    assert.equal(result.kind, 'full');
  });

  it('includes order when a middle message is removed', () => {
    const prev: ChatElement[] = [
      human('h1', 'a'),
      assistant('a1', 'b'),
      human('h2', 'c'),
    ];
    const next: ChatElement[] = [
      human('h1', 'a'),
      human('h2', 'c'),
    ];
    const result = computeMessagePatch(prev, next, differs);
    assert.equal(result.kind, 'delta');
    if (result.kind !== 'delta') return;
    assert.deepEqual(result.messageDelta.removeIds, ['a1']);
    assert.deepEqual(result.messageDelta.order, ['h1', 'h2']);
  });
});

describe('applyMessageDelta', () => {
  it('replaces an existing message in place (streaming)', () => {
    const msgs: ChatElement[] = [
      human('h1', 'hi'),
      assistant('a1', 'old'),
    ];
    const out = applyMessageDelta(msgs, {
      upsert: [assistant('a1', 'new')],
      removeIds: [],
    });
    assert.equal(out.length, 2);
    assert.equal((out[1] as AssistantMessage).text, 'new');
  });

  it('appends a new id and honors explicit order', () => {
    const msgs: ChatElement[] = [human('h1', 'hi')];
    const out = applyMessageDelta(msgs, {
      upsert: [assistant('a1', 'ok')],
      removeIds: [],
      order: ['h1', 'a1'],
    });
    assert.deepEqual(out.map((m) => m.id), ['h1', 'a1']);
  });

  it('removes ids then reorders', () => {
    const msgs: ChatElement[] = [
      human('h1', 'a'),
      assistant('a1', 'b'),
      human('h2', 'c'),
    ];
    const out = applyMessageDelta(msgs, {
      upsert: [],
      removeIds: ['a1'],
      order: ['h1', 'h2'],
    });
    assert.deepEqual(out.map((m) => m.id), ['h1', 'h2']);
  });
});
