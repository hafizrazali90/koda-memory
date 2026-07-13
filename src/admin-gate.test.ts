/**
 * Admin gate regression test.
 *
 * Until 2026-07-13, every personal-key (KODA_USERS / KODA_API_KEY) user was
 * silently treated as dashboard-admin — including access to
 * /admin/dashboard-users (create/delete accounts, cross-user visibility).
 * There was no KODA_ADMIN_USERS concept, so the only way to be "not admin"
 * was to log in via the dashboard_users email+password path. Fixed by making
 * personal-key admin status an explicit opt-in allowlist (KODA_ADMIN_USERS),
 * fail-closed when unset. This test locks that in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { openDatabase } from './db/connection.js';
import { createHttpServer } from './index.js';
import type Database from 'better-sqlite3';

const ADMIN_KEY = 'admin-gate-test-admin-key';
const ADMIN_USER = 'admin-user';
const PLAIN_KEY = 'admin-gate-test-plain-key';
const PLAIN_USER = 'plain-user';

let db: Database.Database;
let baseUrl: string;
let server: ReturnType<typeof createHttpServer>;

function getDashboardUsers(key: string) {
  return fetch(`${baseUrl}/admin/dashboard-users`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

beforeAll(async () => {
  const tmpDir = path.join(os.tmpdir(), `koda-admin-gate-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });

  server = createHttpServer({
    userMap: new Map([
      [ADMIN_KEY, ADMIN_USER],
      [PLAIN_KEY, PLAIN_USER],
    ]),
    adminSet: new Set([ADMIN_USER]),
    dbGetter: () => db,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('Personal-key admin gate', () => {
  it('rejects a personal-key user NOT in KODA_ADMIN_USERS from /admin/dashboard-users', async () => {
    const res = await getDashboardUsers(PLAIN_KEY);
    expect(res.status).toBe(403);
  });

  it('allows a personal-key user listed in KODA_ADMIN_USERS', async () => {
    const res = await getDashboardUsers(ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = await res.json() as { users: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
  });

  it('defaults to no admins when KODA_ADMIN_USERS / adminSet is empty (fail-closed)', async () => {
    const noAdminServer = createHttpServer({
      userMap: new Map([[PLAIN_KEY, PLAIN_USER]]),
      adminSet: new Set(),
      dbGetter: () => db,
    });
    await new Promise<void>((resolve) => noAdminServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = noAdminServer.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/admin/dashboard-users`, {
      headers: { Authorization: `Bearer ${PLAIN_KEY}` },
    });
    expect(res.status).toBe(403);
    await new Promise<void>((resolve) => noAdminServer.close(() => resolve()));
  });
});
