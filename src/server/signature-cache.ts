/**
 * Memoized structural signatures for cheap equality checks.
 *
 * The state diff used to decide what changed with
 * `JSON.stringify(prev.x) !== JSON.stringify(next.x)` for eight fields on every
 * poll — serializing the whole transcript (HTML included) *twice* per tick. This
 * caches the serialized form per object *reference*, so:
 *
 *  - identical references short-circuit without any work, and
 *  - a value that was serialized once is never serialized again while it lives.
 *
 * The extractor rebuilds each value every poll, so a fresh value is still
 * serialized once — but the *previous* copy is reused from the cache instead of
 * being re-serialized, halving the per-poll serialization cost. The transcript
 * (messages) is the dominant payload, so the saving tracks chat size.
 *
 * Requires callers to treat cached values as immutable: mutating an array or
 * object in place would leave a stale signature behind. Nothing in the server
 * mutates extracted state in place (the extractor always builds fresh values),
 * so this holds today.
 */
export class SignatureCache {
  /** Reference -> serialized form. Weak so discarded values can be GC'd. */
  private cache = new WeakMap<object, string>();

  /**
   * Canonical string for `value`. Objects/arrays are serialized at most once
   * per reference; primitives and null are handled directly.
   */
  signature(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'object') {
      const obj = value as object;
      const cached = this.cache.get(obj);
      if (cached !== undefined) return cached;
      // Plain JSON.stringify: both sides come from the same extractor code path,
      // so key order is deterministic and a full sort would only add cost.
      const computed = JSON.stringify(value) ?? 'undefined';
      this.cache.set(obj, computed);
      return computed;
    }
    return `${typeof value}:${JSON.stringify(value) ?? 'undefined'}`;
  }

  /** True when `next` differs structurally from `prev`. */
  differs(prev: unknown, next: unknown): boolean {
    if (prev === next) return false;
    return this.signature(prev) !== this.signature(next);
  }
}
