import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINISH_SETTLE_STRONG_MS,
  FINISH_SETTLE_WEAK_MS,
  finishSettleMs,
  isStronglyIdle,
} from '../src/server/finish-notify.js';

describe('finish-notify settle policy', () => {
  it('treats clean idle as strong and uses the short settle', () => {
    const s = {
      working: false,
      canAbort: false,
      agentActivityLive: false,
      agentStatus: 'idle',
      hasQuestionnaire: false,
      hasApproval: false,
    };
    assert.equal(isStronglyIdle(s), true);
    assert.equal(finishSettleMs(s), FINISH_SETTLE_STRONG_MS);
    assert.ok(FINISH_SETTLE_STRONG_MS < FINISH_SETTLE_WEAK_MS);
  });

  it('keeps the long settle when status is ambiguous or user-blocked', () => {
    assert.equal(
      finishSettleMs({
        working: false,
        canAbort: false,
        agentActivityLive: false,
        agentStatus: 'thinking',
        hasQuestionnaire: false,
        hasApproval: false,
      }),
      FINISH_SETTLE_WEAK_MS
    );
    assert.equal(
      finishSettleMs({
        working: false,
        canAbort: false,
        agentActivityLive: false,
        agentStatus: 'idle',
        hasQuestionnaire: true,
        hasApproval: false,
      }),
      FINISH_SETTLE_WEAK_MS
    );
    assert.equal(
      finishSettleMs({
        working: false,
        canAbort: true,
        agentActivityLive: false,
        agentStatus: 'idle',
        hasQuestionnaire: false,
        hasApproval: false,
      }),
      FINISH_SETTLE_WEAK_MS
    );
  });
});
