export function sha256Hex(input: string | Buffer): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, input: string | Buffer): string {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

export function timingSafeEqualHex(expectedHex: string, receivedHex: string): boolean {
  const crypto = require('crypto');
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(receivedHex, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Stable stringify: object keys sorted recursively so hash chains are
 * deterministic across runs (key insertion order must not matter).
 * Round-trip canonical: undefined-valued keys are omitted, matching
 * JSON.stringify/parse semantics, so hashing an in-memory record and its
 * file round-trip produces the SAME string. (Emitting "key":undefined made
 * chain verification fail on any record with optional fields — the hash was
 * computed over a string JSON could never reproduce.)
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // JSON stringifies undefined array elements as null — match that exactly
    // so the output is always valid, round-trip-identical JSON.
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${parts.join(',')}}`;
}

/** Promise that never settles — for fault-injection paths (no leaked timers). */
export function never(): Promise<never> {
  return new Promise<never>(() => {});
}

/** Round to n decimals without float artifacts. */
export function round(value: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function nowIso(): string {
  return new Date().toISOString();
}
