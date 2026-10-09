import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ComposerHistory } from '../src/server/composer-history.js';

const COMPOSER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface Seed {
  headers: Array<Record<string, unknown>>;
  bubbles: Record<string, Record<string, unknown>>;
  name?: string;
}

function writeDb(path: string, seed: Seed): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  ins.run(
    `composerData:${COMPOSER_ID}`,
    JSON.stringify({
      composerId: COMPOSER_ID,
      name: seed.name ?? 'Test composer',
      fullConversationHeadersOnly: seed.headers,
    })
  );
  for (const [bubbleId, body] of Object.entries(seed.bubbles)) {
    ins.run(`bubbleId:${COMPOSER_ID}:${bubbleId}`, JSON.stringify({ bubbleId, ...body }));
  }
  db.close();
}

let dir: string;
let dbPath: string;

const seed: Seed = {
  name: 'History Test',
  headers: [
    { bubbleId: 'h1', type: 1, grouping: { isRenderable: true, hasText: true, textPreview: 'Hello there' } },
    { bubbleId: 'a1', type: 2, grouping: { isRenderable: true, hasText: true, textPreview: 'Hi, working on it' } },
    {
      bubbleId: 't1',
      type: 2,
      grouping: {
        isRenderable: true,
        capabilityType: 15,
        toolFormerTool: 38,
        toolFormerStatus: 'completed',
        toolCallId: 'call-edit-1',
        toolCallCase: 'editToolCall',
        toolDisplayPath: 'c:/proj/src/index.ts',
        editLinesAdded: 7,
        editLinesRemoved: 2,
        toolDisplayComputed: true,
      },
    },
    {
      bubbleId: 'todo1',
      type: 2,
      grouping: {
        isRenderable: true,
        capabilityType: 15,
        toolFormerTool: 35,
        toolFormerStatus: 'completed',
        toolCallCase: 'updateTodosToolCall',
        toolDisplayComputed: true,
      },
    },
    // Hidden/non-renderable header must be dropped.
    { bubbleId: 'hidden', type: 2, grouping: { isRenderable: false } },
    {
      bubbleId: 'running',
      type: 2,
      grouping: {
        isRenderable: true,
        capabilityType: 15,
        toolFormerTool: 15,
        toolFormerStatus: 'loading',
        toolCallId: 'call-shell-1',
        toolCallCase: 'shellToolCall',
        toolDisplayComputed: true,
      },
    },
  ],
  bubbles: {
    h1: { type: 1, text: 'Hello there' },
    a1: { type: 2, text: 'Hi, working on it' },
    t1: {
      type: 2,
      text: '',
      toolFormerData: { toolCallId: 'call-edit-1', name: 'edit_file_v2', status: 'completed', params: '{"relativeWorkspacePath":"c:/proj/src/index.ts"}' },
    },
    todo1: {
      type: 2,
      text: '',
      toolFormerData: {
        toolCallId: 'call-todo-1',
        name: 'todo_write',
        status: 'completed',
        params: '{"todos":[{"content":"One","status":"completed"},{"content":"Two","status":"in_progress"}]}',
      },
    },
    hidden: { type: 2, text: 'should not appear' },
    running: {
      type: 2,
      text: '',
      toolFormerData: { toolCallId: 'call-shell-1', name: 'run_terminal_command_v2', status: 'loading', params: '{"command":"npm test"}' },
    },
  },
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'crh-'));
  dbPath = join(dir, 'state.vscdb');
  writeDb(dbPath, seed);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ComposerHistory', () => {
  it('is disabled when no db path is configured', async () => {
    const h = new ComposerHistory({ dbPath: '' });
    assert.equal(h.enabled, false);
    assert.equal(await h.getHistory(COMPOSER_ID), null);
  });

  it('reads and maps the full transcript in order, dropping non-renderable rows', async () => {
    const h = new ComposerHistory({ dbPath, cacheTtlMs: 0 });
    const res = await h.getHistory(COMPOSER_ID);
    assert.ok(res);
    assert.equal(res!.name, 'History Test');
    assert.equal(res!.total, seed.headers.length);
    assert.equal(res!.truncated, false);

    const ids = res!.messages.map((m) => m.id);
    assert.deepEqual(ids, ['h1', 'a1', 'tool:call-edit-1', 'todo1', 'tool:call-shell-1']);

    const [human, assistant, edit, todo, shell] = res!.messages;
    assert.equal(human.type, 'human');
    assert.equal((human as any).text, 'Hello there');

    assert.equal(assistant.type, 'assistant');
    assert.match((assistant as any).html, /working on it/);

    assert.equal(edit.type, 'tool');
    assert.equal((edit as any).toolCallId, 'call-edit-1');
    assert.equal((edit as any).filename, 'index.ts');
    assert.equal((edit as any).additions, 7);
    assert.equal((edit as any).deletions, 2);
    assert.equal((edit as any).status, 'completed');

    assert.equal(todo.type, 'todo_list');
    assert.equal((todo as any).todosTotal, 2);
    assert.equal((todo as any).todosCompleted, 1);

    assert.equal(shell.type, 'tool');
    assert.equal((shell as any).status, 'loading');
    assert.match((shell as any).details, /npm test/);
  });

  it('returns null for an unknown composer', async () => {
    const h = new ComposerHistory({ dbPath, cacheTtlMs: 0 });
    assert.equal(await h.getHistory('ffffffff-0000-0000-0000-000000000000'), null);
  });

  it('rejects malformed composer ids without touching the db', async () => {
    const h = new ComposerHistory({ dbPath, cacheTtlMs: 0 });
    assert.equal(await h.getHistory('../etc/passwd'), null);
  });

  it('truncates to the trailing maxMessages window', async () => {
    const h = new ComposerHistory({ dbPath, maxMessages: 2, cacheTtlMs: 0 });
    const res = await h.getHistory(COMPOSER_ID);
    assert.ok(res);
    assert.equal(res!.truncated, true);
    // Trailing window of 2 headers is (hidden, running); hidden is non-renderable
    // and dropped, leaving only the running shell tool.
    assert.deepEqual(res!.messages.map((m) => m.id), ['tool:call-shell-1']);
  });

  it('caches results until invalidated', async () => {
    const h = new ComposerHistory({ dbPath, cacheTtlMs: 60000 });
    const first = await h.getHistory(COMPOSER_ID);
    assert.ok(first);
    h.invalidate(COMPOSER_ID);
    const second = await h.getHistory(COMPOSER_ID);
    assert.deepEqual(first, second);
  });
});
