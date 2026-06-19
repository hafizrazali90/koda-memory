import type {
  Stats,
  MemoriesResponse,
  MemoryDetail,
  GraphData,
  ValidationQueue,
  ValidationResult,
  AuditLog,
  MemoryFilters,
} from './types';

const BASE = '';  // same origin

export function getToken(): string {
  return localStorage.getItem('koda_token') || '';
}

export function setToken(token: string): void {
  localStorage.setItem('koda_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('koda_token');
}

export function hasToken(): boolean {
  return Boolean(getToken());
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// Stats
export const getStats = () => api<Stats>('/admin/stats');

// Memories
export function getMemories(filters: MemoryFilters = {}) {
  const params: Record<string, string> = {};
  if (filters.project) params.project = filters.project;
  if (filters.user_id) params.user_id = filters.user_id;
  if (filters.confidence) params.confidence = filters.confidence;
  if (filters.category) params.category = filters.category;
  if (filters.q) params.q = filters.q;
  if (filters.flagged) params.flagged = 'true';
  if (filters.page != null) params.page = String(filters.page);
  if (filters.per_page != null) params.per_page = String(filters.per_page);
  return api<MemoriesResponse>('/admin/memories?' + new URLSearchParams(params));
}

export const getMemory = (id: string) =>
  api<MemoryDetail>('/admin/memories/' + id);

export const deleteMemory = (id: string) =>
  api<{ ok: boolean }>('/admin/memories/' + id, { method: 'DELETE' });

export const restoreMemory = (id: string) =>
  api<{ ok: boolean }>('/admin/memories/' + id + '/restore', { method: 'POST' });

// Graph
export const getGraph = (project?: string) =>
  api<GraphData>('/admin/graph' + (project ? '?project=' + encodeURIComponent(project) : ''));

// Validation
export const getValidationQueue = () =>
  api<ValidationQueue>('/admin/validation/queue');

export const runValidation = (batchSize = 10) =>
  api<ValidationResult>('/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'validation_run', arguments: { batch_size: batchSize } },
      id: 1,
    }),
  });

// Audit
export const getAudit = (memoryId?: string) =>
  api<AuditLog>('/admin/audit' + (memoryId ? '?memory_id=' + memoryId : ''));
