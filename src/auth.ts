// Per-user API key resolution — extracted from index.ts so it's unit-testable
// without starting the HTTP server.
//
// Option A — single key (legacy, backward-compatible):
//   KODA_API_KEY=xxx  → user_id = KODA_DEFAULT_USER (default: "hafiz")
//
// Option B — per-user keys:
//   KODA_USERS=hafiz:key_abc,ali:key_def,sara:key_ghi
//   Memories are isolated per user_id; "shared" / "sifututor" are readable by all.

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
