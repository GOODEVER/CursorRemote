import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPollTiming } from '../src/server/poll-timing.js';

describe('createPollTiming', () => {
  it('aggregates samples without throwing', () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      const timing = createPollTiming(1); // flush on next record after 1ms
      timing.record({ extractMs: 10, diffMs: 2 });
      // Wait past the window, then record again to trigger the log.
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      timing.record({
        extractMs: 20,
        emitMs: 3,
        patchBytes: 1000,
        usedMessageDelta: true,
      });
      assert.ok(
        logs.some((l) => l.includes('[perf]') && l.includes('extract=')),
        `expected a perf log, got: ${JSON.stringify(logs)}`
      );
    } finally {
      console.log = orig;
    }
  });
});
