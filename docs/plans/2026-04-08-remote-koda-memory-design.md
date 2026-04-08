# Remote Koda Memory — Design Doc

**Date:** 2026-04-08
**Goal:** Make Koda Memory accessible from any device over the internet, hosted on the staging VPS.

## Decision Summary

| Decision | Choice |
|----------|--------|
| Transport | HTTP only (StreamableHTTPServerTransport) — no stdio |
| Auth | Single shared API key via `Authorization: Bearer` header |
| Hosting | Staging VPS (`sims-staging.tutorla.tech`) |
| URL | `https://sims-staging.tutorla.tech/koda/mcp` |
| DB location | `/opt/koda/brain.db` (fixed path on server) |
| Backup | Daily cron job backing up `brain.db` |
| Multi-project | Already supported — `project` column in memories table |

## Code Changes (koda-memory repo)

### 1. Replace transport in `src/index.ts`

- Remove `StdioServerTransport`
- Add `StreamableHTTPServerTransport` from MCP SDK
- Listen on `PORT` env var (default 3848)
- Create a Node.js HTTP server that passes requests to the MCP transport

### 2. Add API key auth middleware

- Read `KODA_API_KEY` from env
- Before passing requests to MCP transport, check `Authorization: Bearer <key>` header
- Return 401 if missing or wrong
- Health endpoint `GET /health` bypasses auth (for uptime monitoring)

### 3. Make project name a tool parameter

- Currently `projectPath` is derived from `process.cwd()` or `KODA_PROJECT_PATH`
- On the server, there's no project path — all projects share one DB
- Add optional `project` param to tools that need it (memory_store, session_start, etc.)
- Default to `KODA_DEFAULT_PROJECT` env var if not provided by the caller

### 4. Fix DB path

- Change `getConnection()` to use `KODA_DB_PATH` env var (default `/opt/koda/brain.db`)
- Remove the per-project `.koda/` directory logic for HTTP mode

## VPS Deployment

### Nginx config

```nginx
location /koda/ {
    proxy_pass http://127.0.0.1:3848/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 600s;
}
```

### pm2 process

```bash
pm2 start dist/index.js --name koda-memory \
  --env KODA_API_KEY=<generated-key> \
  --env KODA_DB_PATH=/opt/koda/brain.db \
  --env OPENAI_API_KEY=<key> \
  --env PORT=3848
```

### Backup cron

```bash
0 3 * * * cp /opt/koda/brain.db /opt/koda/backups/brain-$(date +\%Y\%m\%d).db
0 4 * * * find /opt/koda/backups -mtime +30 -delete
```

Daily at 3am, keeps 30 days of backups.

## Client Config (per project)

Each project's `.claude/settings.json` mcpServers section:

```json
"memory": {
  "type": "sse",
  "url": "https://sims-staging.tutorla.tech/koda/mcp",
  "headers": {
    "Authorization": "Bearer <KODA_API_KEY>"
  }
}
```

## Migration

1. Copy existing `.koda/brain.db` from sifu-tutor to VPS `/opt/koda/brain.db`
2. Update sifu-tutor's MCP config to point to remote URL
3. Verify tools work: `memory_search`, `session_start`
4. Remove local `.koda/brain.db` from sifu-tutor (no longer needed)

## What Does NOT Change

- All 12 MCP tools — same names, same params, same behavior
- Database schema — identical
- OpenAI embeddings — same (key lives on server)
- How Claude Code calls the tools — transparent to the AI

## Risks

| Risk | Mitigation |
|------|------------|
| VPS goes down → no memory | Daily backups, can restore in minutes |
| Staging rebuild wipes Koda | `/opt/koda/` is outside app dirs, backup cron |
| API key leaked | Rotate key, update client configs |
| Latency | Koda is lightweight, SQLite queries are <10ms, network adds ~50-100ms — negligible |
