export type Cohort = { cache: string; score: number; lcp: number; fcp: number; tbt: number; cls: number; bytes: number; requests: number; uiReadyMs: number | null };
export type Run = { id: string; target_key: string; title: string; environment: string; scenario: string; profile: string; status: string; source: string; created_at: string; created_at_display: string; error_code: string | null;
  result: null | { buildId: string; lighthouseVersion: string; chromeVersion: string; cohorts: Cohort[]; samples?: unknown[] } };
export type Target = { key: string; title: string; projectId: string; environment: string; scenario: string; profile: string; enabled: boolean; intervalMinutes: number };
