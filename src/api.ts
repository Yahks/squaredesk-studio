import type {
  BootstrapData,
  GenerationLogEntry,
  MasterPipeline,
  ProviderId,
  StandaloneGeneration,
} from './types';

export class ApiError extends Error {
  logs?: GenerationLogEntry[];
  generation?: StandaloneGeneration;

  constructor(
    message: string,
    extra?: { logs?: GenerationLogEntry[]; generation?: StandaloneGeneration }
  ) {
    super(message);
    this.name = 'ApiError';
    this.logs = extra?.logs;
    this.generation = extra?.generation;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    logs?: GenerationLogEntry[];
    generation?: StandaloneGeneration;
  };
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, {
      logs: data.logs,
      generation: data.generation,
    });
  }
  return data as T;
}

export const api = {
  bootstrap: () => request<BootstrapData>('/api/bootstrap'),

  // Accounts & Browser Profiles
  createAccount: (payload: Record<string, unknown>) =>
    request<{ ok: boolean; accountId: string; profileId: string }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAccount: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${id}`, { method: 'DELETE' }),
  clearCookies: (id: string) =>
    request<{ ok: boolean }>(`/api/accounts/${id}/clear-cookies`, { method: 'POST' }),
  checkProxy: (id: string) =>
    request<{ ok: boolean; ip: string; country: string; timezone: string; locale: string }>(
      `/api/accounts/${id}/check-proxy`,
      { method: 'POST' }
    ),
  authCheck: (id: string) =>
    request<{ ok: boolean; jobId: string }>(`/api/accounts/${id}/auth-check`, { method: 'POST' }),
  killBrowser: (id: string) =>
    request<{
      ok: boolean;
      accountId: string;
      label: string;
      closedContexts: number;
      stoppedJobs: number;
      killedPids: number;
    }>(`/api/accounts/${id}/kill-browser`, { method: 'POST' }),

  // Personas
  updatePersona: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean; writing_rules_file?: string }>(`/api/personas/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getPersonaRulesFileUrl: (id: string, download = false) =>
    `/api/personas/${encodeURIComponent(id)}/rules-file${download ? '?download=1' : ''}`,

  // Feature 1: Scraper & Source Posts
  runScraper: (accountId: string, feedTab: string, targetCount = 100, includeComments = true) =>
    request<{ ok: boolean; jobId: string }>('/api/scrape/run', {
      method: 'POST',
      body: JSON.stringify({ accountId, feedTab, targetCount, includeComments }),
    }),
  importHtml: (html: string, feedTab: string) =>
    request<{ ok: boolean; count: number; skippedDuplicates?: number; postIds: string[] }>(
      '/api/posts/import-html',
      {
        method: 'POST',
        body: JSON.stringify({ html, feedTab }),
      }
    ),
  getPostBundleUrl: (id: string, download = false) =>
    `/api/posts/${encodeURIComponent(id)}/file${download ? '?download=1' : ''}`,
  deletePost: (id: string) =>
    request<{ ok: boolean }>(`/api/posts/${id}`, { method: 'DELETE' }),

  // Feature 2: AI Providers & Generation
  validateProvider: (id: ProviderId, payload: { apiKey?: string; baseUrl?: string; selectedModel?: string }) =>
    request<{ ok: boolean; models: string[]; selectedModel: string; error?: string }>(
      `/api/providers/${id}/validate`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  updateProviderModel: (id: ProviderId, payload: { selectedModel?: string; baseUrl?: string }) =>
    request<{ ok: boolean }>(`/api/providers/${id}/model`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  generateArticle: (payload: {
    sourcePostIds: string[];
    personaId: string;
    providerId: ProviderId;
    model?: string;
    postFormat?: 'short_post' | 'long_article';
    customAngle?: string;
    scheduledFor?: string;
  }) =>
    request<{ ok: boolean; draft: unknown; logs?: GenerationLogEntry[] }>('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  generateStandalone: (payload: {
    sourcePostIds?: string[];
    providerId: ProviderId;
    model?: string;
    prompt: string;
    customInput?: string;
  }) =>
    request<{ ok: boolean; generation: StandaloneGeneration }>('/api/generate/standalone', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteStandaloneGeneration: (id: string) =>
    request<{ ok: boolean }>(`/api/generate/standalone/${id}`, { method: 'DELETE' }),

  // Feature 3: Drafts & Publishing
  updateDraft: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/drafts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteDraft: (id: string) =>
    request<{ ok: boolean }>(`/api/drafts/${id}`, { method: 'DELETE' }),
  publishDraft: (id: string, accountId?: string) =>
    request<{ ok: boolean; jobId: string; method?: 'square_openapi' | 'playwright_ui' }>(
      `/api/drafts/${id}/publish`,
      {
        method: 'POST',
        body: JSON.stringify(accountId ? { accountId } : {}),
      }
    ),

  // Challenges
  resolveJobChallenge: (
    jobId: string,
    payload: { mfaCode?: string; captchaAction?: { type: 'click' | 'confirm' | 'abort'; x?: number; y?: number } }
  ) =>
    request<{ ok: boolean }>(`/api/jobs/${jobId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Master Automated Pipeline
  savePipeline: (
    accountId: string,
    payload: {
      headless?: boolean;
      feedTab?: 'discover' | 'following' | 'news' | 'academy' | 'all';
      scrapeTargetCount?: number;
      scrapeIntervalHours?: number;
      generatePerCycle?: number;
      generateIntervalHours?: number;
      minSourceWords?: number;
      targetMinWords?: number;
      targetMaxWords?: number;
      providerId?: ProviderId;
      model?: string;
      publishIntervalHours?: number;
      nextScrapeAt?: string | null;
      nextGenerateAt?: string | null;
      nextPublishAt?: string | null;
    }
  ) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    ),
  startPipeline: (payload: {
    accountId: string;
    headless?: boolean;
    feedTab?: 'discover' | 'following' | 'news' | 'academy' | 'all';
    scrapeTargetCount?: number;
    scrapeIntervalHours?: number;
    generatePerCycle?: number;
    generateIntervalHours?: number;
    minSourceWords?: number;
    targetMinWords?: number;
    targetMaxWords?: number;
    providerId?: ProviderId;
    model?: string;
    publishIntervalHours?: number;
    nextScrapeAt?: string | null;
    nextGenerateAt?: string | null;
    nextPublishAt?: string | null;
  }) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>('/api/pipelines/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  pausePipeline: (accountId: string) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}/pause`,
      { method: 'POST' }
    ),
  stopPipeline: (accountId: string) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}/stop`,
      { method: 'POST' }
    ),
  killPipeline: (accountId: string) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}/kill`,
      { method: 'POST' }
    ),
  resumePipeline: (accountId: string) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}/resume`,
      { method: 'POST' }
    ),
  triggerPipelineCycle: (accountId: string) =>
    request<{ ok: boolean; pipeline: MasterPipeline }>(
      `/api/pipelines/${encodeURIComponent(accountId)}/trigger`,
      { method: 'POST' }
    ),
};
