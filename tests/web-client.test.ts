import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';
import type { CursorState } from '../src/server/types.js';

const HTML_PATH = resolve('src/client/index.html');
const APP_JS_PATH = resolve('src/client/app.js');

type EventHandler = (...args: unknown[]) => void;

interface MockSocket {
  handlers: Map<string, EventHandler>;
  on(event: string, fn: EventHandler): void;
  emit(event: string, ...args: unknown[]): void;
  fire(event: string, ...args: unknown[]): void;
  sent: Array<{ event: string; payload: any }>;
  connected: boolean;
  id: string;
}

function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve('fixtures/recordings', name), 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

function createTestEnv() {
  const html = readFileSync(HTML_PATH, 'utf-8');
  const appJs = readFileSync(APP_JS_PATH, 'utf-8');

  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: Window) {
      const mockSocket: MockSocket = {
        handlers: new Map(),
        connected: true,
        id: 'test-socket-id',
        sent: [],
        on(event: string, fn: EventHandler) {
          this.handlers.set(event, fn);
        },
        emit(event: string, ...args: unknown[]) {
          this.sent.push({ event, payload: args[0] });
        },
        fire(event: string, ...args: unknown[]) {
          const handler = this.handlers.get(event);
          if (handler) handler(...args);
        },
      };

      (window as any).io = function () {
        return mockSocket;
      };

      (window as any).__mockSocket = mockSocket;

      const storage: Record<string, string> = {};
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (key: string) => storage[key] ?? null,
          setItem: (key: string, val: string) => { storage[key] = val; },
          removeItem: (key: string) => { delete storage[key]; },
        },
      });

      (window as any).requestAnimationFrame = (cb: () => void) => {
        setTimeout(cb, 0);
        return 0;
      };

      // Notification stub so notification behavior can be asserted.
      const notifications: Array<{ title: string; body?: string; tag?: string }> = [];
      const NotifStub: any = function (title: string, opts?: any) {
        notifications.push({ title, body: opts && opts.body, tag: opts && opts.tag });
      };
      NotifStub.permission = 'granted';
      NotifStub.requestPermission = () => Promise.resolve('granted');
      (window as any).Notification = NotifStub;
      (window as any).__notifications = notifications;
      // fireNotification() bails when the document is focused; tests are headless.
      window.document.hasFocus = () => false;

      // Configurable /health stub. The client confirms a socket rejection
      // against /health before wiping the session token, so tests drive this
      // to model a genuinely-invalid session vs. a transient network glitch.
      const health = { ok: true, authRequired: true, sessionValid: true };
      (window as any).__health = health;
      (window as any).fetch = () => Promise.resolve({
        ok: health.ok,
        status: health.ok ? 200 : 500,
        json: () => Promise.resolve({
          authRequired: health.authRequired,
          sessionValid: health.sessionValid,
        }),
      });

      // Web Audio stub so the in-page chimes can be asserted. Records every
      // oscillator's frequency + type, and reports the context as 'running' so
      // the code's autoplay gate passes without a real user gesture.
      const tones: Array<{ freq: number; type: string }> = [];
      class OscStub {
        type = 'sine';
        frequency = { value: 0 };
        connect() { return this; }
        start() { tones.push({ freq: this.frequency.value, type: this.type }); }
        stop() { /* no-op */ }
      }
      class GainStub {
        gain = {
          setValueAtTime() { return this; },
          exponentialRampToValueAtTime() { return this; },
        };
        connect() { return this; }
      }
      class AudioContextStub {
        state = 'running';
        currentTime = 0;
        destination = {};
        createOscillator() { return new OscStub(); }
        createGain() { return new GainStub(); }
        resume() { return Promise.resolve(); }
      }
      (window as any).AudioContext = AudioContextStub;
      (window as any).__tones = tones;
    },
  });

  const window = dom.window;
  const document = window.document;

  const scriptEl = document.createElement('script');
  scriptEl.textContent = appJs;
  document.body.appendChild(scriptEl);

  const mockSocket = (window as any).__mockSocket as MockSocket;

  return { dom, window, document, mockSocket };
}

function fireFullState(mockSocket: MockSocket, state: CursorState) {
  mockSocket.fire('state:full', state);
}

function firePatch(mockSocket: MockSocket, patch: Partial<CursorState>) {
  mockSocket.fire('state:patch', patch);
}

function fireWindowSnapshot(mockSocket: MockSocket, snapshot: Record<string, unknown>) {
  mockSocket.fire('window:snapshot', snapshot);
}

function fireHistory(mockSocket: MockSocket, payload: Record<string, unknown>) {
  mockSocket.fire('history:full', payload);
}

// ─── Connection status rendering ───

describe('web: connection status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('shows connected when extractorStatus is ok', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const dot = env.document.getElementById('connection-dot')!;
    const text = env.document.getElementById('connection-text')!;
    assert.ok(dot.classList.contains('connected'));
    assert.match(text.textContent!, /Connected/i);
  });

  it('shows stale when extractorStatus is stale', () => {
    const fixture = loadFixture('connection-states.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const dot = env.document.getElementById('connection-dot')!;
    assert.ok(
      dot.classList.contains('stale') || dot.classList.contains('reconnecting'),
      `Expected stale/reconnecting class, got: ${dot.className}`
    );
  });
});

// ─── Agent status rendering ───

describe('web: agent status', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('shows idle when agent is idle', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });

  it('shows thinking label when shimmer active', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Planning next moves/i);
  });

  it('clears activity when shimmer stops', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[4].state!);
    const text = env.document.getElementById('agent-status-text')!;
    assert.match(text.textContent!, /Idle/i);
  });
});

// ─── Finished notifications ───

