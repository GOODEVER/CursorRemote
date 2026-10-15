import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUIET_TICKS_BEFORE_IDLE,
  createPollPacing,
  nextPollInterval,
  pollContentKey,
  type PollPacingState,
} from '../src/server/idle-poll.js';

/** Minimal shape accepted by pollContentKey (matches the fields it reads). */
function state(overrides: Partial<Parameters<typeof pollContentKey>[0]> = {}) {
  return {
    agentStatus: 'idle',
    agentActivityText: null,
    canAbort: false,
    messages: [],
    pendingApprovals: [],
    questionnaire: null,
    composerQueue: { items: [] },
    chatTabs: [],
    folders: [],
    slashCommands: [],
    mode: { current: 'agent' },
    model: { current: 'Auto' },
    activeComposerId: 'c1',
    activeWindowId: 'w1',
    ...overrides,
  };
}

/** Run N quiet (unchanged, non-working) polls and return the final interval. */
function runQuiet(pacing: PollPacingState, times: number, base = 500, idle = 2000): number {
  let interval = base;
  for (let i = 0; i < times; i++) {
    interval = nextPollInterval(pacing, { unchanged: true, working: false }, base, idle);
  }
  return interval;
}

describe('idle-poll: nextPollInterval', () => {
  it('stays at the base interval before enough quiet ticks have accrued', () => {
    const pacing = createPollPacing();
    // One short of the threshold — still full speed.
    const interval = runQuiet(pacing, QUIET_TICKS_BEFORE_IDLE - 1);
    assert.equal(interval, 500);
    assert.equal(pacing.idle, false);
  });

  it('drops to the idle interval after several quiet ticks', () => {
    const pacing = createPollPacing();
    const interval = runQuiet(pacing, QUIET_TICKS_BEFORE_IDLE);
    assert.equal(interval, 2000);
    assert.equal(pacing.idle, true);
  });

  it('never slows down while the agent claims work', () => {
    const pacing = createPollPacing();
    const interval = runQuiet(pacing, 20);
    assert.equal(interval, 2000, 'precondition: should be idle');

    // A working poll must snap straight back to full speed.
    const workingInterval = nextPollInterval(
      pacing,
      { unchanged: true, working: true },
      500,
      2000
    );
    assert.equal(workingInterval, 500);
    assert.equal(pacing.idle, false);
    assert.equal(pacing.quietTicks, 0);
  });

  it('snaps back to full speed the moment content changes', () => {
    const pacing = createPollPacing();
    runQuiet(pacing, QUIET_TICKS_BEFORE_IDLE + 5);
    assert.equal(pacing.idle, true);

    const changed = nextPollInterval(pacing, { unchanged: false, working: false }, 500, 2000);
    assert.equal(changed, 500);
    assert.equal(pacing.idle, false);
    assert.equal(pacing.quietTicks, 0);
  });

  it('disables backoff when the idle interval is not greater than the base', () => {
    const pacing = createPollPacing();
    const interval = runQuiet(pacing, 50, 500, 500);
    assert.equal(interval, 500);
    assert.equal(pacing.idle, false);
  });

  it('requires the quiet count to accumulate from zero after an interruption', () => {
    const pacing = createPollPacing();
    runQuiet(pacing, QUIET_TICKS_BEFORE_IDLE - 1);
    // Interrupt, then re-accumulate: the partial count must not carry over.
    nextPollInterval(pacing, { unchanged: false, working: false }, 500, 2000);
    const interval = runQuiet(pacing, QUIET_TICKS_BEFORE_IDLE - 1);
    assert.equal(interval, 500, 'should still be at base one tick short of the threshold');
  });
});

describe('idle-poll: pollContentKey', () => {
  it('is stable for identical content', () => {
    assert.equal(pollContentKey(state()), pollContentKey(state()));
  });

  it('changes when the transcript grows', () => {
    const before = pollContentKey(state({ messages: [{ id: 'm1', type: 'human' }] }));
    const after = pollContentKey(
      state({
        messages: [
          { id: 'm1', type: 'human' },
          { id: 'm2', type: 'assistant' },
        ],
      })
    );
    assert.notEqual(before, after);
  });

  it('changes when the tail message ID advances even at constant length', () => {
    const before = pollContentKey(state({ messages: [{ id: 'm1', type: 'assistant' }] }));
    const after = pollContentKey(state({ messages: [{ id: 'm2', type: 'assistant' }] }));
    assert.notEqual(before, after);
  });

  it('changes when the agent starts claiming work', () => {
    const before = pollContentKey(state({ agentStatus: 'idle', canAbort: false }));
    const after = pollContentKey(state({ agentStatus: 'running_tool', canAbort: true }));
    assert.notEqual(before, after);
  });

  it('changes when a questionnaire appears or advances', () => {
    const none = pollContentKey(state({ questionnaire: null }));
    const q1 = pollContentKey(
      state({ questionnaire: { totalLabel: '1 of 2', activeIndex: 0 } })
    );
    const q2 = pollContentKey(
      state({ questionnaire: { totalLabel: '2 of 2', activeIndex: 1 } })
    );
    assert.notEqual(none, q1);
    assert.notEqual(q1, q2);
  });

  it('ignores volatile bookkeeping that is not part of the key', () => {
    // The key signature takes no lastExtractionAt/failure fields at all — this
    // guards against them being reintroduced, which would defeat the backoff.
    const key = pollContentKey(state());
    assert.equal(typeof key, 'string');
    assert.ok(!key.includes('NaN'));
  });
});
