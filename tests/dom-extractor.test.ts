import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { CursorState } from '../src/server/types.js';

function withDom(html: string, opts: {
  approveSelectors?: string[];
  approveTextMatch?: string[];
  rejectSelectors?: string[];
  rejectTextMatch?: string[];
} = {}): CursorState {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: dom.window.Node,
  });
  try {
    const state = extractionFunction(
      ['#root'],
      opts.approveSelectors ?? [],
      opts.approveTextMatch ?? [],
      opts.rejectSelectors ?? [],
      opts.rejectTextMatch ?? [],
      [],
      [],
      [],
      [],
      []
    );
    assert.ok(state, 'expected extractionFunction to return state');
    return state;
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      delete globalThis.document;
    }
    if (nodeDescriptor) {
      Object.defineProperty(globalThis, 'Node', nodeDescriptor);
    } else {
      delete globalThis.Node;
    }
  }
}

describe('extractionFunction', () => {
  it('emits Cursor 3.8 activity tool-placeholder rows without data-message-role', () => {
    const state = withDom(`
      <main id="root">
        <div data-find-row-key="tool-placeholder:call-1">
          <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
            <div data-tool-call-id="call-1" data-tool-status="completed">
              <span class="ui-tool-call-line-action">Read</span>
              <span class="ui-tool-call-line-details">src/server/dom-extractor.ts</span>
            </div>
          </article>
        </div>
      </main>
    `);

    const tool = state.messages.find((message) => message.type === 'tool');

    assert.ok(tool, 'expected a tool element to be emitted');
    assert.equal(tool.toolCallId, 'call-1');
    assert.equal(tool.action, 'Read');
  });

  it('uses anchored selector paths for data-click-ready questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true">
              <span><span class="truncate">Skip</span></span>
            </div>
            <div class="shortcut">Esc</div>
            <div data-click-ready="true" data-disabled="true">
              <span><span class="truncate">Continue</span></span>
            </div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(3)'
    );
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('emits anchored option-row selector paths for questionnaire options (public#50)', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
              <div class="composer-questionnaire-toolbar-options">
                <div class="composer-questionnaire-toolbar-option" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
                  <span class="composer-questionnaire-toolbar-option-label">Explore the codebase</span>
                </div>
                <div class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
                  <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    const [question] = state.questionnaire.questions;
    assert.equal(question.options.length, 2);
    assert.equal(question.options[0].label, 'Explore the codebase');
    assert.equal(
      question.options[0].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(1)'
    );
    assert.equal(question.options[1].label, 'Other');
    assert.equal(question.options[1].isFreeform, true);
    assert.equal(
      question.options[1].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)'
    );
  });

  it('parses Cursor\'s newer .ui-tray question widget (glass-questionnaire-tray)', () => {
    // Structure captured from a live Cursor 2026 build: the ask-question UI is a
    // floating tray, not the legacy inline `.composer-questionnaire-toolbar`.
    const state = withDom(`
      <main id="root"></main>
      <div class="ui-tray glass-questionnaire-tray">
        <div data-component="tray-header">
          <span data-component="tray-header-title">Questions</span>
        </div>
        <div class="ui-tray__scroll-area">
          <div class="ui-tray-step" data-active="true">
            <div class="ui-tray-step__title">
              <div class="markdown-root"><p>Which database should I use?</p></div>
            </div>
            <div class="ui-tray-step__options">
              <button class="ui-tray-option" data-variant="badge">
                <span class="ui-tray-option__badge">A</span>
                <span class="ui-tray-option__label">SQLite</span>
              </button>
              <button class="ui-tray-option" data-variant="badge">
                <span class="ui-tray-option__badge">B</span>
                <span class="ui-tray-option__label">Postgres</span>
              </button>
              <button class="ui-tray-option questionnaire-freeform-option" data-text-input="true">
                <span class="ui-tray-option__badge">C</span>
                <span class="ui-tray-option__label" data-placeholder="true">Other...</span>
              </button>
            </div>
          </div>
        </div>
        <div class="ui-tray-footer">
          <button type="button" data-variant="text">Skip</button>
          <div class="ui-tray-footer__primary">
            <button type="button" data-variant="primary" data-disabled="" disabled>
              <span>Continue</span><span class="ui-tray-footer__shortcut">⏎</span>
            </button>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire, 'expected the new tray to be parsed');
    assert.equal(state.questionnaire.questions.length, 1);
    const [question] = state.questionnaire.questions;
    assert.equal(question.text, 'Which database should I use?');
    assert.equal(question.options.length, 3);
    assert.equal(question.options[0].letter, 'A');
    assert.equal(question.options[0].label, 'SQLite');
    assert.equal(question.options[1].label, 'Postgres');
    assert.equal(question.options[2].label, 'Other');
    assert.equal(question.options[2].isFreeform, true);
    assert.equal(
      question.options[0].selectorPath,
      '.glass-questionnaire-tray .ui-tray-step:nth-of-type(1) .ui-tray-option:nth-of-type(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.glass-questionnaire-tray .ui-tray-footer__primary button'
    );
    assert.equal(state.questionnaire.continueDisabled, true);
    assert.ok(state.questionnaire.skipSelectorPath.length > 0);
  });

  it('prefers the new tray over the legacy toolbar when both are present', () => {
    const state = withDom(`
      <main id="root"></main>
      <div class="glass-questionnaire-tray ui-tray">
        <div class="ui-tray-step" data-active="true">
          <div class="ui-tray-step__title"><div class="markdown-root"><p>New tray question</p></div></div>
          <div class="ui-tray-option"><span class="ui-tray-option__badge">A</span><span class="ui-tray-option__label">Yes</span></div>
        </div>
      </div>
      <div class="composer-questionnaire-toolbar">
        <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
        <div class="composer-questionnaire-toolbar-questions">
          <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
            <div class="markdown-root"><p>Legacy toolbar question</p></div>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    const [question] = state.questionnaire.questions;
    assert.equal(question.text, 'New tray question');
  });

  it('keeps buildSelectorPath selectors for legacy questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <section class="composer-questionnaire-toolbar-actions">
            <div class="composer-skip-button">Skip</div>
            <div class="composer-run-button" data-disabled="false">Continue</div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(2)'
    );
    assert.equal(state.questionnaire.continueDisabled, false);
  });

  it('does not treat a collapsible tool header ("Running …") as a pending approval', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
          <div data-tool-call-id="call-1" data-tool-status="completed">
            <div class="ui-shell-tool-call">
              <button class="ui-collapsible-header">Running npm run build Ctrl+⏎</button>
            </div>
          </div>
        </article>
      </main>
    `, {
      approveSelectors: ['button.ui-shell-tool-call__run-btn'],
      approveTextMatch: ['Accept', 'Approve', 'Run', 'Allow'],
      rejectSelectors: ['button.ui-shell-tool-call__skip-btn'],
      rejectTextMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    });

    // The header's text contains "Run" but it is a disclosure control, not an
    // approval action — the bar must stay hidden and status must not be
    // forced to waiting_approval.
    assert.equal(state.pendingApprovals.length, 0);
    assert.notEqual(state.agentStatus, 'waiting_approval');
  });

  it('still surfaces a genuine per-card shell approval', () => {
    const state = withDom(`
      <main id="root">
        <div class="ui-tool-call-card" data-tool-call-id="call-2">
          <div class="ui-shell-tool-call__description">Delete build artifacts</div>
          <div class="ui-shell-tool-call__command">rm -rf dist</div>
          <div class="ui-shell-tool-call__approval-row">
            <button class="ui-shell-tool-call__run-btn">Run</button>
            <button class="ui-shell-tool-call__skip-btn">Skip</button>
          </div>
        </div>
      </main>
    `, {
      approveSelectors: ['button.ui-shell-tool-call__run-btn'],
      approveTextMatch: ['Accept', 'Approve', 'Run', 'Allow'],
      rejectSelectors: ['button.ui-shell-tool-call__skip-btn'],
      rejectTextMatch: ['Reject', 'Deny', 'Cancel', 'Skip'],
    });

    assert.equal(state.pendingApprovals.length, 1);
    const types = state.pendingApprovals[0].actions.map((a) => a.type).sort();
    assert.deepEqual(types, ['approve', 'reject']);
    assert.equal(state.agentStatus, 'waiting_approval');
  });
});
