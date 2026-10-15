import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignatureCache } from '../src/server/signature-cache.js';

describe('SignatureCache: signature', () => {
  it('returns a stable signature for the same reference', () => {
    const cache = new SignatureCache();
    const value = [{ id: 'm1', text: 'hello' }];
    assert.equal(cache.signature(value), cache.signature(value));
  });

  it('treats structurally identical values as equal across references', () => {
    const cache = new SignatureCache();
    assert.equal(
      cache.signature({ a: 1, b: [2, 3] }),
      cache.signature({ a: 1, b: [2, 3] })
    );
  });

  it('distinguishes structurally different values', () => {
    const cache = new SignatureCache();
    assert.notEqual(cache.signature({ a: 1 }), cache.signature({ a: 2 }));
  });

  it('handles null and primitives without caching errors', () => {
    const cache = new SignatureCache();
    assert.equal(cache.signature(null), 'null');
    assert.equal(cache.signature(1), cache.signature(1));
    assert.notEqual(cache.signature(1), cache.signature('1'));
    assert.notEqual(cache.signature(null), cache.signature(0));
  });

  it('does not re-serialize a repeated reference (the whole point)', () => {
    const cache = new SignatureCache();
    let stringifyCalls = 0;
    const original = JSON.stringify;
    JSON.stringify = ((...args: Parameters<typeof original>) => {
      stringifyCalls++;
      return original(...args);
    }) as typeof JSON.stringify;
    try {
      const value = { big: 'x'.repeat(1000) };
      cache.signature(value);
      const afterFirst = stringifyCalls;
      cache.signature(value);
      cache.signature(value);
      assert.equal(stringifyCalls, afterFirst, 'repeat calls must be served from cache');
    } finally {
      JSON.stringify = original;
    }
  });
});

describe('SignatureCache: differs', () => {
  it('short-circuits on identical references', () => {
    const cache = new SignatureCache();
    const value = [1, 2, 3];
    assert.equal(cache.differs(value, value), false);
  });

  it('reports no difference for structurally equal values', () => {
    const cache = new SignatureCache();
    assert.equal(cache.differs([{ id: 'a' }], [{ id: 'a' }]), false);
  });

  it('reports a difference when the tail content changes', () => {    const cache = new SignatureCache();
    const before = [{ id: 'm1', text: 'hel' }];
    const after = [{ id: 'm1', text: 'hello' }];
    assert.equal(cache.differs(before, after), true);
  });

  it('handles null vs empty-array transitions', () => {
    const cache = new SignatureCache();
    assert.equal(cache.differs(null, []), true);
    assert.equal(cache.differs(null, null), false);
  });

  it('still detects a change to a previously seen previous value', () => {
    const cache = new SignatureCache();
    const prev = [{ id: 'm1' }];
    const next = [{ id: 'm1' }, { id: 'm2' }];
    assert.equal(cache.differs(prev, next), true);
    // A later poll reusing `prev` must compare against the cached signature.
    assert.equal(cache.differs(prev, next), true);
  });
});
