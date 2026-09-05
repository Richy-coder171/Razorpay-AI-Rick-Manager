/**
 * MongoRepository stripUndefined tests — pin the exact driver-behavior
 * mismatch that once broke hash-chain verification on the Mongo driver:
 * the driver serializes undefined as null; the hash function skips undefined.
 * Stored documents must therefore be pre-stripped to match the hashed form.
 */

import { MongoRepository } from './repository';

// Reach the private helper through the module. It is not exported for app
// use; tests import the file and access it via a typed cast on an instance
// prototype-free path. Simplest honest approach: test via the exported class
// using dependency-free pure calls to the internal function through the
// module's internals is not possible in TS; instead we validate the BEHAVIOR
// the function guarantees by re-implementing the check against what insert
// passes to the driver. Since insert requires a live Mongo connection, we
// test the pure transform by importing it indirectly:

describe('MongoRepository document normalization (stripUndefined behavior)', () => {
  // Access the module-private stripUndefined through the transpiled module
  // object (ts-jest compiles it; not part of the public API).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./repository') as { __testStripUndefined?: <T>(v: T) => T };
  const strip = mod.__testStripUndefined as (<T>(v: T) => T) | undefined;

  it('the normalization hook is exposed for tests', () => {
    // If this fails, export __testStripUndefined from repository.ts.
    expect(typeof strip).toBe('function');
  });

  it('strips undefined keys like the hash function does (stored == hashed)', () => {
    const input = {
      a: 1,
      b: undefined,
      c: { d: undefined, e: 'x', f: [1, undefined, 2] },
      g: null,
    };
    const stripped = strip!(input) as typeof input;
    expect('b' in stripped).toBe(false);
    expect('d' in (stripped.c as Record<string, unknown>)).toBe(false);
    expect((stripped.c as { f: unknown[] }).f).toEqual([1, null, 2]);
    // null is preserved (it round-trips identically in JSON and BSON).
    expect(stripped.g).toBeNull();
    // The stripped form must be byte-identical to its own JSON round-trip —
    // the exact property the audit hash requires.
    const { stableStringify } = require('../utils/crypto');
    expect(stableStringify(stripped)).toBe(stableStringify(JSON.parse(JSON.stringify(stripped))));
  });

  it('leaves plain documents untouched', () => {
    const doc = { id: 'x', seq: 3, nested: { ok: true } };
    expect(strip!(doc)).toEqual(doc);
  });
});
