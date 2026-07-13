/**
 * Dashboard login (/auth/login) and dashboard user management
 * (/admin/dashboard-users) contract tests.
 *
 * Covers what shipped with zero test coverage before 2026-07-13: the login
 * flow itself, full CRUD on dashboard_users, and two safety guards added
 * during this review — deleting the last admin, and deleting your own
 * account while authenticated as it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db/connection.js';
import { createHttpServer } from './index.js';
import { hashPassword, generateApiKey } from './auth.js';
import type Database from 'better-sqlite3';

const ADMIN_KEY = 'dash-test-admin-key';
const ADMIN_USER = 'dash-admin';

let db: Database.Database;
let baseUrl: string;
let server: ReturnType<typeof createHttpServer>;

function seedDashboardUser(email: string, password: string, role: 'admin' | 'user'): { id: string; apiKey: string } {
  const id = randomUUID();
  const apiKey = generateApiKey();
  const [salt, hash] = hashPassword(password).split(':');
  db.prepare(
    'INSERT INTO dashboard_users (id, email, password_hash, salt, api_key, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, email, hash, salt, apiKey, role, new Date().toISOString());
  return { id, apiKey };
}

function login(email: string, password: string) {
  return fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function adminReq(path: string, opts: { method?: string; body?: unknown; key?: string } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${opts.key ?? ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeAll(async () => {
  const tmpDir = path.join(os.tmpdir(), `koda-dashboard-users-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  db = openDatabase({ dbPath: path.join(tmpDir, 'brain.db') });

  server = createHttpServer({
    userMap: new Map([[ADMIN_KEY, ADMIN_USER]]),
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

beforeEach(() => {
  db.prepare('DELETE FROM dashboard_users').run();
});

describe('POST /auth/login', () => {
  it('returns the account api_key on correct credentials', async () => {
    const { apiKey } = seedDashboardUser('alice@example.com', 'correct-horse', 'user');
    const res = await login('alice@example.com', 'correct-horse');
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(body.token).toBe(apiKey);
  });

  it('rejects a wrong password with a generic error', async () => {
    seedDashboardUser('alice@example.com', 'correct-horse', 'user');
    const res = await login('alice@example.com', 'wrong-password');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid email or password');
  });

  it('rejects an unknown email with the same generic error (no user enumeration)', async () => {
    const res = await login('nobody@example.com', 'whatever');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid email or password');
  });

  it('rejects a missing password', async () => {
    const res = await login('alice@example.com', '');
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/dashboard-users', () => {
  it('lists users for an admin', async () => {
    seedDashboardUser('alice@example.com', 'pw', 'user');
    const res = await adminReq('/admin/dashboard-users');
    expect(res.status).toBe(200);
    const body = await res.json() as { users: { email: string }[] };
    expect(body.users.map((u) => u.email)).toContain('alice@example.com');
  });

  it('never returns password_hash or salt', async () => {
    seedDashboardUser('alice@example.com', 'pw', 'user');
    const res = await adminReq('/admin/dashboard-users');
    const body = await res.json() as { users: Record<string, unknown>[] };
    for (const u of body.users) {
      expect(u.password_hash).toBeUndefined();
      expect(u.salt).toBeUndefined();
      expect(u.api_key).toBeUndefined();
    }
  });
});

describe('POST /admin/dashboard-users', () => {
  it('creates a user and the new account can log in', async () => {
    const res = await adminReq('/admin/dashboard-users', {
      method: 'POST',
      body: { email: 'bob@example.com', password: 'bob-pw-123', role: 'user' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; email: string; role: string };
    expect(body.email).toBe('bob@example.com');
    expect(body.role).toBe('user');

    const loginRes = await login('bob@example.com', 'bob-pw-123');
    expect(loginRes.status).toBe(200);
  });

  it('rejects a duplicate email', async () => {
    seedDashboardUser('bob@example.com', 'pw', 'user');
    const res = await adminReq('/admin/dashboard-users', {
      method: 'POST',
      body: { email: 'bob@example.com', password: 'other-pw', role: 'user' },
    });
    expect(res.status).toBe(409);
  });

  it('rejects a missing password', async () => {
    const res = await adminReq('/admin/dashboard-users', {
      method: 'POST',
      body: { email: 'bob@example.com' },
    });
    expect(res.status).toBe(400);
  });

  it('defaults role to "user" when omitted', async () => {
    const res = await adminReq('/admin/dashboard-users', {
      method: 'POST',
      body: { email: 'bob@example.com', password: 'pw' },
    });
    const body = await res.json() as { role: string };
    expect(body.role).toBe('user');
  });
});

describe('DELETE /admin/dashboard-users/:id', () => {
  it('deletes a user', async () => {
    const { id } = seedDashboardUser('bob@example.com', 'pw', 'user');
    const res = await adminReq(`/admin/dashboard-users/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT id FROM dashboard_users WHERE id = ?').get(id)).toBeUndefined();
  });

  it('404s for a non-existent user', async () => {
    const res = await adminReq('/admin/dashboard-users/nonexistent-id', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('refuses to delete your own account', async () => {
    const { id } = seedDashboardUser(ADMIN_USER, 'pw', 'admin');
    // Authenticate AS that dashboard_users account (not the personal key) to
    // trigger the self-deletion path — userId resolves to the account's email.
    const apiKey = (db.prepare('SELECT api_key FROM dashboard_users WHERE id = ?').get(id) as { api_key: string }).api_key;
    const res = await adminReq(`/admin/dashboard-users/${id}`, { method: 'DELETE', key: apiKey });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT id FROM dashboard_users WHERE id = ?').get(id)).toBeDefined();
  });

  it('refuses to delete the last remaining admin', async () => {
    const { id } = seedDashboardUser('sole-admin@example.com', 'pw', 'admin');
    const res = await adminReq(`/admin/dashboard-users/${id}`, { method: 'DELETE' }); // via personal-key admin, not self
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT id FROM dashboard_users WHERE id = ?').get(id)).toBeDefined();
  });

  it('allows deleting an admin when another admin remains', async () => {
    const first = seedDashboardUser('admin-one@example.com', 'pw', 'admin');
    seedDashboardUser('admin-two@example.com', 'pw', 'admin');
    const res = await adminReq(`/admin/dashboard-users/${first.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });
});

describe('PUT /admin/dashboard-users/:id/password', () => {
  it('changes the password and the new one works for login', async () => {
    const { id } = seedDashboardUser('bob@example.com', 'old-pw', 'user');
    const res = await adminReq(`/admin/dashboard-users/${id}/password`, {
      method: 'PUT',
      body: { password: 'new-pw-456' },
    });
    expect(res.status).toBe(200);

    const oldLogin = await login('bob@example.com', 'old-pw');
    expect(oldLogin.status).toBe(401);
    const newLogin = await login('bob@example.com', 'new-pw-456');
    expect(newLogin.status).toBe(200);
  });

  it('rejects a missing password', async () => {
    const { id } = seedDashboardUser('bob@example.com', 'old-pw', 'user');
    const res = await adminReq(`/admin/dashboard-users/${id}/password`, {
      method: 'PUT',
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard-users auth boundary', () => {
  it('rejects all routes for a non-admin personal key', async () => {
    const server2 = createHttpServer({
      userMap: new Map([[ADMIN_KEY, ADMIN_USER], ['plain-key', 'plain-user']]),
      adminSet: new Set([ADMIN_USER]),
      dbGetter: () => db,
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', () => resolve()));
    const addr = server2.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}/admin/dashboard-users`;

    const res = await fetch(url, { headers: { Authorization: 'Bearer plain-key' } });
    expect(res.status).toBe(403);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
  });
});
