// ---- Core memory types ----

export type Confidence = 'confirmed' | 'inferred' | 'outdated';
export type Category =
  | 'fact'
  | 'preference'
  | 'rule'
  | 'lesson'
  | 'decision'
  | 'context'
  | 'reference'
  | string;

export type RelationType = 'supersedes' | 'contradicts' | 'relates-to' | 'depends-on';

export interface Memory {
  id: string;
  content: string;
  category: Category;
  confidence: Confidence;
  tags: string[];
  user_id: string;
  project?: string;
  source?: string;
  why?: string;
  created_at: string;
  updated_at: string;
  last_accessed?: string;
  access_count: number;
  flagged?: boolean;
  flag_reason?: string;
  scope?: 'personal' | 'project';
  superseded_by?: string;
}

export interface MemoryRelation {
  id: string;
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  created_at: string;
}

// ---- API response types ----

export interface Stats {
  total: number;
  confirmed: number;
  inferred: number;
  outdated: number;
  flagged: number;
  superseded: number;
  queue_depth: number;
  search_gaps: number;
  by_user: Array<{ user_id: string; count: number }>;
  by_project: Array<{ project: string; count: number }>;
  by_category: Array<{ category: string; count: number }>;
  by_confidence: Array<{ confidence: string; count: number }>;
}

export interface MemoriesResponse {
  memories: Memory[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface MemoryDetail extends Memory {
  relations: Array<{
    relation_type: RelationType;
    direction: 'outgoing' | 'incoming';
    memory: Memory;
  }>;
}

// ---- Graph types ----

export interface GraphNode {
  id: string;
  label: string;
  confidence: Confidence;
  access_count: number;
  project?: string;
  category?: Category;
  content: string;
}

export interface GraphLink {
  source: string;
  target: string;
  relation_type: RelationType;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ---- Validation types ----

export interface ValidationJob {
  id: string;
  memory_id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  created_at: string;
  completed_at?: string;
  result?: string;
  error?: string;
}

export interface ValidationQueue {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  jobs: ValidationJob[];
}

export interface ValidationResult {
  processed: number;
  updated: number;
  errors: number;
  details?: Array<{ id: string; old: string; new: string; reason: string }>;
}

// ---- Audit types ----

export interface AuditEntry {
  id: string;
  memory_id: string;
  action: string;
  actor: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  created_at: string;
}

export interface AuditLog {
  entries: AuditEntry[];
  total: number;
}

// ---- Filter types ----

export interface MemoryFilters {
  project?: string;
  user_id?: string;
  confidence?: Confidence | '';
  category?: Category | '';
  q?: string;
  flagged?: boolean;
  page?: number;
  per_page?: number;
}
