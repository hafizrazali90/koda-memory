import type {
  Stats,
  MemoriesResponse,
  MemoryDetail,
  GraphData,
  ValidationQueue,
  ValidationResult,
  AuditLog,
  MemoryFilters,
  DashboardUser,
  DashboardUsersResponse,
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
export interface GraphOptions {
  project?: string;
  focus?: string;
  depth?: number;
  mode?: 'connected' | 'all';
}
export function getGraph(opts: GraphOptions = {}) {
  const params: Record<string, string> = {};
  if (opts.project) params.project = opts.project;
  if (opts.focus) params.focus = opts.focus;
  if (opts.depth != null) params.depth = String(opts.depth);
  if (opts.mode) params.mode = opts.mode;
  const qs = new URLSearchParams(params).toString();
  return api<GraphData>('/admin/graph' + (qs ? '?' + qs : ''));
}

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

// Dashboard user management
export const getDashboardUsers = () =>
  api<DashboardUsersResponse>('/admin/dashboard-users');

export const createDashboardUser = (email: string, password: string, role: 'admin' | 'user') =>
  api<DashboardUser>('/admin/dashboard-users', {
    method: 'POST',
    body: JSON.stringify({ email, password, role }),
  });

export const deleteDashboardUser = (id: string) =>
  api<{ ok: boolean }>('/admin/dashboard-users/' + id, { method: 'DELETE' });

export const changeUserPassword = (id: string, password: string) =>
  api<{ ok: boolean }>('/admin/dashboard-users/' + id + '/password', {
    method: 'PUT',
    body: JSON.stringify({ password }),
  });
