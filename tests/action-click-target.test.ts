import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  CommandExecutor,
  resolveActionClickTarget,
  type ActionClickTargetResult,
} from '../src/server/command-executor.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

// Questionnaire extraction and row-kind mapping live inside the serialized
// extractionFunction; keep them self-contained instead of restructuring
// production code solely for test access.

function documentFor(html: string): Document {
  return new JSDOM(html).window.document;
}

function assertElement(result: ActionClickTargetResult): Element {
  assert.ok('element' in result, 'expected resolver to return an element');
  return result.element;
}

function assertError(result: ActionClickTargetResult): string {
  assert.ok('error' in result, 'expected resolver to return an error');
  return result.error;
}

describe('action click target resolution', () => {
  it('returns the selector target when its label matches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="continue">Continue</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#continue', 'continue');

    assert.equal(assertElement(result).id, 'continue');
  });

  it('matches data-click-ready action labels from span.truncate when shortcut text is present', () => {
    const document = documentFor(`
      <main id="toolbar">
        <div id="skip" data-click-ready="true">
          <span>
            <span class="truncate">Skip</span>
            <span class="opacity-50 keybinding-font-settings">Esc</span>
          </span>
        </div>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#skip', 'Skip');

    assert.equal(assertElement(result).id, 'skip');
  });

  it('falls back to exactly one scoped text match when the selector label mismatches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="target" class="ui-button ui-9f619">Continue</button>
      </main>
      <button id="outside">Continue</button>
    `);

    const result = resolveActionClickTarget(
      document,
      '#toolbar > button#stale',
      'Continue'
    );

    assert.equal(assertElement(result).id, 'target');
  });

  it('finds a unique scoped data-click-ready action when the direct selector mismatches', () => {
    const document = documentFor(`
      <section class="composer-questionnaire-toolbar-actions">
        <button id="stale">Not Skip</button>
        <div id="skip" data-click-ready="true">
          <span>
            <span class="truncate">Skip</span>
            <span class="opacity-50 keybinding-font-settings">Esc</span>
          </span>
        </div>
      </section>
      <div id="outside" data-click-ready="true">
        <span><span class="truncate">Skip</span></span>
      </div>
    `);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-actions > button#stale',
      'Skip'
    );

    assert.equal(assertElement(result).id, 'skip');
  });

  it('continues to resolve legacy plain button actions', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="continue">Continue</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#toolbar > button#continue', 'Continue');

    assert.equal(assertElement(result).id, 'continue');
  });

  it('does not choose a target when scoped text matches are missing or ambiguous', () => {
    const zeroDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
      </main>
    `);
    const zero = resolveActionClickTarget(zeroDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(zero), /action target not found \(label: Continue\)/);

    const multipleDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="one">Continue</button>
        <button id="two" role="button">Continue</button>
      </main>
    `);
    const multiple = resolveActionClickTarget(multipleDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(multiple), /action target not found \(label: Continue\)/);
  });

  it('returns a closest button ancestor or descendant button when that label matches', () => {
    const ancestorDocument = documentFor(`
      <button id="ancestor" class="ui-button">
        <span id="inner">Continue</span>
      </button>
    `);
    const ancestor = resolveActionClickTarget(ancestorDocument, '#inner', 'Continue');

    assert.equal(assertElement(ancestor).id, 'ancestor');

    const descendantDocument = documentFor(`
      <section id="container">
        <button id="descendant" class="ui-button">Continue</button>
      </section>
    `);
    const descendant = resolveActionClickTarget(descendantDocument, '#container', 'Continue');

    assert.equal(assertElement(descendant).id, 'descendant');
  });

  // Live Cursor 3.8.23 questionnaire option row structure (public#50):
  // the row concatenates letter + label, so whole-text matching cannot work.
  const questionnaireHtml = `
    <div class="composer-questionnaire-toolbar">
      <div class="composer-questionnaire-toolbar-questions">
        <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
          <div class="composer-questionnaire-toolbar-options">
            <div id="row-a" class="composer-questionnaire-toolbar-option" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
              <span class="composer-questionnaire-toolbar-option-label">Explore the codebase architecture</span>
            </div>
            <div id="row-b" class="composer-questionnaire-toolbar-option" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
              <span class="composer-questionnaire-toolbar-option-label">Work on a new feature</span>
            </div>
            <div id="row-f" class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
              <button class="composer-questionnaire-toolbar-option-letter" type="button">C</button>
              <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  it('resolves a questionnaire option row by its label span despite the letter prefix', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)',
      'Work on a new feature'
    );

    assert.equal(assertElement(result).id, 'row-b');
  });

  it('resolves a freeform questionnaire option for the synthetic "Other" label', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(3)',
      'Other'
    );

    assert.equal(assertElement(result).id, 'row-f');
  });

  it('falls back to the unique option row matching the label when the path is stale', () => {
    const document = documentFor(questionnaireHtml);

    const result = resolveActionClickTarget(
      document,
      '.composer-questionnaire-toolbar-question:nth-of-type(9) .composer-questionnaire-toolbar-option:nth-of-type(9)',
      'Explore the codebase architecture'
    );

    assert.equal(assertElement(result).id, 'row-a');
  });

  // Live Cursor 2026 questionnaire tray structure. The freeform row's label
  // span reads "Other…" (with a trailing ellipsis) while the client-facing
  // label is always "Other"; the class check must win so the ellipsis can't
  // break the match (public: "Other" button didn't work).
  const trayHtml = `
    <div class="ui-tray glass-questionnaire-tray">
      <div class="ui-tray-step" data-active="true">
        <div class="ui-tray-options">
          <div id="tray-a" class="ui-tray-option" role="button">
            <span class="ui-tray-option__badge">A</span>
            <span class="ui-tray-option__label">Red</span>
          </div>
          <div id="tray-c" class="ui-tray-option questionnaire-freeform-option" data-text-input="true" role="button">
            <span class="ui-tray-option__badge">C</span>
            <span class="ui-tray-option__label">Other...</span>
          </div>
        </div>
      </div>
    </div>
  `;

  it('resolves a freeform tray option for "Other" despite the trailing-ellipsis label', () => {
    const document = documentFor(trayHtml);

    const result = resolveActionClickTarget(
      document,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(1) .ui-tray-option:nth-of-type(2)',
      'Other'
    );

    assert.equal(assertElement(result).id, 'tray-c');
  });

  it('resolves a standard tray option by its label span', () => {
    const document = documentFor(trayHtml);

    const result = resolveActionClickTarget(
      document,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(1) .ui-tray-option:nth-of-type(1)',
      'Red'
    );

    assert.equal(assertElement(result).id, 'tray-a');
  });

  it('setAnswerText focuses an already-mounted editor inside the option row and types', async () => {
    const typed: string[] = [];
    const evaluations: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      click: async () => {},
      typeText: async (text: string) => {
        typed.push(text);
      },
      evaluate: async (expr: string) => {
        evaluations.push(expr);
        // Editor already mounted in the row (client clicked "Other" first).
        if (expr.includes('.tiptap.ProseMirror')) return 'ok';
        return null;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.setAnswerText('cmd-ff', '#tray-c', 'My custom answer');

    assert.equal(result.ok, true);
    assert.deepEqual(typed, ['My custom answer']);
    assert.ok(
      evaluations.some((e) => e.includes('#tray-c')),
      'should resolve the editor inside the option row'
    );
  });

  it('setAnswerText clicks the row to mount the editor when none is present yet', async () => {
    const typed: string[] = [];
    const clicked: string[] = [];
    let focusCalls = 0;
    const fakeClient = {
      isConnected: () => true,
      click: async (selector: string) => {
        clicked.push(selector);
      },
      typeText: async (text: string) => {
        typed.push(text);
      },
      evaluate: async (expr: string) => {
        // First focus attempt: editor not mounted. After the row click: mounted.
        if (expr.includes('.tiptap.ProseMirror')) {
          focusCalls += 1;
          return focusCalls >= 2 ? 'ok' : 'no-editor';
        }
        return null;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.setAnswerText('cmd-ff', '#tray-c', 'typed text');

    assert.equal(result.ok, true);
    assert.deepEqual(clicked, ['#tray-c'], 'should click the option row once to mount the editor');
    assert.deepEqual(typed, ['typed text']);
  });

  it('keeps clickAction legacy behavior when no expected label is provided', async () => {
    const clickedSelectors: string[] = [];
    let evaluateCalled = false;
    const fakeClient = {
      isConnected: () => true,
      click: async (selector: string) => {
        clickedSelectors.push(selector);
      },
      evaluate: async () => {
        evaluateCalled = true;
        return null;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.clickAction('cmd-1', '#legacy-button');

    assert.equal(result.ok, true);
    assert.deepEqual(clickedSelectors, ['#legacy-button']);
    assert.equal(evaluateCalled, false);
  });

  it('openFolderAgent clicks the agent row first (reliable switch for existing agents)', async () => {
    const evaluations: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expr: string) => {
        evaluations.push(expr);
        // Row click succeeds.
        return true;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.openFolderAgent('cmd-open', 'composer-xyz', 'My agent');

    assert.equal(result.ok, true);
    assert.equal(evaluations.length, 1, 'should stop at the successful row click');
    assert.match(evaluations[0], /glass-sidebar-agent-list-container/);
    // The row click must match by composer id (React fiber agentId).
    assert.match(evaluations[0], /agentId/);
    assert.match(evaluations[0], /composer-xyz/);
  });

  it('openFolderAgent falls back to the workbench command service when no row matches', async () => {
    const evaluations: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expr: string) => {
        evaluations.push(expr);
        // First call: no matching row. Second: command service succeeds.
        if (expr.includes('glass-sidebar-agent-list-container')) return false;
        return { ok: true };
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.openFolderAgent('cmd-open', 'composer-xyz', 'My agent');

    assert.equal(result.ok, true);
    assert.equal(evaluations.length, 2, 'row click attempt then command fallback');
    assert.match(evaluations[1], /__getCommandService/);
    assert.match(evaluations[1], /composer\.openComposer/);
    assert.match(evaluations[1], /composer-xyz/);
  });

  it('openFolderAgent resolves by title when no composerId is supplied', async () => {
    const evaluations: string[] = [];
    const fakeClient = {
      isConnected: () => true,
      evaluate: async (expr: string) => {
        evaluations.push(expr);
        return true;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.openFolderAgent('cmd-open', '', 'My agent', 'li > div');

    assert.equal(result.ok, true);
    assert.equal(evaluations.length, 1, 'no command call without a composerId');
    assert.match(evaluations[0], /glass-sidebar-agent-list-container/);
  });
});