describe('web: finished notification', () => {
  let env: ReturnType<typeof createTestEnv>;
  const notifications = () => (env.window as any).__notifications as Array<{ body?: string; tag?: string }>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('notifies once the agent genuinely finishes after working', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    // Working (shimmer) then idle — our ground-truth signal, so no flapping.
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true });
    assert.equal(notifications().length, 0, 'no notification while working');
    firePatch(env.mockSocket, { agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    // Debounced: nothing until the settle window elapses.
    assert.equal(notifications().length, 0, 'no premature notification on idle');
    await new Promise((r) => setTimeout(r, 5200));
    const finished = notifications().filter((n) => n.tag === 'cursor-finished');
    assert.equal(finished.length, 1, 'exactly one finished notification');
  });

  it('does not notify a finish while waiting for approval', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true });
    firePatch(env.mockSocket, { agentStatus: 'waiting_approval', canAbort: false, agentActivityLive: false });
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(notifications().filter((n) => n.tag === 'cursor-finished').length, 0);
  });

  it('shows a dismissible green banner when the agent finishes', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const overlay = () => env.document.getElementById('finished-overlay')!;
    assert.ok(overlay().classList.contains('hidden'), 'banner hidden initially');

    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true });
    assert.ok(overlay().classList.contains('hidden'), 'no banner while working');

    firePatch(env.mockSocket, { agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    await new Promise((r) => setTimeout(r, 5200));

    assert.ok(!overlay().classList.contains('hidden'), 'banner shown on genuine finish');

    // Clicking anywhere dismisses it.
    overlay().click();
    assert.ok(overlay().classList.contains('hidden'), 'banner dismissed on click');
  });

  it('hides the banner when the agent starts working again', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    const overlay = () => env.document.getElementById('finished-overlay')!;

    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true });
    firePatch(env.mockSocket, { agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    await new Promise((r) => setTimeout(r, 5200));
    assert.ok(!overlay().classList.contains('hidden'), 'banner shown on finish');

    firePatch(env.mockSocket, { agentStatus: 'thinking', canAbort: true, agentActivityLive: true });
    assert.ok(overlay().classList.contains('hidden'), 'banner hidden once work resumes');
  });

  it('names which agent finished and where it ran', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    // Two agents under one workspace, with the second one active — the banner
    // must name that one, not just say "Agent finished".
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      canAbort: true,
      windows: [{ id: 'w1', title: 'Cursor Agents', url: '' }],
      activeWindowId: 'w1',
      chatTabs: [
        { composerId: 'c1', title: 'Refactor auth flow', isActive: false, status: 'idle', selectorPath: '' },
        { composerId: 'c2', title: 'Add dark mode', isActive: true, status: 'active', selectorPath: '' },
      ],
      folders: [
        {
          name: 'FactoryTycoonGame', sectionId: 'workspace:ft', kind: 'workspace', isCurrent: true,
          agents: [
            { title: 'Refactor auth flow', composerId: 'c1', sectionId: 'workspace:ft', isActive: false, selectorPath: '' },
            { title: 'Add dark mode', composerId: 'c2', sectionId: 'workspace:ft', isActive: true, selectorPath: '' },
          ],
        },
      ],
    } as CursorState);

    firePatch(env.mockSocket, { agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    await new Promise((r) => setTimeout(r, 5200));

    const what = env.document.getElementById('finished-what')!;
    const where = env.document.getElementById('finished-where')!;
    assert.equal(what.textContent, 'Add dark mode', 'banner names the finished agent');
    assert.match(where.textContent!, /FactoryTycoonGame/, 'banner names the workspace');

    // The OS/push notification body also carries the identity.
    const finished = notifications().filter((n) => n.tag === 'cursor-finished');
    assert.equal(finished.length, 1);
    assert.match(finished[0].body || '', /Add dark mode/);
  });

  it('names the folder that finished even when no folder is marked current', async () => {
    // Regression: when the relay is homed on the "Cursor Agents" overview window,
    // Cursor marks no folder `isCurrent`. The banner must still resolve the
    // finished agent's folder by composer id, not fall back to a blank name.
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      canAbort: true,
      windows: [{ id: 'w1', title: 'Cursor Agents', url: '' }],
      activeWindowId: 'w1',
      activeComposerId: 'c2',
      chatTabs: [],
      folders: [
        {
          name: 'FactoryTycoonGame', sectionId: 'workspace:ft', kind: 'workspace', isCurrent: false,
          agents: [
            { title: 'Refactor auth flow', composerId: 'c1', sectionId: 'workspace:ft', isActive: false, selectorPath: '' },
            { title: 'Add dark mode', composerId: 'c2', sectionId: 'workspace:ft', isActive: false, selectorPath: '' },
          ],
        },
        {
          name: 'OtherRepo', sectionId: 'repo:other', kind: 'repo', isCurrent: false,
          agents: [
            { title: 'Unrelated work', composerId: 'c9', sectionId: 'repo:other', isActive: false, selectorPath: '' },
          ],
        },
      ],
    } as CursorState);

    firePatch(env.mockSocket, { agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    await new Promise((r) => setTimeout(r, 5200));

    const where = env.document.getElementById('finished-where')!;
    assert.match(where.textContent!, /FactoryTycoonGame/, 'banner names the finished agent\'s folder');
    assert.doesNotMatch(where.textContent!, /OtherRepo/, 'banner does not name an unrelated folder');

    const finished = notifications().filter((n) => n.tag === 'cursor-finished');
    assert.equal(finished.length, 1);
    assert.match(finished[0].body || '', /FactoryTycoonGame/);
  });

  it('plays a distinct sound when the agent asks a question', async () => {
    const tones = () => (env.window as any).__tones as Array<{ freq: number; type: string }>;
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');

    // Working, then a questionnaire appears — the "needs you" transition.
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true });
    assert.equal(tones().length, 0, 'no sound while working');
    // Audio is unlocked on the first user gesture; simulate one so the chimes
    // are allowed to play (mirrors a real tap before the agent asks anything).
    env.window.dispatchEvent(new env.window.KeyboardEvent('keydown'));
    firePatch(env.mockSocket, {
      questionnaire: {
        questions: [{ number: '1', text: 'Which approach?', options: [], isActive: true }],
        activeIndex: 0,
        totalLabel: '1 / 1',
        skipSelectorPath: '',
        continueSelectorPath: '',
        continueDisabled: false,
      },
    });

    const alert = tones().slice();
    assert.ok(alert.length >= 3, 'alert motif uses three notes');
    // The alert motif is triangle-wave (distinct timbre from the finished sine chime).
    assert.ok(alert.every((t) => t.type === 'triangle'), 'alert uses a distinct timbre');
    const alertFreqs = alert.map((t) => t.freq);

    // Now finish and confirm the finished chime is a DIFFERENT motif.
    tones().length = 0;
    firePatch(env.mockSocket, {
      questionnaire: null,
      agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null,
    });
    await new Promise((r) => setTimeout(r, 5200));
    const finished = tones().slice();
    assert.ok(finished.length >= 1, 'finished chime played');
    assert.ok(finished.every((t) => t.type === 'sine'), 'finished uses the sine chime');

    assert.notDeepEqual(
      finished.map((t) => t.freq),
      alertFreqs,
      'question alert and finished chime are different sounds'
    );
  });

  it('does not ping finished when the socket drops (phone lock / sleep)', async () => {
    // Regression: isAgentWorking() is false while disconnected, so a transport
    // drop used to look like "working → idle" and fire a finish chime ~5s after
    // locking the phone — even when nothing had finished.
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      canAbort: true,
      activeComposerId: 'c-working',
    });
    env.mockSocket.fire('connection:status', { connected: false });
    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(
      notifications().filter((n) => n.tag === 'cursor-finished').length,
      0,
      'disconnect must not look like a finish'
    );
    const overlay = env.document.getElementById('finished-overlay')!;
    assert.ok(overlay.classList.contains('hidden'), 'no finished banner on disconnect');
  });

  it('does not ping finished when switching to another (idle) composer', async () => {
    // Regression: opening a folder/agent after watching a working one used to
    // attribute the previous "was working" bit to the new idle chat and ping.
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      canAbort: true,
      activeComposerId: 'c-working',
      chatTabs: [
        { composerId: 'c-working', title: 'Busy agent', isActive: true, status: 'active', selectorPath: '' },
        { composerId: 'c-idle', title: 'Idle agent', isActive: false, status: 'idle', selectorPath: '' },
      ],
    } as CursorState);

    // Switch to a different, idle composer (folder navigation).
    fireFullState(env.mockSocket, {
      ...fixture[1].state!,
      agentStatus: 'idle',
      canAbort: false,
      agentActivityLive: false,
      agentActivityText: null,
      activeComposerId: 'c-idle',
      chatTabs: [
        { composerId: 'c-working', title: 'Busy agent', isActive: false, status: 'idle', selectorPath: '' },
        { composerId: 'c-idle', title: 'Idle agent', isActive: true, status: 'idle', selectorPath: '' },
      ],
    } as CursorState);

    await new Promise((r) => setTimeout(r, 5200));
    assert.equal(
      notifications().filter((n) => n.tag === 'cursor-finished').length,
      0,
      'composer switch must re-prime, not fire a finish'
    );
  });
});

// ─── Stall nudge / forced refresh ───

describe('web: no-updates indicator and refresh', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  // The "no updates" hint is no longer a full-width banner — it is the small
  // header refresh button, which swaps to a spinner (`.stalled`) on a stall.
  const indicator = () => env.document.getElementById('btn-refresh')!;
  const spinner = () => indicator().querySelector('.header-refresh-spinner')!;

  it('marks the small refresh button only when a stall is reported while working', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true, agentStalled: false });
    assert.ok(indicator().classList.contains('hidden'), 'hidden while progressing');
    assert.ok(!indicator().classList.contains('stalled'), 'not stalled while progressing');

    firePatch(env.mockSocket, { agentStalled: true });
    assert.ok(!indicator().classList.contains('hidden'), 'button appears on a stall');
    assert.ok(indicator().classList.contains('stalled'), 'shows the spinner state');
    assert.ok(spinner(), 'the inline spinner exists');
  });

  it('does not nag for an idle agent', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...fixture[4].state!,
      agentStalled: true,
      agentStatus: 'idle',
      canAbort: false,
      agentActivityLive: false,
    });
    assert.ok(indicator().classList.contains('hidden'), 'idle frozen state is not a stall');
    assert.ok(!indicator().classList.contains('stalled'), 'no spinner for an idle agent');
  });

  it('tapping the small button sends command:refresh_state to the relay', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true, agentStalled: true });

    indicator().click();

    const sent = env.mockSocket.sent.find((s) => s.event === 'command:refresh_state');
    assert.ok(sent, 'emits command:refresh_state');
    assert.equal(sent!.payload.type, 'refresh_state');
    assert.ok(sent!.payload.commandId, 'carries a commandId');
  });

  it('hides the indicator as soon as a refresh is requested', async () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true, agentStalled: true });
    assert.ok(!indicator().classList.contains('hidden'));

    indicator().click();
    // Resolve the pending command so the await returns.
    const sent = env.mockSocket.sent.find((s) => s.event === 'command:refresh_state')!;
    env.mockSocket.fire('command:result', { commandId: sent.payload.commandId, ok: true });
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(indicator().classList.contains('hidden'), 'cleared after a refresh');
  });

  it('clears the indicator when the relay returns a fresh non-stalled state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, { ...fixture[1].state!, canAbort: true, agentStalled: true });
    assert.ok(!indicator().classList.contains('hidden'));

    fireFullState(env.mockSocket, { ...fixture[4].state!, agentStalled: false });
    assert.ok(indicator().classList.contains('hidden'), 'fresh state hides the indicator');
  });

  it('no longer renders the oversized banner', () => {
    assert.equal(env.document.getElementById('stall-nudge'), null, 'banner markup removed');
    assert.equal(env.document.getElementById('btn-stall-refresh'), null, 'banner button removed');
  });
});

// ─── Message rendering ───

describe('web: message rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders human message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const humanEl = msgs.querySelector('.el-human');
    assert.ok(humanEl, 'Should render human message (.el-human)');
    assert.match(humanEl!.textContent!, /Fix the bug/);
  });

  it('renders assistant message', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    assert.ok(msgs.querySelector('.el-assistant'), 'Should render assistant message (.el-assistant)');
  });

  it('renders tool element with filename', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[4].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render tool messages (.el-tool)');
  });

  it('updates messages on patch', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const initialCount = msgs.querySelectorAll('[data-id]').length;

    firePatch(env.mockSocket, {
      messages: fixture[4].state!.messages,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
    });
    const updatedCount = msgs.querySelectorAll('[data-id]').length;
    assert.ok(updatedCount > initialCount, `Expected more messages after patch, got ${initialCount} -> ${updatedCount}`);
  });
});

// ─── Run command / approval rendering ───

