// Per-user API key resolution — extracted from index.ts so it's unit-testable
// without starting the HTTP server.
//
// Option A — single key (legacy, backward-compatible):
//   KODA_API_KEY=xxx  → user_id = KODA_DEFAULT_USER (default: "hafiz")
//
// Option B — per-user keys:
//   KODA_USERS=hafiz:key_abc,ali:key_def,sara:key_ghi
//   Memories are isolated per user_id; "shared" / "sifututor" are readable by all.
//
// Dashboard login (email + password → token) uses the dashboard_users SQL
// table, managed via the Users page in the dashboard itself (see
// /auth/login and /admin/dashboard-users in index.ts). Accounts are created
// there, not via an env var.
//
// Admin allowlist for personal-key (KODA_USERS / KODA_API_KEY) users:
//   KODA_ADMIN_USERS=hafiz,ali
//   A personal-key user is only treated as dashboard-admin if listed here.
//   Unlisted personal-key users are regular (non-admin) users. This is
//   independent of dashboard_users.role, which still grants admin to anyone
//   created there with role='admin' regardless of this allowlist.

import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto';

/**
 * Build the token → userId map from environment.
 * Accepts an explicit env object for testing (defaults to process.env).
 */
export function buildUserMap(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();

  const legacyKey = env.KODA_API_KEY;
  if (legacyKey) {
    const defaultUser = env.KODA_DEFAULT_USER || 'hafiz';
    map.set(legacyKey, defaultUser);
  }

  const usersEnv = env.KODA_USERS;
  if (usersEnv) {
    for (const pair of usersEnv.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const userId = pair.slice(0, colonIdx).trim();
      const key = pair.slice(colonIdx + 1).trim();
      if (userId && key) map.set(key, userId);
    }
  }

  return map;
}

/**
 * Resolve a userId from a bearer token given the user map.
 * - Empty map → dev mode, returns 'hafiz' (no auth configured).
 * - Missing or unknown token → null (caller should return 401).
 */
export function resolveUserFromToken(userMap: Map<string, string>, token: string | null): string | null {
  if (userMap.size === 0) return 'hafiz'; // dev mode — no auth
  if (!token) return null;
  return userMap.get(token) ?? null;
}

/**
 * Build the set of userIds treated as dashboard-admin when authenticating via
 * a personal key (KODA_USERS / KODA_API_KEY), from KODA_ADMIN_USERS.
 * Format: KODA_ADMIN_USERS=hafiz,ali
 * Unset or empty → no personal-key user is admin (fail-closed default).
 */
export function buildAdminSet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.KODA_ADMIN_USERS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((u) => u.trim()).filter(Boolean));
}

/**
 * Verify a plaintext password against a stored salt:hash pair.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyPassword(stored: { salt: string; hash: string }, password: string): boolean {
  const derived = pbkdf2Sync(password, stored.salt, 100000, 32, 'sha256').toString('hex');
  const a = Buffer.from(derived);
  const b = Buffer.from(stored.hash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Generate a new unique API key for a dashboard user.
 */
export function generateApiKey(): string {
  return 'koda_' + randomBytes(24).toString('hex');
}

/**
 * Hash a plaintext password for storage. Returns "SALT:HASH".
 * Use this when setting up a new user password.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Extract a bearer token from an Authorization header, falling back to an
 * `?apiKey=` query parameter on the request URL.
 */
export function extractToken(authHeader: string | undefined, url?: string, host?: string): string | null {
  if (authHeader) {
    const spaceIdx = authHeader.indexOf(' ');
    if (spaceIdx !== -1 && authHeader.slice(0, spaceIdx) === 'Bearer') {
      return authHeader.slice(spaceIdx + 1);
    }
  }

  if (url) {
    try {
      const u = new URL(url, `http://${host || 'localhost'}`);
      const k = u.searchParams.get('apiKey');
      if (k) return k;
    } catch {
      // malformed URL — no token
    }
  }

  return null;
}
