import { describe, it, expect } from 'vitest';
import { buildUserMap, resolveUserFromToken, extractToken } from './auth.js';

describe('buildUserMap', () => {
  it('maps a legacy single key to the default user', () => {
    const map = buildUserMap({ KODA_API_KEY: 'legacy_key' } as NodeJS.ProcessEnv);
    expect(map.get('legacy_key')).toBe('hafiz');
  });

  it('honors KODA_DEFAULT_USER for the legacy key', () => {
    const map = buildUserMap({ KODA_API_KEY: 'k', KODA_DEFAULT_USER: 'sara' } as NodeJS.ProcessEnv);
    expect(map.get('k')).toBe('sara');
  });

  it('parses per-user KODA_USERS pairs', () => {
    const map = buildUserMap({ KODA_USERS: 'hafiz:key_abc,ali:key_def,sara:key_ghi' } as NodeJS.ProcessEnv);
    expect(map.get('key_abc')).toBe('hafiz');
    expect(map.get('key_def')).toBe('ali');
    expect(map.get('key_ghi')).toBe('sara');
    expect(map.size).toBe(3);
  });

  it('tolerates whitespace and skips malformed pairs', () => {
    const map = buildUserMap({ KODA_USERS: ' hafiz : key1 , garbage , ali:key2 ' } as NodeJS.ProcessEnv);
    expect(map.get('key1')).toBe('hafiz');
    expect(map.get('key2')).toBe('ali');
    expect(map.size).toBe(2); // 'garbage' (no colon) skipped
  });

  it('handles keys containing colons (only splits on the first)', () => {
    const map = buildUserMap({ KODA_USERS: 'hafiz:key:with:colons' } as NodeJS.ProcessEnv);
    expect(map.get('key:with:colons')).toBe('hafiz');
  });

  it('returns an empty map when nothing is configured', () => {
    expect(buildUserMap({} as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe('resolveUserFromToken', () => {
  const map = buildUserMap({ KODA_USERS: 'hafiz:good_key,ali:ali_key' } as NodeJS.ProcessEnv);

  it('resolves a valid token to its user', () => {
    expect(resolveUserFromToken(map, 'good_key')).toBe('hafiz');
    expect(resolveUserFromToken(map, 'ali_key')).toBe('ali');
  });

  it('rejects an unknown token', () => {
    expect(resolveUserFromToken(map, 'wrong_key')).toBeNull();
  });

  it('rejects a missing token', () => {
    expect(resolveUserFromToken(map, null)).toBeNull();
    expect(resolveUserFromToken(map, '')).toBeNull();
  });

  it('does not leak another user via a near-miss token', () => {
    expect(resolveUserFromToken(map, 'good_key ')).toBeNull(); // trailing space
    expect(resolveUserFromToken(map, 'GOOD_KEY')).toBeNull(); // case-sensitive
  });

  it('falls back to dev mode (hafiz) only when no keys are configured', () => {
    const empty = buildUserMap({} as NodeJS.ProcessEnv);
    expect(resolveUserFromToken(empty, null)).toBe('hafiz');
    expect(resolveUserFromToken(empty, 'anything')).toBe('hafiz');
  });
});

describe('extractToken', () => {
  it('extracts a Bearer token from the Authorization header', () => {
    expect(extractToken('Bearer abc123')).toBe('abc123');
  });

  it('ignores non-Bearer auth schemes', () => {
    expect(extractToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('falls back to ?apiKey= query param', () => {
    expect(extractToken(undefined, '/mcp?apiKey=qkey', 'localhost')).toBe('qkey');
  });

  it('prefers the Authorization header over the query param', () => {
    expect(extractToken('Bearer header_key', '/mcp?apiKey=query_key', 'localhost')).toBe('header_key');
  });

  it('returns null when neither is present', () => {
    expect(extractToken(undefined, '/mcp', 'localhost')).toBeNull();
    expect(extractToken(undefined)).toBeNull();
  });

  it('does not throw on a malformed URL', () => {
    expect(() => extractToken(undefined, '://bad', 'localhost')).not.toThrow();
  });
});
