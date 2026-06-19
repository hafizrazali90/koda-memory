export interface ValidationJob {
  id: number;
  memory_id: string;
  job_type: 'duplicate_check' | 'contradiction_check' | 'staleness_decay';
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  last_error?: string;
  created_at: string;
  processed_at?: string;
}

export interface DuplicateResult {
  is_duplicate: boolean;
  duplicate_of?: string;
  similarity_reason?: string;
}

export interface ContradictionResult {
  contradicts: boolean;
  conflicting_id?: string;
  reason?: string;
}