describe('web: approval widgets', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders run_command with command text', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCard = msgs.querySelector('.run-card');
    assert.ok(runCard, 'Should render run_command card');
    assert.match(runCard!.textContent!, /npm test/);
  });

  it('renders run_command with Skip and Run buttons', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const buttons = msgs.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ run buttons, got ${buttons.length}`);
  });

  it('preserves command text across updates', () => {
    const fixture = loadFixture('approval-widget-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    fireFullState(env.mockSocket, fixture[2].state!);
    const msgs = env.document.getElementById('messages')!;
    const runCards = msgs.querySelectorAll('.run-card');
    const hasNpmTest = Array.from(runCards).some(
      card => card.textContent!.includes('npm test')
    );
    assert.ok(hasNpmTest, 'npm test should be preserved in run cards');
  });
});

// ─── Plan widget rendering ───

describe('web: plan widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders plan block with title and progress', () => {
    const fixture = loadFixture('plan-widget.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const planEl = msgs.querySelector('.el-plan');
    assert.ok(planEl, 'Should render plan block (.el-plan)');
    assert.match(planEl!.textContent!, /Auth System/);
  });
});

// ─── Code block rendering ───

describe('web: code block rendering', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders diff block with viewport', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const diffBlock = msgs.querySelector('.code-block-viewport');
    assert.ok(diffBlock, 'Should render a code block viewport');
  });

  it('preserves newlines in code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const codeEl = msgs.querySelector('.code-block-viewport pre code');
    if (codeEl) {
      const text = codeEl.textContent ?? '';
      assert.ok(text.includes('\n'), 'Code block text should preserve newlines');
    }
  });

  it('renders assistant message with code blocks', () => {
    const fixture = loadFixture('code-block-diff.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const msgs = env.document.getElementById('messages')!;
    const assistant = msgs.querySelector('.el-assistant');
    assert.ok(assistant, 'Should render assistant message (.el-assistant)');
  });
});

// ─── Folders drawer ───

describe('web: folders drawer', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function stateWithFolders(): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      folders: [
        {
          name: 'FactoryTycoonGame',
          sectionId: 'workspace:abc',
          kind: 'workspace',
          isCurrent: true,
          agents: [
            { title: 'Roblox factory game design', composerId: '', sectionId: 'workspace:abc', isActive: false, selectorPath: '' },
          ],
        },
        {
          name: 'beabee',
          sectionId: 'repo:github.com/juliasabel/beabee',
          kind: 'repo',
          isCurrent: false,
          agents: [
            { title: 'Game currency and lives', composerId: '', sectionId: 'repo:x', isActive: false, selectorPath: '' },
          ],
        },
      ],
    };
  }

  it('shows the Folders header button when folders exist', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    const btn = env.document.getElementById('btn-folders')!;
    assert.ok(!btn.classList.contains('hidden'), 'Folders button should be visible');
  });

  it('hides the Folders button when there are no folders', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const btn = env.document.getElementById('btn-folders')!;
    assert.ok(btn.classList.contains('hidden'), 'Folders button should be hidden');
  });

  it('lists every folder and its agents when opened', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    const btn = env.document.getElementById('btn-folders')!;
    btn.click();
    const list = env.document.getElementById('sheet-folders-list')!;
    const sections = list.querySelectorAll('.folder-section');
    assert.equal(sections.length, 2, 'Should render both folders');
    assert.match(list.textContent!, /FactoryTycoonGame/);
    assert.match(list.textContent!, /beabee/);
    assert.match(list.textContent!, /Roblox factory game design/);
    const agentBtns = list.querySelectorAll('.folder-agent');
    assert.equal(agentBtns.length, 2, 'Should render both agents');
  });

  it('marks the current folder', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    env.document.getElementById('btn-folders')!.click();
    const list = env.document.getElementById('sheet-folders-list')!;
    const current = list.querySelectorAll('.folder-header.current');
    assert.equal(current.length, 1, 'Exactly one folder should be marked current');
    assert.match(current[0].textContent!, /FactoryTycoonGame/);
  });

  it('emits command:open_folder_agent with composerId when tapping an agent', () => {
    const state = stateWithFolders();
    state.folders[0].agents[0].composerId = 'composer-abc-123';
    fireFullState(env.mockSocket, state);
    env.document.getElementById('btn-folders')!.click();
    const list = env.document.getElementById('sheet-folders-list')!;
    const agentBtn = list.querySelector('.folder-agent') as HTMLButtonElement;
    assert.ok(agentBtn, 'Agent row should render');
    agentBtn.click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent').pop();
    assert.ok(evt, 'command:open_folder_agent should be emitted');
    assert.equal(evt!.payload.composerId, 'composer-abc-123');
    assert.equal(evt!.payload.tabTitle, 'Roblox factory game design');
    assert.equal(evt!.payload.type, 'open_folder_agent');
  });

  it('does not switch back to the previous chat when a folder agent is picked', () => {
    // Regression: tapping a folder agent loaded its history, then the very next
    // render re-requested the stale `state.activeComposerId` (the server's DOM
    // had not switched yet), yanking the user straight back.
    const state = stateWithFolders();
    state.activeComposerId = 'composer-old';
    state.folders[0].agents[0].composerId = 'composer-new';
    fireFullState(env.mockSocket, state);

    // Drain any history requests made during the initial render.
    env.mockSocket.sent.length = 0;

    env.document.getElementById('btn-folders')!.click();
    const list = env.document.getElementById('sheet-folders-list')!;
    const agentBtn = list.querySelector('.folder-agent') as HTMLButtonElement;
    agentBtn.click();

    const requested = env.mockSocket.sent
      .filter(s => s.event === 'request:history')
      .map(s => s.payload.composerId);
    assert.ok(requested.includes('composer-new'), 'should request the picked chat');
    assert.ok(!requested.includes('composer-old'), 'must not request the previous chat');

    // Even after a poll carrying the stale active composer, no switch-back.
    env.mockSocket.sent.length = 0;
    firePatch(env.mockSocket, { activeComposerId: 'composer-old' });
    const after = env.mockSocket.sent.filter(s => s.event === 'request:history');
    assert.equal(after.length, 0, 'stale active composer must not override the selection');
  });

  it('follows the server composer again once it catches up to the selection', () => {
    const state = stateWithFolders();
    state.activeComposerId = 'composer-old';
    state.folders[0].agents[0].composerId = 'composer-new';
    fireFullState(env.mockSocket, state);

    env.document.getElementById('btn-folders')!.click();
    const agentBtn = env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent') as HTMLButtonElement;
    agentBtn.click();
    env.mockSocket.sent.length = 0;

    // Server catches up: active composer is now the picked one.
    firePatch(env.mockSocket, { activeComposerId: 'composer-new' });

    // No duplicate request (already loaded), and the pin is released.
    const reqs = env.mockSocket.sent.filter(s => s.event === 'request:history');
    assert.equal(reqs.length, 0, 'no redundant request once the server agrees');

    // A genuine later switch still loads.
    firePatch(env.mockSocket, { activeComposerId: 'composer-other' });
    const later = env.mockSocket.sent.filter(s => s.event === 'request:history').pop();
    assert.ok(later, 'a later composer change should still load');
    assert.equal(later!.payload.composerId, 'composer-other');
  });

  it('does not show the previous chat under the new agent while it switches', () => {
    // Regression: opening a different agent pinned the selection, but the live
    // DOM tail still described the OLD composer until the server caught up, so
    // the previous folder's messages rendered under the new agent's name.
    const state = stateWithFolders();
    state.activeComposerId = 'composer-old';
    state.messages = [
      { type: 'human', id: 'old-h', flatIndex: 0, text: 'old question', mentions: [] },
    ] as CursorState['messages'];
    state.folders[0].agents[0].composerId = 'composer-new';
    fireFullState(env.mockSocket, state);
    assert.equal(env.document.querySelectorAll('#messages .chat-el').length, 1, 'old chat visible first');

    env.document.getElementById('btn-folders')!.click();
    const agentBtn = env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent') as HTMLButtonElement;
    agentBtn.click();

    // The server has not switched yet; the old tail must NOT be shown.
    assert.equal(env.document.querySelectorAll('#messages .chat-el').length, 0,
      'previous chat hidden while switching');

    // Once the server agrees (active composer AND its tail move together, as
    // they do in a real extraction patch), the new chat renders and nothing of
    // the old chat remains.
    const newTail = [{ type: 'assistant', id: 'new-a', flatIndex: 0, text: 'new answer', html: '<p>new answer</p>', codeBlocks: [] }];
    fireHistory(env.mockSocket, { composerId: 'composer-new', messages: newTail });
    firePatch(env.mockSocket, { activeComposerId: 'composer-new', messages: newTail as CursorState['messages'] });
    const els = env.document.querySelectorAll('#messages .chat-el');
    assert.equal(els.length, 1);
    assert.equal(els[0].getAttribute('data-id'), 'new-a');
  });
});

// ─── Folders drawer: working indicator ───

describe('web: folders working indicator', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function stateWithFolders(): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      activeComposerId: '',
      folders: [
        {
          name: 'FactoryTycoonGame',
          sectionId: 'workspace:abc',
          kind: 'workspace',
          isCurrent: true,
          agents: [
            { title: 'Agent one', composerId: 'c1', sectionId: 'workspace:abc', isActive: false, selectorPath: '' },
            { title: 'Agent two', composerId: 'c2', sectionId: 'workspace:abc', isActive: false, selectorPath: '' },
          ],
        },
      ],
    };
  }

  function openFolders() {
    env.document.getElementById('btn-folders')!.click();
    return env.document.getElementById('sheet-folders-list')!;
  }

  function agentRow(title: string): HTMLButtonElement | null {
    const list = env.document.getElementById('sheet-folders-list')!;
    const rows = Array.from(list.querySelectorAll('.folder-agent')) as HTMLButtonElement[];
    return rows.find((r) => r.textContent!.includes(title)) ?? null;
  }

  it('shows a spinner on the agent the home window is working on', () => {
    const state = stateWithFolders();
    state.activeComposerId = 'c1';
    // Ground truth: the agent is working.
    fireFullState(env.mockSocket, { ...state, canAbort: true, agentActivityLive: true, agentStatus: 'running_tool' });

    openFolders();
    const one = agentRow('Agent one')!;
    const two = agentRow('Agent two')!;
    assert.ok(one.classList.contains('working'), 'working agent marked');
    assert.ok(one.querySelector('.folder-agent-spinner'), 'working agent has a spinner');
    assert.ok(!two.classList.contains('working'), 'idle agent not marked');
    assert.ok(!two.querySelector('.folder-agent-spinner'), 'idle agent has no spinner');
  });

  it('shows no spinner when the agent is idle', () => {
    const state = stateWithFolders();
    state.activeComposerId = 'c1';
    fireFullState(env.mockSocket, { ...state, canAbort: false, agentActivityLive: false, agentStatus: 'idle' });

    openFolders();
    assert.ok(!agentRow('Agent one')!.querySelector('.folder-agent-spinner'), 'no spinner when idle');
  });

  it('marks an agent working in a non-home window via window:snapshot', () => {
    fireFullState(env.mockSocket, stateWithFolders());

    // A different window reports c2 as actively working.
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'w-other',
      windowTitle: 'Other workspace',
      activeComposerId: 'c2',
      canAbort: true,
      agentActivityLive: true,
      agentStatus: 'running_tool',
    });

    openFolders();
    assert.ok(agentRow('Agent two')!.classList.contains('working'), 'non-home working agent marked');
    assert.ok(!agentRow('Agent one')!.classList.contains('working'), 'unrelated agent not marked');
  });

  it('clears the non-home spinner once that window reports idle', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'w-other',
      activeComposerId: 'c2',
      canAbort: true,
      agentActivityLive: true,
      agentStatus: 'running_tool',
    });
    openFolders();
    assert.ok(agentRow('Agent two')!.classList.contains('working'));

    // Same window now idle → its entry must clear.
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'w-other',
      activeComposerId: 'c2',
      canAbort: false,
      agentActivityLive: false,
      agentStatus: 'idle',
    });
    openFolders();
    assert.ok(!agentRow('Agent two')!.classList.contains('working'), 'spinner cleared when idle');
  });

  it('shows a spinner on EVERY agent Cursor flags working, not just one', () => {
    // Regression: the folder menu used to key status by WINDOW, so only the
    // active agent of each window ever got a glyph. Cursor renders a per-row
    // status on every sidebar agent, so several agents working at once must each
    // show their own spinner.
    const state = stateWithFolders();
    state.folders[0].agents[0].agentStatus = 'working';
    state.folders[0].agents[1].agentStatus = 'working';
    fireFullState(env.mockSocket, state);

    openFolders();
    const one = agentRow('Agent one')!;
    const two = agentRow('Agent two')!;
    assert.ok(one.classList.contains('working'), 'first working agent marked');
    assert.ok(two.classList.contains('working'), 'second working agent marked');
    assert.ok(one.querySelector('.folder-agent-spinner'), 'first agent has a spinner');
    assert.ok(two.querySelector('.folder-agent-spinner'), 'second agent has a spinner');
  });

  it('shows no spinner for an agent Cursor marks completed', () => {
    const state = stateWithFolders();
    state.folders[0].agents[0].agentStatus = 'completed';
    fireFullState(env.mockSocket, state);
    openFolders();
    assert.ok(!agentRow('Agent one')!.querySelector('.folder-agent-spinner'), 'completed agent is not spinning');
  });

  it('shows a needs-you badge when Cursor flags a row needs-attention', () => {
    const state = stateWithFolders();
    state.folders[0].agents[0].agentStatus = 'needs_attention';
    fireFullState(env.mockSocket, state);
    openFolders();
    const one = agentRow('Agent one')!;
    assert.ok(one.classList.contains('needs-input'), 'needs-input class set');
    assert.ok(one.querySelector('.folder-agent-needs'), 'needs badge rendered');
    assert.ok(!one.querySelector('.folder-agent-spinner'), 'a needs-you agent shows no spinner');
  });

  it('flags the header Folders button when any agent needs attention', () => {
    const state = stateWithFolders();
    state.folders[0].agents[1].agentStatus = 'needs_attention';
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-folders')!;
    assert.ok(btn.classList.contains('needs-input'), 'header button flagged for needs-attention');
  });
});

// ─── Creating a folder agent ───

describe('web: create folder agent', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function foldersState(activeComposerId: string, agents: Array<Partial<CursorState['folders'][number]['agents'][number]>>): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      connected: true,
      activeComposerId,
      chatTabs: [],
      folders: [
        {
          name: 'FactoryTycoonGame',
          sectionId: 'workspace:abc',
          kind: 'workspace',
          isCurrent: true,
          agents: agents.map((a) => ({
            title: a.title ?? 'Agent',
            composerId: a.composerId ?? '',
            sectionId: 'workspace:abc',
            isActive: a.isActive ?? false,
            selectorPath: '',
          })),
        },
      ],
    };
  }

  function human(id: string, text: string) {
    return { type: 'human', id, flatIndex: 0, text, mentions: [] };
  }
  function assistant(id: string, text: string) {
    return { type: 'assistant', id, flatIndex: 0, text, html: `<p>${text}</p>`, codeBlocks: [] };
  }

  function openFolderAndCreate() {
    const list = env.document.getElementById('sheet-folders-list')!;
    const header = list.querySelector('.folder-header') as HTMLElement;
    header.click();
  }

  it('does not render the previous chat when a new agent has no history yet', () => {
    // Regression: creating a folder agent cleared history, but the next state
    // patch still carried the PREVIOUS composer's live DOM tail, so the previous
    // folder's messages stayed on screen. The transcript must go empty until the
    // new agent is actually adopted.
    const state = foldersState('composer-old', [{ title: 'Old chat', composerId: 'composer-old', isActive: true }]);
    fireFullState(env.mockSocket, state);
    fireHistory(env.mockSocket, {
      composerId: 'composer-old',
      messages: [human('h1', 'old question'), assistant('a1', 'old answer')],
    });
    assert.equal(env.document.querySelectorAll('#messages .chat-el').length, 2, 'old chat rendered');

    env.document.getElementById('btn-folders')!.click();
    openFolderAndCreate();

    // The server still reports the OLD composer's live tail while it switches.
    firePatch(env.mockSocket, {
      activeComposerId: 'composer-old',
      messages: [human('h1', 'old question'), assistant('a1', 'old answer')] as CursorState['messages'],
    });

    const els = env.document.querySelectorAll('#messages .chat-el');
    assert.equal(els.length, 0, `previous transcript must be cleared, got ${els.length}`);
  });

  it('ignores a late history payload for the previous composer after creating', () => {
    const state = foldersState('composer-old', [{ title: 'Old chat', composerId: 'composer-old', isActive: true }]);
    fireFullState(env.mockSocket, state);
    env.document.getElementById('btn-folders')!.click();
    openFolderAndCreate();

    // The new agent appears and the server switches to it.
    firePatch(env.mockSocket, {
      activeComposerId: 'composer-new',
      folders: foldersState('composer-new', [
        { title: 'Old chat', composerId: 'composer-old', isActive: false },
        { title: 'New chat', composerId: 'composer-new', isActive: true },
      ]).folders,
    });

    // A late payload for the OLD composer arrives — it must be dropped.
    fireHistory(env.mockSocket, {
      composerId: 'composer-old',
      messages: [human('h1', 'old question'), assistant('a1', 'old answer')],
    });
    assert.equal(env.document.querySelectorAll('#messages .chat-el').length, 0, 'stale history not rendered');
  });

  it('pins the newly created agent so it switches deterministically', async () => {
    const state = foldersState('composer-old', [{ title: 'Old chat', composerId: 'composer-old', isActive: true }]);
    fireFullState(env.mockSocket, state);
    env.document.getElementById('btn-folders')!.click();
    openFolderAndCreate();

    // Resolve the create command, then reveal the new composer via state before
    // the post-create refresh resolves.
    const create = env.mockSocket.sent.filter(s => s.event === 'command:create_folder_agent').pop()!;
    env.mockSocket.sent.length = 0;
    env.mockSocket.fire('command:result', { commandId: create.payload.commandId, ok: true });
    firePatch(env.mockSocket, {
      activeComposerId: 'composer-new',
      folders: foldersState('composer-new', [
        { title: 'Old chat', composerId: 'composer-old', isActive: false },
        { title: 'New chat', composerId: 'composer-new', isActive: true },
      ]).folders,
    });

    // Complete the refresh the create flow awaited before it snoops for the new
    // composer.
    const refresh = env.mockSocket.sent.filter(s => s.event === 'command:refresh_state').pop();
    if (refresh) env.mockSocket.fire('command:result', { commandId: refresh.payload.commandId, ok: true });
    await new Promise((r) => setTimeout(r, 60));

    const requested = env.mockSocket.sent
      .filter(s => s.event === 'request:history')
      .map(s => s.payload.composerId);
    assert.ok(requested.includes('composer-new'), 'new agent history requested');
    assert.ok(!requested.includes('composer-old'), 'previous agent must not be re-requested');
  });
});

// ─── Archive a folder agent ───

describe('web: archive folder agent', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function stateWithFolders(): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      activeComposerId: '',
      folders: [
        {
          name: 'FactoryTycoonGame',
          sectionId: 'workspace:abc',
          kind: 'workspace',
          isCurrent: true,
          agents: [
            { title: 'Roblox factory game design', composerId: 'composer-abc', sectionId: 'workspace:abc', isActive: false, selectorPath: '' },
          ],
        },
      ],
    };
  }

  function openFolders() {
    env.document.getElementById('btn-folders')!.click();
    return env.document.getElementById('sheet-folders-list')!;
  }

  it('renders an archive control on every agent row', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    const list = openFolders();
    const row = list.querySelector('.folder-agent-row')!;
    assert.ok(row, 'agent row wrapper rendered');
    const archive = row.querySelector('.folder-agent-archive') as HTMLButtonElement;
    assert.ok(archive, 'archive button rendered');
    assert.match(archive.getAttribute('aria-label')!, /Archive Roblox factory game design/);
    // The tap-to-open button is still inside the row (regression guard: the
    // archive wrapper must not swallow it).
    assert.ok(row.querySelector('.folder-agent'), 'open button still present');
  });

  it('arms the row on first tap instead of archiving immediately', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    const list = openFolders();
    (list.querySelector('.folder-agent-archive') as HTMLButtonElement).click();

    // Destructive action is two-step: nothing emitted, Cancel/Archive shown.
    assert.equal(env.mockSocket.sent.filter(s => s.event === 'command:archive_folder_agent').length, 0,
      'no archive command on the arming tap');
    const rearmed = env.document.getElementById('sheet-folders-list')!;
    assert.ok(rearmed.querySelector('.folder-agent-cancel'), 'cancel button shown');
    assert.ok(rearmed.querySelector('.folder-agent-confirm'), 'confirm button shown');
  });

  it('cancel disarms the row without archiving', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    openFolders();
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-archive') as HTMLButtonElement).click();
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-cancel') as HTMLButtonElement).click();

    assert.equal(env.mockSocket.sent.filter(s => s.event === 'command:archive_folder_agent').length, 0,
      'cancel must not emit an archive command');
    const list = env.document.getElementById('sheet-folders-list')!;
    assert.ok(list.querySelector('.folder-agent-archive'), 'row returns to the single archive icon');
    assert.ok(!list.querySelector('.folder-agent-confirm'), 'confirm pair removed');
  });

  it('emits command:archive_folder_agent with the agent target on confirm', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    openFolders();
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-archive') as HTMLButtonElement).click();
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-confirm') as HTMLButtonElement).click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:archive_folder_agent').pop();
    assert.ok(evt, 'archive command emitted');
    assert.equal(evt!.payload.type, 'archive_folder_agent');
    assert.equal(evt!.payload.composerId, 'composer-abc');
    assert.equal(evt!.payload.tabTitle, 'Roblox factory game design');
    assert.equal(evt!.payload.archiveAction, 'archive');
  });

  it('does not open the agent when tapping the archive control', () => {
    fireFullState(env.mockSocket, stateWithFolders());
    openFolders();
    env.mockSocket.sent.length = 0;
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-archive') as HTMLButtonElement).click();

    assert.equal(env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent').length, 0,
      'archive tap must not trigger the row open handler');
  });

  it('keeps the row armed across a state push', () => {
    // A push arriving mid-confirm re-renders the drawer; the armed pair must
    // survive so the user's second tap still lands.
    fireFullState(env.mockSocket, stateWithFolders());
    openFolders();
    (env.document.getElementById('sheet-folders-list')!.querySelector('.folder-agent-archive') as HTMLButtonElement).click();

    firePatch(env.mockSocket, { folders: stateWithFolders().folders });
    const list = env.document.getElementById('sheet-folders-list')!;
    assert.ok(list.querySelector('.folder-agent-confirm'), 'confirm still armed after a push');
  });
});

// ─── Auto-open chat on load ───

describe('web: auto-open chat', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
    // Auto-open only runs for a logged-in session.
    env.window.localStorage.setItem('cursor-remote-token', 'test-token');
  });

  function agentState(overrides?: Partial<CursorState>): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      messages: [],
      canAbort: false,
      agentActivityLive: false,
      agentStatus: 'idle',
      activeComposerId: '',
      chatTabs: [],
      folders: [
        {
          name: 'FactoryTycoonGame',
          sectionId: 'workspace:abc',
          kind: 'workspace',
          isCurrent: false,
          agents: [
            { title: 'Roblox factory game design', composerId: 'composer-aaa', sectionId: 'workspace:abc', isActive: false, selectorPath: '' },
          ],
        },
        {
          name: 'beabee',
          sectionId: 'repo:github.com/juliasabel/beabee',
          kind: 'repo',
          isCurrent: false,
          agents: [
            { title: 'Game currency and lives', composerId: 'composer-bbb', sectionId: 'repo:x', isActive: false, selectorPath: '' },
          ],
        },
      ],
      ...overrides,
    };
  }

  it('opens the relay\'s current composer automatically instead of waiting for a tap', () => {
    fireFullState(env.mockSocket, agentState({ activeComposerId: 'composer-aaa' }));

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent').pop();
    assert.ok(evt, 'should auto-emit command:open_folder_agent');
    assert.equal(evt!.payload.composerId, 'composer-aaa');
    assert.equal(evt!.payload.type, 'open_folder_agent');
  });

  it('falls back to the most recent agent when no composer is current', () => {
    fireFullState(env.mockSocket, agentState());

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent').pop();
    assert.ok(evt, 'should auto-open the last agent with a composer id');
    assert.equal(evt!.payload.composerId, 'composer-bbb');
  });

  it('does not auto-open when a chat is already loaded', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, {
      ...agentState({ activeComposerId: 'composer-aaa' }),
      messages: fixture[1].state!.messages,
    });

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent');
    assert.equal(evt.length, 0, 'no auto-open once messages are present');
  });

  it('does not auto-open once per render (bounded attempts)', () => {
    fireFullState(env.mockSocket, agentState({ activeComposerId: 'composer-aaa' }));
    firePatch(env.mockSocket, { folders: agentState({ activeComposerId: 'composer-aaa' }).folders });

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:open_folder_agent');
    assert.equal(evt.length, 1, 'should only fire one auto-open attempt without a new connection');
  });
});

// ─── Notifications (web push) sheet ───

describe('web: notifications sheet', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('opens the notifications sheet when tapping the header bell', () => {
    const btn = env.document.getElementById('btn-notify')!;
    assert.ok(btn, 'Notify button should exist');
    btn.click();
    const sheet = env.document.getElementById('sheet-notify')!;
    assert.ok(!sheet.classList.contains('hidden'), 'Notify sheet should be visible');
  });

  it('shows an OFF state and a toggle when push is unsupported (no service worker)', () => {
    env.document.getElementById('btn-notify')!.click();
    const status = env.document.getElementById('notify-status')!;
    const toggle = env.document.getElementById('btn-notify-toggle') as HTMLButtonElement;
    // jsdom has no serviceWorker/PushManager, so the sheet reports unsupported.
    assert.match(status.textContent!, /not supported|OFF|ON/i);
    assert.ok(toggle.textContent!.length > 0, 'Toggle should have a label');
  });
});

// ─── Fetch tool rendering ───

describe('web: fetch tool', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders fetch tool with action text and URL', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool (.el-tool)');
    assert.match(toolEl!.textContent!, /Fetch/);
    assert.match(toolEl!.textContent!, /reddit\.com/);
  });

  it('renders fetch tool with approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[1].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEl = msgs.querySelector('.el-tool');
    assert.ok(toolEl, 'Should render fetch tool');
    const actionRow = toolEl!.querySelector('.tool-actions-row');
    assert.ok(actionRow, 'Should have tool-actions-row with buttons');
    const buttons = actionRow!.querySelectorAll('.run-btn');
    assert.ok(buttons.length >= 2, `Expected 2+ action buttons, got ${buttons.length}`);
  });

  it('renders completed fetch tool without approval buttons', () => {
    const fixture = loadFixture('fetch-tool.jsonl');
    fireFullState(env.mockSocket, fixture[3].state!);
    const msgs = env.document.getElementById('messages')!;
    const toolEls = msgs.querySelectorAll('.el-tool');
    assert.ok(toolEls.length > 0, 'Should render fetch tool');
    const lastTool = toolEls[toolEls.length - 1];
    const actionRow = lastTool.querySelector('.tool-actions-row');
    assert.ok(!actionRow, 'Completed tool should not have action buttons');
  });
});

// ─── Mode/model pill rendering ───

describe('web: mode/model pills', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  it('renders mode and model from state', () => {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    fireFullState(env.mockSocket, fixture[0].state!);
    const modeText = env.document.getElementById('pill-mode-text')!;
    const modelText = env.document.getElementById('pill-model-text')!;
    assert.ok(modeText.textContent!.length > 0, 'Mode text should be set');
    assert.ok(modelText.textContent!.length > 0, 'Model text should be set');
  });
});

// ─── Questionnaire widget rendering ───

describe('web: questionnaire widget', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function baseState(): CursorState {
    return {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: Date.now(),
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      agentStalled: false,
      agentStalledSince: null,
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      mode: { current: 'agent', available: [] },
      model: { current: 'Auto', currentId: '' },
      windows: [],
      activeWindowId: '',
      composerQueue: { items: [] },
      questionnaire: null,
    };
  }

  it('hides questionnaire bar when questionnaire is null', () => {
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'Questionnaire bar should be hidden');
  });

  it('shows questionnaire bar with questions', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Pick a color?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-red' },
            { letter: 'B', label: 'Blue', isFreeform: false, selectorPath: 'sp-blue' },
          ],
        },
      ],
      activeIndex: 0,
      totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip',
      continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Questionnaire bar should be visible');
    const stepper = env.document.getElementById('questionnaire-stepper')!;
    assert.equal(stepper.textContent, '1 of 1');
    const questions = bar.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 1);
    const options = bar.querySelectorAll('.questionnaire-option');
    assert.equal(options.length, 2);
    assert.match(options[0].textContent!, /A.*Red/);
    assert.match(options[1].textContent!, /B.*Blue/);
  });

  it('disables continue button when continueDisabled is true', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: true,
    };
    fireFullState(env.mockSocket, state);
    const btn = env.document.getElementById('btn-q-continue')! as HTMLButtonElement;
    assert.ok(btn.disabled, 'Continue should be disabled');
  });

  it('hides questionnaire bar when questionnaire becomes null via patch', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'Should be visible initially');

    firePatch(env.mockSocket, { questionnaire: null });
    assert.ok(bar.classList.contains('hidden'), 'Should hide after patch with null');
  });

  it('marks active question with active class', () => {
    const state = baseState();
    state.questionnaire = {
      questions: [
        { number: '1.', text: 'Q1?', isActive: false, options: [] },
        { number: '2.', text: 'Q2?', isActive: true, options: [] },
      ],
      activeIndex: 1, totalLabel: '1 of 2',
      skipSelectorPath: '', continueSelectorPath: '',
      continueDisabled: false,
    };
    fireFullState(env.mockSocket, state);
    const questions = env.document.querySelectorAll('.questionnaire-question');
    assert.equal(questions.length, 2);
    assert.ok(!questions[0].classList.contains('questionnaire-question-active'));
    assert.ok(questions[1].classList.contains('questionnaire-question-active'));
  });

  it('surfaces a non-home window questionnaire delivered via window:snapshot', () => {
    // Regression: a question raised in a window other than the relay's CDP home
    // window only reaches the phone through `window:snapshot`. The client used
    // to have no listener, so the bar stayed hidden and the question was
    // unanswerable from the web app.
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'Hidden before any snapshot');

    fireWindowSnapshot(env.mockSocket, {
      windowId: 'win-other',
      windowTitle: 'Other Project',
      questionnaire: {
        questions: [
          {
            number: '1.', text: 'Which DB?', isActive: true,
            options: [
              { letter: 'A', label: 'Postgres', isFreeform: false, selectorPath: 'p1' },
              { letter: 'B', label: 'SQLite', isFreeform: false, selectorPath: 'p2' },
            ],
          },
        ],
        activeIndex: 0,
        totalLabel: '1 of 1',
        skipSelectorPath: 'skip-x',
        continueSelectorPath: 'cont-x',
        continueDisabled: false,
      },
    });

    assert.ok(!bar.classList.contains('hidden'), 'Visible after window:snapshot');
    assert.equal(bar.querySelectorAll('.questionnaire-option').length, 2);
  });

  it('routes a non-home window answer back to that window', () => {
    fireFullState(env.mockSocket, baseState());
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'win-other',
      windowTitle: 'Other Project',
      questionnaire: {
        questions: [
          {
            number: '1.', text: 'Which DB?', isActive: true,
            options: [
              { letter: 'A', label: 'Postgres', isFreeform: false, selectorPath: 'p1' },
              { letter: 'B', label: 'SQLite', isFreeform: false, selectorPath: 'p2' },
            ],
          },
        ],
        activeIndex: 0,
        totalLabel: '1 of 1',
        skipSelectorPath: 'skip-x',
        continueSelectorPath: 'cont-x',
        continueDisabled: false,
      },
    });

    const firstOption = env.document.querySelector('.questionnaire-option')! as HTMLButtonElement;
    firstOption.click();

    const click = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.ok(click, 'click_action should have been emitted');
    assert.equal(click!.payload.selectorPath, 'p1');
    assert.equal(click!.payload.actionLabel, 'Postgres');
    assert.equal(click!.payload.windowId, 'win-other');
  });

  it('emits Skip/Continue with the windowId of the active questionnaire', () => {
    fireFullState(env.mockSocket, baseState());
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'win-other',
      windowTitle: 'Other Project',
      questionnaire: {
        questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
        activeIndex: 0, totalLabel: '1 of 1',
        skipSelectorPath: 'skip-x',
        continueSelectorPath: 'cont-x',
        continueDisabled: false,
      },
    });

    env.document.getElementById('btn-q-skip')!.click();
    const skip = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.equal(skip!.payload.selectorPath, 'skip-x');
    assert.equal(skip!.payload.windowId, 'win-other');

    env.document.getElementById('btn-q-continue')!.click();
    const cont = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.equal(cont!.payload.selectorPath, 'cont-x');
    assert.equal(cont!.payload.actionLabel, 'Continue');
    assert.equal(cont!.payload.windowId, 'win-other');
  });

  it('clears the remote questionnaire when a later snapshot has null', () => {
    fireFullState(env.mockSocket, baseState());
    const bar = env.document.getElementById('questionnaire-bar')!;
    fireWindowSnapshot(env.mockSocket, {
      windowId: 'win-other',
      windowTitle: 'Other Project',
      questionnaire: {
        questions: [{ number: '1.', text: 'Q?', isActive: true, options: [] }],
        activeIndex: 0, totalLabel: '1 of 1',
        skipSelectorPath: '', continueSelectorPath: '',
        continueDisabled: false,
      },
    });
    assert.ok(!bar.classList.contains('hidden'));

    fireWindowSnapshot(env.mockSocket, {
      windowId: 'win-other',
      windowTitle: 'Other Project',
      questionnaire: null,
    });
    assert.ok(bar.classList.contains('hidden'), 'Hidden after null snapshot');
  });

  function freeformState() {
    const state = baseState();
    state.questionnaire = {
      questions: [
        {
          number: '1.', text: 'Pick one?', isActive: true,
          options: [
            { letter: 'A', label: 'Red', isFreeform: false, selectorPath: 'sp-red' },
            {
              letter: 'C', label: 'Other', isFreeform: true,
              selectorPath: '.tray .ui-tray-option:nth-of-type(2)',
              freeformInputSelectorPath: '.tray .ui-tray-option:nth-of-type(2)',
            },
          ],
        },
      ],
      activeIndex: 0, totalLabel: '1 of 1',
      skipSelectorPath: 'sp-skip', continueSelectorPath: 'sp-continue',
      continueDisabled: false,
    };
    return state;
  }

  it('reveals the inline freeform text box when "Other" is clicked', () => {
    fireFullState(env.mockSocket, freeformState());

    const options = env.document.querySelectorAll('.questionnaire-option');
    const otherBtn = Array.from(options).find(
      o => (o as HTMLElement).dataset.freeform === '1'
    ) as HTMLButtonElement;
    assert.ok(otherBtn, 'freeform option should be rendered');

    otherBtn.click();
    const ff = env.document.querySelector('.questionnaire-freeform');
    assert.ok(ff, 'inline freeform answer box should appear after clicking Other');
    assert.ok(ff!.querySelector('.questionnaire-freeform-input'), 'has a text input');
  });

  it('keeps the inline freeform answer box across state:patch re-renders', () => {
    // Regression: the "Other" box appeared then instantly vanished on the next
    // poll-driven state:patch because renderQuestionnaire() rebuilt the option
    // list. The user could never type a custom answer on the phone.
    const state = freeformState();
    fireFullState(env.mockSocket, state);

    const otherBtn = Array.from(env.document.querySelectorAll('.questionnaire-option')).find(
      o => (o as HTMLElement).dataset.freeform === '1'
    ) as HTMLButtonElement;
    otherBtn.click();

    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(ta, 'freeform box appears');
    ta.value = 'my custom answer';

    // Simulate the frequent poll patches: volatile fields change, structure does not.
    firePatch(env.mockSocket, { questionnaire: { ...state.questionnaire!, continueDisabled: true } });
    firePatch(env.mockSocket, { agentStatus: 'idle' });
    firePatch(env.mockSocket, { questionnaire: { ...state.questionnaire!, continueDisabled: false } });

    const taAfter = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(taAfter, 'freeform box must survive state:patch re-renders');
    assert.equal(taAfter.value, 'my custom answer', 'typed text must be preserved');
    assert.equal(taAfter, ta, 'the same textarea element should be reused, not recreated');
  });

  it('submits the freeform answer via set_answer_text then Continue', async () => {
    fireFullState(env.mockSocket, freeformState());

    const otherBtn = Array.from(env.document.querySelectorAll('.questionnaire-option')).find(
      o => (o as HTMLElement).dataset.freeform === '1'
    ) as HTMLButtonElement;
    otherBtn.click();

    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    ta.value = 'typed custom answer';
    // The send button stays disabled until an input event fires (matches app.js).
    ta.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    const send = env.document.querySelector('.questionnaire-freeform-send') as HTMLButtonElement;
    assert.ok(!send.disabled, 'send should enable once text is entered');
    send.click();

    await new Promise(r => setTimeout(r, 0));
    const setText = env.mockSocket.sent.filter(s => s.event === 'command:set_answer_text').pop();
    assert.ok(setText, 'set_answer_text should be emitted');
    assert.equal(setText!.payload.selectorPath, '.tray .ui-tray-option:nth-of-type(2)');
    assert.equal(setText!.payload.text, 'typed custom answer');

    // Resolve the command so submitFreeformAnswer advances to Continue.
    env.mockSocket.fire('command:result', { commandId: setText!.payload.commandId, ok: true });
    await new Promise(r => setTimeout(r, 0));

    const cont = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.ok(cont, 'Continue should be clicked after typing');
    assert.equal(cont!.payload.actionLabel, 'Continue');
  });

  it('keeps the freeform box (and its text) when a poll briefly reports no questionnaire', () => {
    // Regression: selecting "Other" makes Cursor remount its tray, so a poll can
    // momentarily report `questionnaire: null`. That reset the render key, the
    // next patch rebuilt the option list, and the inline box (with the user's
    // typed text) vanished instantly — "Other" was unusable on the phone.
    const state = freeformState();
    fireFullState(env.mockSocket, state);

    const otherBtn = Array.from(env.document.querySelectorAll('.questionnaire-option')).find(
      o => (o as HTMLElement).dataset.freeform === '1'
    ) as HTMLButtonElement;
    otherBtn.click();

    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(ta, 'freeform box appears');
    ta.value = 'half-typed custom answer';
    ta.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));

    // Simulate the tray remount: null, then the same question again.
    firePatch(env.mockSocket, { questionnaire: null });
    firePatch(env.mockSocket, { questionnaire: state.questionnaire! });

    const taAfter = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.ok(taAfter, 'freeform box must reappear after the tray remount');
    assert.equal(taAfter.value, 'half-typed custom answer', 'typed text must survive the remount');
  });

  it('re-focuses the freeform box after a rebuild so typing continues', () => {
    const state = freeformState();
    fireFullState(env.mockSocket, state);

    const otherBtn = Array.from(env.document.querySelectorAll('.questionnaire-option')).find(
      o => (o as HTMLElement).dataset.freeform === '1'
    ) as HTMLButtonElement;
    otherBtn.click();

    const ta = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.equal(env.document.activeElement, ta, 'input focused right after opening');

    firePatch(env.mockSocket, { questionnaire: null });
    firePatch(env.mockSocket, { questionnaire: state.questionnaire! });

    const taAfter = env.document.querySelector('.questionnaire-freeform-input') as HTMLTextAreaElement;
    assert.equal(env.document.activeElement, taAfter, 'rebuilt input regains focus');
  });
});

// ─── Full history loading (virtualized transcript fix) ───

describe('web: full history', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function stateWith(messages: unknown[], activeComposerId = 'comp-1'): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      connected: true,
      messages: messages as CursorState['messages'],
      activeComposerId,
      chatTabs: [],
      folders: [],
    };
  }

  function human(id: string, text: string) {
    return { type: 'human', id, flatIndex: 0, text, mentions: [] };
  }
  function assistant(id: string, text: string) {
    return { type: 'assistant', id, flatIndex: 0, text, html: `<p>${text}</p>`, codeBlocks: [] };
  }

  it('requests the full transcript once the active composer is known', () => {
    fireFullState(env.mockSocket, stateWith([assistant('a-tail', 'newest')], 'comp-1'));
    const req = env.mockSocket.sent.filter(s => s.event === 'request:history');
    assert.equal(req.length, 1);
    assert.equal(req[0].payload.composerId, 'comp-1');
  });

  it('does not re-request the same composer on subsequent patches', () => {
    fireFullState(env.mockSocket, stateWith([assistant('a-tail', 'newest')], 'comp-1'));
    firePatch(env.mockSocket, { agentStatus: 'idle' });
    firePatch(env.mockSocket, { canAbort: false });
    const req = env.mockSocket.sent.filter(s => s.event === 'request:history');
    assert.equal(req.length, 1);
  });

  it('renders the whole history, not just the virtualized DOM tail', () => {
    // DOM only mounts the newest message; history carries the full chat.
    fireFullState(env.mockSocket, stateWith([assistant('a-tail', 'newest')], 'comp-1'));
    fireHistory(env.mockSocket, {
      composerId: 'comp-1',
      name: 'Long chat',
      total: 40,
      truncated: false,
      messages: [human('h1', 'first'), assistant('a1', 'middle'), assistant('a-tail', 'newest')],
    });

    const els = env.document.querySelectorAll('#messages .chat-el');
    assert.equal(els.length, 3, 'all history messages rendered');
    assert.equal(els[0].getAttribute('data-id'), 'h1');
    assert.equal(els[2].getAttribute('data-id'), 'a-tail');
  });

  it('prefers the live version of a message present in both history and DOM', () => {
    fireFullState(env.mockSocket, stateWith([assistant('a-tail', 'streaming now')], 'comp-1'));
    fireHistory(env.mockSocket, {
      composerId: 'comp-1',
      messages: [human('h1', 'first'), assistant('a-tail', 'stale db copy')],
    });
    const last = env.document.querySelectorAll('#messages .chat-el')[1];
    assert.match(last.textContent!, /streaming now/);
  });

  it('appends live messages that history does not yet contain', () => {
    fireFullState(env.mockSocket, stateWith([assistant('a-new', 'brand new')], 'comp-1'));
    fireHistory(env.mockSocket, {
      composerId: 'comp-1',
      messages: [human('h1', 'first')],
    });
    const els = env.document.querySelectorAll('#messages .chat-el');
    assert.equal(els.length, 2);
    assert.equal(els[1].getAttribute('data-id'), 'a-new');
  });

  it('ignores a history payload for a different composer', () => {
    fireFullState(env.mockSocket, stateWith([assistant('a-tail', 'newest')], 'comp-1'));
    fireHistory(env.mockSocket, {
      composerId: 'other-composer',
      messages: [human('h1', 'belongs elsewhere')],
    });
    // History was requested for comp-1, so comp-2's payload must be dropped.
    const els = env.document.querySelectorAll('#messages .chat-el');
    assert.equal(els.length, 1);
    assert.equal(els[0].getAttribute('data-id'), 'a-tail');
  });
});

// ─── Transcript scroll position ───

describe('web: transcript scroll', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
    // jsdom does not lay out, so fake a scrollable transcript: content is much
    // taller than the viewport, and setting scrollTop is reflected in reads.
    const msgs = env.document.getElementById('messages')! as unknown as HTMLElement & {
      scrollHeight: number; clientHeight: number;
    };
    let top = 0;
    Object.defineProperty(msgs, 'scrollHeight', { get: () => 4000, configurable: true });
    Object.defineProperty(msgs, 'clientHeight', { get: () => 800, configurable: true });
    Object.defineProperty(msgs, 'scrollTop', {
      get: () => top,
      // Browsers clamp scrollTop to [0, scrollHeight - clientHeight]; jsdom
      // does not, so clamp here to model real scrolling behavior.
      set: (v: number) => { top = Math.max(0, Math.min(v, 4000 - 800)); },
      configurable: true,
    });
  });

  function h(id: string, text: string) {
    return { type: 'human', id, flatIndex: 0, text, mentions: [] };
  }

  function scrollableState(messages: unknown[], activeComposerId = 'comp-1'): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      connected: true,
      messages: messages as CursorState['messages'],
      activeComposerId,
      chatTabs: [],
      folders: [],
    };
  }

  function bottomTop(): number {
    const msgs = env.document.getElementById('messages')!;
    return msgs.scrollHeight - msgs.clientHeight;
  }

  it('scrolls to the newest message after loading a fresh transcript', () => {
    fireFullState(env.mockSocket, scrollableState([h('h1', 'old')], 'comp-1'));
    const msgs = env.document.getElementById('messages')!;
    // Long history arrives → transcript is (re)rendered from scratch.
    fireHistory(env.mockSocket, {
      composerId: 'comp-1',
      messages: [h('h1', 'first'), h('h2', 'second'), h('h3', 'third')],
    });
    assert.equal(msgs.scrollTop, bottomTop(), 'should land at the bottom, not the top');
  });

  it('re-pins to the bottom after switching away and back', () => {
    fireFullState(env.mockSocket, scrollableState([h('h1', 'old')], 'comp-1'));
    const msgs = env.document.getElementById('messages')!;
    msgs.scrollTop = 0;

    // Server switches to a different composer (host-side) → new transcript.
    firePatch(env.mockSocket, { activeComposerId: 'comp-2' });
    assert.equal(msgs.scrollTop, bottomTop(), 'a host-side switch should re-pin to the bottom');
  });

  it('does not yank the user down after they scroll up to read', () => {
    fireFullState(env.mockSocket, scrollableState([h('h1', 'old')], 'comp-1'));
    const msgs = env.document.getElementById('messages')!;

    // User scrolls up: the scroll handler flips userScrolledUp.
    msgs.scrollTop = 0;
    msgs.dispatchEvent(new (env.window as any).Event('scroll'));

    // A streaming update arrives (same composer) — must not force them down.
    firePatch(env.mockSocket, {
      messages: [h('h1', 'old'), h('h2', 'streaming')] as CursorState['messages'],
    });
    assert.equal(msgs.scrollTop, 0, 'deliberate scroll position must be respected');
  });
});

// ─── Composer (queued messages) ───

describe('web: composer queue', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  function queueState(items: unknown[], queueLabel?: string, kind?: 'tray' | 'toolbar'): CursorState {
    const fixture = loadFixture('activity-shimmer-lifecycle.jsonl');
    return {
      ...fixture[0].state!,
      connected: true,
      messages: [],
      chatTabs: [],
      folders: [],
      composerQueue: {
        items: items as any,
        ...(queueLabel ? { queueLabel } : {}),
        ...(kind ? { kind } : {}),
      },
    };
  }

  it('shows queued messages with their text', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'q1', text: 'first queued message', sendSelectorPath: '#send-1', removeSelectorPath: '#rm-1' },
      { id: 'q2', text: 'second queued message', sendSelectorPath: '#send-2', removeSelectorPath: '#rm-2' },
    ], '2 Queued'));

    const bar = env.document.getElementById('composer-queue-bar')!;
    assert.ok(!bar.classList.contains('hidden'), 'queue bar should be visible');
    const rows = bar.querySelectorAll('.composer-queue-row');
    assert.equal(rows.length, 2, 'both queued messages rendered');
    assert.match(bar.textContent!, /first queued message/);
    assert.match(bar.textContent!, /second queued message/);
    assert.match(env.document.getElementById('composer-queue-label')!.textContent!, /2 Queued/);
  });

  it('hides the queue bar when there are no queued messages', () => {
    fireFullState(env.mockSocket, queueState([]));
    const bar = env.document.getElementById('composer-queue-bar')!;
    assert.ok(bar.classList.contains('hidden'), 'queue bar hidden when empty');
  });

  it('emits click_action with the row\'s send selector when Send now is tapped', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'q1', text: 'hi', sendSelectorPath: '#send-1', removeSelectorPath: '#rm-1' },
    ]));
    env.mockSocket.sent.length = 0;

    const sendBtn = env.document.querySelector('.composer-queue-send') as HTMLButtonElement;
    assert.ok(sendBtn, 'Send now button should render');
    assert.equal(sendBtn.textContent, 'Send now');
    sendBtn.click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.ok(evt, 'click_action should be emitted');
    assert.equal(evt!.payload.selectorPath, '#send-1');
  });

  it('emits click_action with the row\'s remove selector when ✕ is tapped', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'q1', text: 'hi', sendSelectorPath: '#send-1', removeSelectorPath: '#rm-1' },
    ]));
    env.mockSocket.sent.length = 0;

    const removeBtn = env.document.querySelector('.composer-queue-remove') as HTMLButtonElement;
    assert.ok(removeBtn, 'remove button should render');
    removeBtn.click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:click_action').pop();
    assert.ok(evt, 'click_action should be emitted');
    assert.equal(evt!.payload.selectorPath, '#rm-1');
  });

  it('disables the send button when the row exposes no send selector', () => {
    fireFullState(env.mockSocket, queueState([{ id: 'q1', text: 'hi' }]));
    const sendBtn = env.document.querySelector('.composer-queue-send') as HTMLButtonElement;
    assert.ok(sendBtn.disabled, 'Send now disabled without a selector');
  });

  it('renders tray-kind rows with enabled Send now / remove buttons', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'row-1', text: 'queued via tray' },
    ], '1 Queued', 'tray'));

    const sendBtn = env.document.querySelector('.composer-queue-send') as HTMLButtonElement;
    const removeBtn = env.document.querySelector('.composer-queue-remove') as HTMLButtonElement;
    assert.ok(sendBtn && !sendBtn.disabled, 'Send now enabled for tray rows');
    assert.ok(removeBtn && !removeBtn.disabled, 'remove enabled for tray rows');
  });

  it('emits queue_action(remove) with the row id when a tray ✕ is tapped', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'row-42', text: 'hi from tray' },
    ], '1 Queued', 'tray'));
    env.mockSocket.sent.length = 0;

    const removeBtn = env.document.querySelector('.composer-queue-remove') as HTMLButtonElement;
    removeBtn.click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:queue_action').pop();
    assert.ok(evt, 'queue_action should be emitted');
    assert.equal(evt!.payload.queueItemId, 'row-42');
    assert.equal(evt!.payload.queueAction, 'remove');
  });

  it('emits queue_action(send) with the row id when a tray Send now is tapped', () => {
    fireFullState(env.mockSocket, queueState([
      { id: 'row-7', text: 'hi from tray' },
    ], '1 Queued', 'tray'));
    env.mockSocket.sent.length = 0;

    const sendBtn = env.document.querySelector('.composer-queue-send') as HTMLButtonElement;
    sendBtn.click();

    const evt = env.mockSocket.sent.filter(s => s.event === 'command:queue_action').pop();
    assert.ok(evt, 'queue_action should be emitted');
    assert.equal(evt!.payload.queueItemId, 'row-7');
    assert.equal(evt!.payload.queueAction, 'send');
  });
});

// ─── Session persistence / unexpected logout ───

describe('web: session persistence', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
    env.window.localStorage.setItem('cursor-remote-token', 'valid-token');
  });

  const health = () => (env.window as any).__health as {
    ok: boolean; authRequired: boolean; sessionValid: boolean;
  };

  it('does NOT log out on a burst of transient connect errors', async () => {
    // Plain network failures: no "Unauthorized" message.
    for (let i = 0; i < 12; i++) {
      env.mockSocket.fire('connect_error', new Error('websocket error'));
    }
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(
      env.window.localStorage.getItem('cursor-remote-token'),
      'valid-token',
      'token must survive transport failures'
    );
  });

  it('does not log out when an Unauthorized blip is followed by a healthy /health', async () => {
    // Server restart mid-handshake: one rejection, session still valid.
    health().sessionValid = true;
    env.mockSocket.fire('connect_error', new Error('Unauthorized'));
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(env.window.localStorage.getItem('cursor-remote-token'), 'valid-token');
  });

  it('logs out when the server confirms the session is invalid', async () => {
    health().sessionValid = false;
    env.mockSocket.fire('connect_error', new Error('Unauthorized'));
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(env.window.localStorage.getItem('cursor-remote-token'), null);
  });

  it('keeps the session when /health is unreachable during an Unauthorized blip', async () => {
    health().ok = false; // e.g. 502 from the tunnel
    env.mockSocket.fire('connect_error', new Error('Unauthorized'));
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(
      env.window.localStorage.getItem('cursor-remote-token'),
      'valid-token',
      'unreachable server must not sign the user out'
    );
  });

  it('resets the failure tracking after a successful reconnect', async () => {
    for (let i = 0; i < 6; i++) {
      env.mockSocket.fire('connect_error', new Error('websocket error'));
    }
    env.mockSocket.fire('connect');
    // Reconnecting then losing the link again must still not log out.
    env.mockSocket.fire('connect_error', new Error('timeout'));
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(env.window.localStorage.getItem('cursor-remote-token'), 'valid-token');
  });
});

// ─── Commands (slash) sheet: search + recents ───

describe('web: commands sheet', () => {
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    env = createTestEnv();
  });

  const OPTIONS = [
    { id: 'commit', label: 'commit', description: 'Commit the current changes', selected: false, index: 1 },
    { id: 'summarize', label: 'summarize', description: 'Summarize this conversation', selected: false, index: 2 },
    { id: 'review-bugbot', label: 'review-bugbot', description: 'Review with Bugbot', selected: false, index: 3 },
    { id: 'review-security', label: 'review-security', description: 'Security review', selected: false, index: 4 },
  ];

  /** Resolve the pending command result matching a get_slash_menu emit. */
  function resolveLastSlashMenu(payload: Record<string, unknown>, ok = true) {
    const sent = env.mockSocket.sent.filter(s => s.event === 'command:get_slash_menu').pop();
    assert.ok(sent, 'get_slash_menu should have been emitted');
    env.mockSocket.fire('command:result', {
      commandId: sent!.payload.commandId,
      ok,
      data: ok ? { open: true, options: payload.options } : undefined,
      error: ok ? undefined : 'boom',
    });
    return sent!;
  }

  it('renders the search box in the Commands sheet', () => {
    env.document.getElementById('btn-slash')!.click();
    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    assert.ok(box, 'search box present');
    assert.equal(box.value, '', 'starts empty');
  });

  it('sends the typed query to the server and renders the filtered list', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    box.value = 'review';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));

    // Debounced — wait past the debounce window.
    await new Promise(r => setTimeout(r, 300));

    const queryEvt = env.mockSocket.sent.filter(s => s.event === 'command:get_slash_menu').pop()!;
    assert.equal(queryEvt.payload.slashQuery, 'review', 'query forwarded to the server');

    resolveLastSlashMenu({ options: [OPTIONS[2], OPTIONS[3]] });
    await new Promise(r => setTimeout(r, 0));

    const list = env.document.getElementById('sheet-slash-list')!;
    const tokens = Array.from(list.querySelectorAll('.slash-token')).map(t => t.textContent);
    assert.deepEqual(tokens, ['/review-bugbot', '/review-security'], 'only filtered rows shown');
  });

  it('shows a clear empty state when nothing matches', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    box.value = 'zzzz';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    resolveLastSlashMenu({ options: [] });
    await new Promise(r => setTimeout(r, 0));

    const list = env.document.getElementById('sheet-slash-list')!;
    assert.match(list.textContent!, /No commands match/i);
  });

  it('drops a stale response that arrives after a newer query', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    // First query ("re"), then a newer one ("review") before it resolves.
    box.value = 're';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const firstEvt = env.mockSocket.sent.filter(s => s.event === 'command:get_slash_menu').pop()!;
    assert.equal(firstEvt.payload.slashQuery, 're');

    box.value = 'review';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const secondEvt = env.mockSocket.sent.filter(s => s.event === 'command:get_slash_menu').pop()!;
    assert.equal(secondEvt.payload.slashQuery, 'review');

    // The newer query resolves first, then the stale "re" response lands late.
    env.mockSocket.fire('command:result', { commandId: secondEvt.payload.commandId, ok: true, data: { open: true, options: [OPTIONS[2]] } });
    await new Promise(r => setTimeout(r, 0));
    env.mockSocket.fire('command:result', { commandId: firstEvt.payload.commandId, ok: true, data: { open: true, options: OPTIONS } });
    await new Promise(r => setTimeout(r, 0));

    const list = env.document.getElementById('sheet-slash-list')!;
    const tokens = Array.from(list.querySelectorAll('.slash-token')).map(t => t.textContent);
    assert.deepEqual(tokens, ['/review-bugbot'], 'stale "re" results must not overwrite "review"');
  });

  it('surfaces recently used commands in a Recent section', async () => {
    // Seed a per-device usage history with "review-security".
    env.window.localStorage.setItem(
      'cursor-remote-slash-usage',
      JSON.stringify([{ k: 'review-security', n: 3, t: Date.now() }]),
    );

    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const list = env.document.getElementById('sheet-slash-list')!;
    const sections = Array.from(list.querySelectorAll('.slash-section-header')).map(s => s.textContent);
    assert.deepEqual(sections, ['Recent', 'All commands'], 'recents are grouped first');
    // The most-used command leads the list.
    const firstRow = list.querySelector('.sheet-item-slash');
    assert.match(firstRow!.textContent!, /review-security/);
  });

  it('records usage when a command is picked, feeding the next Recent list', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const firstRow = env.document.getElementById('sheet-slash-list')!.querySelector('.sheet-item-slash') as HTMLButtonElement;
    firstRow.click();

    const pick = env.mockSocket.sent.filter(s => s.event === 'command:click_slash_command').pop()!;
    assert.equal(pick.payload.type, 'click_slash_command');
    // Usage is recorded once the pick succeeds.
    env.mockSocket.fire('command:result', { commandId: pick.payload.commandId, ok: true, data: { composerText: '' } });
    await new Promise(r => setTimeout(r, 0));

    const usage = JSON.parse(env.window.localStorage.getItem('cursor-remote-slash-usage') || '[]');
    assert.equal(usage[0].k, 'commit', 'picked command recorded as most recent');

    // The pick command must also carry the active filter (empty here).
    assert.equal(pick.payload.slashQuery, '');
  });

  it('passes the active search filter along with the picked command', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    box.value = 'review';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    resolveLastSlashMenu({ options: [OPTIONS[2], OPTIONS[3]] });
    await new Promise(r => setTimeout(r, 0));

    const row = env.document.getElementById('sheet-slash-list')!.querySelector('.sheet-item-slash') as HTMLButtonElement;
    row.click();

    const pick = env.mockSocket.sent.filter(s => s.event === 'command:click_slash_command').pop()!;
    assert.equal(pick.payload.slashQuery, 'review', 'filter travels with the click');
    assert.equal(pick.payload.slashId, 'review-bugbot');
  });

  it('clears the filter when the sheet is closed', async () => {
    env.document.getElementById('btn-slash')!.click();
    resolveLastSlashMenu({ options: OPTIONS });
    await new Promise(r => setTimeout(r, 0));

    const box = env.document.getElementById('slash-search') as HTMLInputElement;
    box.value = 'review';
    box.dispatchEvent(new (env.window as any).Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));

    // Close by tapping the overlay.
    env.document.getElementById('sheet-overlay')!.click();
    // Reopen: must start from a clean slate.
    env.document.getElementById('btn-slash')!.click();
    const reopened = env.document.getElementById('slash-search') as HTMLInputElement;
    assert.equal(reopened.value, '', 'search box cleared on reopen');

    const last = env.mockSocket.sent.filter(s => s.event === 'command:get_slash_menu').pop()!;
    assert.equal(last.payload.slashQuery, '', 'reopen queries the unfiltered list');
  });
});
