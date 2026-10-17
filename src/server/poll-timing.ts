/**
 * Lightweight rolling timers for the extract → diff → emit hot path.
 *
 * Logs a one-line summary every `logEveryMs` so we can see whether Cursor's
 * CDP extract or the relay's JSON work dominates — without paying for a
 * profiler on every poll.
 */

export interface PollTimingSample {
  extractMs?: number;
  diffMs?: number;
  emitMs?: number;
  /** Bytes of the outbound patch JSON (pre-deflate), when known. */
  patchBytes?: number;
  /** True when the patch used messageDelta instead of full messages. */
  usedMessageDelta?: boolean;
  /** True when the cheap fingerprint skipped a full DOM extract. */
  skippedFull?: boolean;
}

interface Bucket {
  n: number;
  extractMs: number;
  diffMs: number;
  emitMs: number;
  patchBytes: number;
  deltaPatches: number;
  fullMessagePatches: number;
  skippedFull: number;
}

function emptyBucket(): Bucket {
  return {
    n: 0,
    extractMs: 0,
    diffMs: 0,
    emitMs: 0,
    patchBytes: 0,
    deltaPatches: 0,
    fullMessagePatches: 0,
    skippedFull: 0,
  };
}

export interface PollTiming {
  record(sample: PollTimingSample): void;
}

export function createPollTiming(logEveryMs = 15_000): PollTiming {
  let bucket = emptyBucket();
  let windowStarted = Date.now();

  return {
    record(sample: PollTimingSample): void {
      bucket.n += 1;
      if (typeof sample.extractMs === 'number') bucket.extractMs += sample.extractMs;
      if (typeof sample.diffMs === 'number') bucket.diffMs += sample.diffMs;
      if (typeof sample.emitMs === 'number') bucket.emitMs += sample.emitMs;
      if (typeof sample.patchBytes === 'number') bucket.patchBytes += sample.patchBytes;
      if (sample.usedMessageDelta === true) bucket.deltaPatches += 1;
      if (sample.usedMessageDelta === false) bucket.fullMessagePatches += 1;
      if (sample.skippedFull) bucket.skippedFull += 1;

      const now = Date.now();
      if (now - windowStarted < logEveryMs || bucket.n === 0) return;

      const n = bucket.n;
      const avg = (sum: number) => (sum / n).toFixed(1);
      const parts = [
        `polls=${n}`,
        `extract=${avg(bucket.extractMs)}ms`,
        `diff=${avg(bucket.diffMs)}ms`,
        `emit=${avg(bucket.emitMs)}ms`,
      ];
      if (bucket.patchBytes > 0) {
        parts.push(`patch≈${Math.round(bucket.patchBytes / n)}B`);
      }
      if (bucket.deltaPatches + bucket.fullMessagePatches > 0) {
        parts.push(`msgDelta=${bucket.deltaPatches}/${bucket.deltaPatches + bucket.fullMessagePatches}`);
      }
      if (bucket.skippedFull > 0) {
        parts.push(`skipFull=${bucket.skippedFull}/${n}`);
      }
      console.log(`[perf] ${parts.join(' ')}`);

      bucket = emptyBucket();
      windowStarted = now;
    },
  };
}
