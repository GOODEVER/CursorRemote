import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STALL_MS,
  claimsWork,
  detectStall,
  extractionContentKey,
  isWorkingStatus,
} from '../src/server/stall-detector.js';
import type { CursorState } from '../src/server/types.js';

function state(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'running_tool',
    agentActivityText: 'Editing app.ts',
    agentActivityLive: true,
    agentActivitySource: 'shimmer',
    canAbort: true,
    agentStalled: false,
    agentStalledSince: null,
    messages: [{ type: 'tool', id: 't1', flatIndex: 0, toolCallId: 'tc1', status: 'loading', action: 'Edit', details: '', actions: [] }],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    activeComposerId: 'c1',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: 'w1',
    composerQueue: { items: [] },
    questionnaire: null,
    slashCommands: [],
    folders: [],
    ...overrides,
  };
}

describe('stall-detector: claimsWork / isWorkingStatus', () => {
  it('treats thinking/running/generating as working statuses', () => {
    assert.equal(isWorkingStatus('thinking'), true);
    assert.equal(isWorkingStatus('running_tool'), true);
    assert.equal(isWorkingStatus('generating'), true);
  });

  it('treats idle/blocked/error as non-working statuses', () => {
    assert.equal(isWorkingStatus('idle'), false);
    assert.equal(isWorkingStatus('waiting_approval'), false);
    assert.equal(isWorkingStatus('error'), false);
  });

  it('claims work when canAbort is set even if status reads idle (flap)', () => {
    assert.equal(claimsWork(state({ agentStatus: 'idle', agentActivityLive: false, canAbort: true })), true);
  });
});

describe('stall-detector: extractionContentKey', () => {
  it('ignores volatile bookkeeping that changes every poll', () => {
    const a = state({ lastExtractionAt: 1, consecutiveExtractionFailures: 0, extractorStatus: 'ok' });
    const b = state({ lastExtractionAt: 999, consecutiveExtractionFailures: 4, extractorStatus: 'stale' });
    assert.equal(extractionContentKey(a), extractionContentKey(b));
  });

  it('changes when the agent actually moves on', () => {
    const a = state();
    const b = state({ agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    assert.notEqual(extractionContentKey(a), extractionContentKey(b));
  });
});

describe('stall-detector: detectStall', () => {
  it('is not stalled while the content keeps moving', () => {
    let tracker = detectStall(null, state(), 1000);
    assert.equal(tracker.stalled, false);
    // New activity arrives within the window → re-armed.
    tracker = detectStall(tracker, state({ agentActivityText: 'Read file' }), 1000 + AGENT_STALL_MS - 100);
    assert.equal(tracker.stalled, false);
  });

  it('flags a stall when working content freezes past the threshold', () => {
    let tracker = detectStall(null, state(), 1000);
    tracker = detectStall(tracker, state(), 1000 + AGENT_STALL_MS);
    assert.equal(tracker.stalled, true);
  });

  it('never flags an idle agent even if nothing changes', () => {
    const idle = state({ agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    let tracker = detectStall(null, idle, 1000);
    tracker = detectStall(tracker, idle, 1000 + AGENT_STALL_MS * 5);
    assert.equal(tracker.stalled, false);
  });

  it('never flags while waiting for approval (blocked, not frozen)', () => {
    const blocked = state({
      agentStatus: 'waiting_approval',
      agentActivityLive: false,
      canAbort: false,
      agentActivityText: null,
    });
    let tracker = detectStall(null, blocked, 1000);
    tracker = detectStall(tracker, blocked, 1000 + AGENT_STALL_MS * 5);
    assert.equal(tracker.stalled, false);
  });

  it('clears the stall once content moves again', () => {
    let tracker = detectStall(null, state(), 0);
    tracker = detectStall(tracker, state(), AGENT_STALL_MS);
    assert.equal(tracker.stalled, true);
    // Agent finally progressed (e.g. after the forced refresh).
    tracker = detectStall(tracker, state({ agentActivityText: 'Running tests' }), AGENT_STALL_MS + 10);
    assert.equal(tracker.stalled, false);
  });

  it('stays stalled across the activity-text staleness clear (uses the raw signal)', () => {
    // The state-manager measures against the RAW extraction, so the 30s
    // activity-text clear does not reset the stall clock the way feeding the
    // post-staleness state would. Here the text keeps arriving and is dropped
    // by staleness — the stall must persist and, once the agent finally
    // finishes, clear on the genuine content change.
    let tracker = detectStall(null, state(), 0);
    tracker = detectStall(tracker, state(), AGENT_STALL_MS);
    assert.equal(tracker.stalled, true);
    tracker = detectStall(tracker, state(), AGENT_STALL_MS * 3);
    assert.equal(tracker.stalled, true, 'frozen working agent stays flagged');
    const finished = state({ agentStatus: 'idle', canAbort: false, agentActivityLive: false, agentActivityText: null });
    tracker = detectStall(tracker, finished, AGENT_STALL_MS * 3 + 10);
    assert.equal(tracker.stalled, false, 'cleared once the agent actually finishes');
  });
});
