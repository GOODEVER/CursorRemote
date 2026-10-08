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
  };

  const OPTIONS = [
    { id: 'commit', label: 'commit', description: '', selected: false, index: 1 },
    { id: 'summarize', label: 'summarize', description: '', selected: false, index: 2 },
  ];

  const client = {
    isConnected: () => true,
    typeText: async (text: string) => {
      // Input.insertText inserts at the cursor (end, in this model).
      state.text = state.text + text;
      state.trayOpen = state.text === '/';
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
        state.text = '/summarize';
        return { ok: true, label: 'summarize' };
      }
      // tray read (getSlashMenu's final evaluate)
      if (expr.includes('const rows = Array.from')) {
        return state.trayOpen
          ? { open: true, options: OPTIONS }
          : { open: false, options: [] };
      }
      // menuAlreadyOpen probe
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

  return { client, state, OPTIONS };
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
