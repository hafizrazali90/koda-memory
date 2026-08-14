import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { openDatabase } from './db/connection.js';
import { createHttpServer } from './index.js';
import { memoryStore } from './tools/memory-store.js';

const TEST_KEY = 'mcp-http-test-key';
const TEST_USER = 'mcp-http-test-user';
const SECOND_KEY = 'mcp-http-second-key';
const SECOND_USER = 'mcp-http-second-user';

describe('stateless MCP HTTP transport', () => {
  const testDir = path.join(os.tmpdir(), `koda-mcp-http-${Date.now()}`);
  let db: Database.Database;
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl: string;

  beforeAll(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    db = openDatabase({ dbPath: path.join(testDir, 'brain.db') });
    await memoryStore(
      db,
      'mcp-http-test',
      TEST_USER,
      {
        content: 'Stateless transport canary memory',
        category: 'fact',
        source: 'auto-captured',
        tags: ['transport-canary'],
      },
      TEST_USER,
    );
    await memoryStore(
      db,
      'mcp-http-test',
      SECOND_USER,
      {
        content: 'Second user private transport memory',
        category: 'fact',
        source: 'auto-captured',
        tags: ['transport-isolation'],
      },
      SECOND_USER,
    );
    server = createHttpServer({
      userMap: new Map([
        [TEST_KEY, TEST_USER],
        [SECOND_KEY, SECOND_USER],
      ]),
      dbGetter: () => db,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function mcpPost(body: unknown, key = TEST_KEY) {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function readJsonRpc(response: Response): Promise<{
    result?: {
      serverInfo?: { name?: string };
      content?: Array<{ text?: string }>;
    };
  }> {
    const text = await response.text();
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    return JSON.parse(dataLine ? dataLine.slice('data:'.length).trim() : text);
  }

  it('initializes without creating a persistent MCP session', async () => {
    const response = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'koda-test', version: '1.0.0' },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const payload = await readJsonRpc(response);
    expect(payload.result?.serverInfo?.name).toBe('koda-memory');
  });

  it('serves a tool call on a separate request with no session header', async () => {
    const response = await mcpPost({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: {
          query: 'Stateless transport canary',
          project: 'mcp-http-test',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const payload = await readJsonRpc(response);
    expect(payload.result?.content?.[0]?.text).toContain(
      'Stateless transport canary memory',
    );
  });

  it('ignores a stale session header left by the previous deployment', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_KEY}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'stale-session-from-old-server',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'memory_search',
          arguments: {
            query: 'Stateless transport canary',
            project: 'mcp-http-test',
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const payload = await readJsonRpc(response);
    expect(payload.result?.content?.[0]?.text).toContain(
      'Stateless transport canary memory',
    );
  });

  it('serves 50 independent reads without retaining transport sessions', async () => {
    for (let index = 0; index < 50; index += 1) {
      const response = await mcpPost({
        jsonrpc: '2.0',
        id: 100 + index,
        method: 'tools/call',
        params: {
          name: 'memory_search',
          arguments: {
            query: 'Stateless transport canary',
            project: 'mcp-http-test',
          },
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const payload = await readJsonRpc(response);
      expect(payload.result?.content?.[0]?.text).toContain(
        'Stateless transport canary memory',
      );
    }
  });

  it('negotiates and serves the modern 2026 protocol with the official client', async () => {
    const methods: string[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        authProvider: { token: async () => TEST_KEY },
        fetch: (input, init) => {
          methods.push(init?.method ?? 'GET');
          return fetch(input, init);
        },
      },
    );
    const client = new Client(
      { name: 'koda-modern-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('memory_search');
      expect(methods).not.toContain('GET');
    } finally {
      await client.close();
    }
  });

  it('keeps concurrent users isolated on separate stateless requests', async () => {
    const request = (query: string, key: string, id: number) =>
      mcpPost(
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'memory_search',
            arguments: { query, project: 'mcp-http-test' },
          },
        },
        key,
      );

    const [firstResponse, secondResponse] = await Promise.all([
      request('private transport memory', TEST_KEY, 20),
      request('private transport memory', SECOND_KEY, 21),
    ]);
    const [firstPayload, secondPayload] = await Promise.all([
      readJsonRpc(firstResponse),
      readJsonRpc(secondResponse),
    ]);
    const firstText = firstPayload.result?.content?.[0]?.text ?? '';
    const secondText = secondPayload.result?.content?.[0]?.text ?? '';

    expect(firstText).not.toContain('Second user private transport memory');
    expect(secondText).toContain('Second user private transport memory');
    expect(secondText).not.toContain('Stateless transport canary memory');
  });

  it('supports an exact-content preflight when a write response is ambiguous', async () => {
    const content = 'Ambiguous write response transport canary';
    const response = await mcpPost({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'memory_store',
        arguments: {
          content,
          category: 'fact',
          source: 'auto-captured',
          project: 'mcp-http-test',
          tags: ['ambiguous-write-canary'],
        },
      },
    });

    // Deliberately do not trust or parse the write response. A client that
    // loses the response must search before deciding whether to retry.
    expect(response.status).toBe(200);

    const preflight = await mcpPost({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'memory_search',
        arguments: { query: content, project: 'mcp-http-test' },
      },
    });
    const payload = await readJsonRpc(preflight);
    expect(payload.result?.content?.[0]?.text).toContain(content);

    const row = db
      .prepare(
        'SELECT COUNT(*) AS count FROM memories WHERE user_id = ? AND content = ?',
      )
      .get(TEST_USER, content) as { count: number };
    expect(row.count).toBe(1);
  });

  it('rejects missing and invalid credentials before MCP handling', async () => {
    const missing = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    const invalid = await mcpPost(
      { jsonrpc: '2.0', id: 4, method: 'ping' },
      'wrong-key',
    );

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it('does not expose the old persistent SSE and message routes', async () => {
    const messages = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });
    const sessionGet = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });

    expect(messages.status).toBe(404);
    expect(sessionGet.status).toBe(405);
  });
});
