import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandExecutor } from '../src/server/command-executor.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

/**
 * A tiny stateful fake of Cursor's composer + `/` tray.
 *
 * The host composer is a contenteditable the bot can't clear with `value = ''`,
 * and the slash tray only opens when the composer holds a single leading "/".
 * We model exactly that so the normalization (clear before typing "/") is
 * verified: a stray "/" left in the composer must NOT turn into "//", which
 * would keep the tray shut and yield an empty menu.
 */
function createFakeComposer(initialText: string) {
  const state = {
    text: initialText,
    trayOpen: false,
    pressedKeys: [] as string[],
    /** Every Input.insertText payload, so query typing can be asserted. */
    typed: [] as string[],
  };

  const ALL_OPTIONS = [
    { id: 'commit', label: 'commit', description: '', selected: false, index: 1 },
    { id: 'summarize', label: 'summarize', description: '', selected: false, index: 2 },
    { id: 'review-security', label: 'review-security', description: 'security review', selected: false, index: 1 },
    { id: 'review-bugbot', label: 'review-bugbot', description: 'bug review', selected: false, index: 2 },
  ];

  // Cursor renders ~14 rows and filters by the token typed after "/".
  const visibleOptions = () => {
    if (!state.trayOpen) return [] as typeof ALL_OPTIONS;
    const query = state.text.startsWith('/') ? state.text.slice(1).toLowerCase() : '';
    const matches = ALL_OPTIONS.filter(o => o.id.includes(query));
    return matches.map((o, i) => ({ ...o, index: i + 1, selected: i === 0 }));
  };

  const client = {
    isConnected: () => true,
    typeText: async (text: string) => {
      // Input.insertText inserts at the cursor (end, in this model).
      state.typed.push(text);
      state.text = state.text + text;
      // A single leading "/" (plus an optional token) opens the tray.
      state.trayOpen = /^\/\w*$/.test(state.text);
    },
    pressKey: async (key: string) => {
      state.pressedKeys.push(key);
      if (key === 'Escape') state.trayOpen = false;
      if (key === 'Backspace') {
        // Select-all was pressed just before, so this clears everything.
        state.text = '';
        state.trayOpen = false;
      }
    },
    evaluate: async (expr: string) => {
      // clickSlashCommand's row-finding expression
      if (expr.includes('const wantId')) {
        if (!state.trayOpen) return { ok: false, error: 'slash menu not open' };
        const rows = visibleOptions();
        const wantId = (expr.match(/const wantId = "([^"]*)"/) ?? [])[1] ?? '';
        const wantIndex = Number((expr.match(/const wantIndex = (\d+)/) ?? [])[1] ?? NaN);
        const target = rows.find(r => r.id === wantId)
          ?? (Number.isFinite(wantIndex) ? rows[wantIndex - 1] : undefined)
          ?? rows[0];
        if (!target) return { ok: false, error: 'slash menu empty' };
        state.text = '/' + target.id;
        return { ok: true, label: target.label };
      }
      // tray read (getSlashMenu's final evaluate)
      if (expr.includes('const rows = Array.from')) {
        return { open: state.trayOpen, options: state.trayOpen ? visibleOptions() : [] };
      }
      // slashTrayOpen / menuAlreadyOpen probe
      if (expr.includes('aria-label="Slash commands"]')) {
        return state.trayOpen;
      }
      // readComposerText
      if (expr.includes('input.isContentEditable ? contentText')) {
        return state.text;
      }
      // focusComposer / clickSlashCommand read-back
      return true;
    },
  } as unknown as CdpClient;

  return { client, state };
}

const SELECTORS = {
  chatInput: { strategies: ["[contenteditable='true']"] },
} as unknown as SelectorConfig;

describe('slash menu composes a clean "/" before opening', () => {
  it('recovers when a stray "/" is already in the composer (the "//" bug)', async () => {
    const { client, state } = createFakeComposer('/');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.getSlashMenu('cmd-1');
    const options = (result.data as { options?: unknown[] } | undefined)?.options ?? [];

    assert.equal(result.ok, true);
    assert.equal(state.text, '/', 'composer must end with a single slash, not "//"');
    assert.ok(options.length > 0, 'menu should open with options after normalization');
    assert.ok(state.pressedKeys.includes('Backspace'), 'stray text should be cleared first');
  });

  it('clears arbitrary stray text before opening the menu', async () => {
    const { client, state } = createFakeComposer('hello world');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.getSlashMenu('cmd-2');
    const options = (result.data as { options?: unknown[] } | undefined)?.options ?? [];

    assert.equal(result.ok, true);
    assert.equal(state.text, '/', 'composer should be normalized to a single slash');
    assert.ok(options.length > 0);
  });

  it('opens with a single slash when the composer is already empty', async () => {
    const { client, state } = createFakeComposer('');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.getSlashMenu('cmd-3');
    const options = (result.data as { options?: unknown[] } | undefined)?.options ?? [];

    assert.equal(result.ok, true);
    assert.equal(state.text, '/');
    assert.ok(options.length > 0);
    assert.ok(!state.pressedKeys.includes('Backspace'), 'nothing to clear when already empty');
  });

  it('reopens a clean menu from clickSlashCommand when the tray was lost', async () => {
    const { client, state } = createFakeComposer('/');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.clickSlashCommand('cmd-4', 'summarize', 2);

    assert.equal(result.ok, true, 'should not fail with "slash menu empty"');
    assert.equal(
      (result.data as { composerText?: string } | undefined)?.composerText,
      '/summarize',
      'the picked command should be inserted'
    );
    assert.ok(!state.text.startsWith('//'), 'composer must not accumulate a second slash');
  });
});

describe('slash menu filtering (search unlocks the full command set)', () => {
  it('types the query into the composer so Cursor filters its own list', async () => {
    const { client, state } = createFakeComposer('');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.getSlashMenu('q-1', 'review');
    const options = (result.data as { options?: Array<{ id: string }> } | undefined)?.options ?? [];

    assert.equal(result.ok, true);
    assert.equal(state.text, '/review', 'the query must be typed after the slash');
    assert.deepEqual(
      options.map(o => o.id),
      ['review-security', 'review-bugbot'],
      'only the matching commands are returned'
    );
  });

  it('strips characters Cursor cannot match on so the token stays valid', async () => {
    const { client, state } = createFakeComposer('');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    await executor.getSlashMenu('q-2', '  re/vi ew!  ');
    assert.equal(state.text, '/review', 'spaces and punctuation are removed from the token');
  });

  it('reuses the open tray when the composer already holds the same query', async () => {
    const { client, state } = createFakeComposer('/review');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    // Prime the fake as if the tray is already open at that exact query.
    await client.typeText('');
    await executor.getSlashMenu('q-3', 'review');

    assert.equal(state.typed.filter(t => t === '/review').length, 0, 'no redundant retype');
    assert.ok(!state.pressedKeys.includes('Backspace'), 'nothing to clear for a matching query');
  });

  it('re-opens the SAME filtered list when clicking a searched command', async () => {
    const { client, state } = createFakeComposer('');
    const executor = new CommandExecutor(SELECTORS);
    executor.setClient(client);

    const result = await executor.clickSlashCommand('q-4', 'review-bugbot', 2, 'review');
    assert.equal(result.ok, true);
    assert.equal(state.text, '/review-bugbot', 'the filtered command is inserted');
    assert.equal(
      (result.data as { composerText?: string } | undefined)?.composerText,
      '/review-bugbot'
    );
  });
});
