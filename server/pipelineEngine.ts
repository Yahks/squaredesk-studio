import crypto from 'node:crypto';
import {
  countArticleWords,
  generatePersonaArticle,
  type ProviderId,
} from './aiProviders.ts';
import { decryptSecret } from './crypto.ts';
import { db } from './db.ts';
import {
  killAccountBrowser,
  startPublishJob,
  startScrapeJob,
} from './playwrightEngine.ts';

export type PipelineStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'error';
export type PipelineStage =
  | 'idle'
  | 'scraping'
  | 'generating'
  | 'publishing'
  | 'waiting'
  | 'paused'
  | 'stopped'
  | 'error';
export type CyclePhase = 'scrape' | 'generate' | 'publish';

export interface PipelineLogEntry {
  ts: string;
  stage: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export interface PipelineRow {
  id: string;
  account_id: string;
  status: PipelineStatus;
  current_stage: PipelineStage;
  cycle_phase: CyclePhase;
  headless: number;
  feed_tab: 'discover' | 'following' | 'news' | 'academy' | 'all';
  scrape_target_count: number;
  scrape_interval_hours: number;
  generate_per_cycle: number;
  generate_interval_hours: number;
  min_source_words: number;
  target_min_words: number;
  target_max_words: number;
  provider_id: ProviderId;
  model: string;
  publish_interval_hours: number;
  total_scraped: number;
  total_generated: number;
  total_published: number;
  last_scrape_at: string | null;
  next_scrape_at: string | null;
  last_generate_at: string | null;
  next_generate_at: string | null;
  last_publish_at: string | null;
  next_publish_at: string | null;
  last_error: string;
  logs: string;
  updated_at: string;
}

export interface SanitizedPipeline {
  id: string;
  account_id: string;
  status: PipelineStatus;
  current_stage: PipelineStage;
  cycle_phase: CyclePhase;
  headless: boolean;
  feed_tab: 'discover' | 'following' | 'news' | 'academy' | 'all';
  scrape_target_count: number;
  scrape_interval_hours: number;
  generate_per_cycle: number;
  generate_interval_hours: number;
  min_source_words: number;
  target_min_words: number;
  target_max_words: number;
  provider_id: ProviderId;
  model: string;
  publish_interval_hours: number;
  total_scraped: number;
  total_generated: number;
  total_published: number;
  last_scrape_at: string | null;
  next_scrape_at: string | null;
  last_generate_at: string | null;
  next_generate_at: string | null;
  last_publish_at: string | null;
  next_publish_at: string | null;
  last_error: string;
  logs: PipelineLogEntry[];
  updated_at: string;
}

export interface PipelineConfigInput {
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
}

const activePipelineRuns = new Set<string>();
const abortedPipelineAccounts = new Set<string>();
let schedulerStarted = false;

function serializePipeline(row: PipelineRow): SanitizedPipeline {
  let parsedLogs: PipelineLogEntry[] = [];
  try {
    const p = JSON.parse(row.logs || '[]');
    if (Array.isArray(p)) parsedLogs = p;
  } catch {
    parsedLogs = [];
  }
  const cyclePhase: CyclePhase =
    row.cycle_phase === 'generate' || row.cycle_phase === 'publish' ? row.cycle_phase : 'scrape';
  return {
    ...row,
    cycle_phase: cyclePhase,
    headless: row.headless === undefined ? true : Boolean(row.headless),
    generate_interval_hours: Number(row.generate_interval_hours ?? 2),
    next_generate_at: row.next_generate_at ?? null,
    logs: parsedLogs,
  };
}

export function listPipelines(): SanitizedPipeline[] {
  const rows = db
    .prepare('SELECT * FROM pipelines ORDER BY updated_at DESC')
    .all() as unknown as PipelineRow[];
  return rows.map(serializePipeline);
}

function getPipelineRow(accountId: string): PipelineRow | undefined {
  return db
    .prepare('SELECT * FROM pipelines WHERE account_id = ?')
    .get(accountId) as PipelineRow | undefined;
}

function appendPipelineLog(
  accountId: string,
  stage: string,
  message: string,
  level: 'info' | 'success' | 'error' = 'info'
) {
  const row = getPipelineRow(accountId);
  if (!row) return;
  let logs: PipelineLogEntry[] = [];
  try {
    const parsed = JSON.parse(row.logs || '[]');
    if (Array.isArray(parsed)) logs = parsed;
  } catch {
    logs = [];
  }
  logs.push({ ts: new Date().toISOString(), stage, level, message });
  if (logs.length > 150) {
    logs = logs.slice(logs.length - 150);
  }
  db.prepare('UPDATE pipelines SET logs = ?, updated_at = ? WHERE account_id = ?').run(
    JSON.stringify(logs),
    new Date().toISOString(),
    accountId
  );
}

function throwIfPipelineAborted(accountId: string) {
  if (abortedPipelineAccounts.has(accountId)) {
    throw new Error('Pipeline stopped by operator.');
  }
  const row = getPipelineRow(accountId);
  if (!row || row.status === 'stopped' || row.status === 'paused') {
    throw new Error('Pipeline stopped by operator.');
  }
}

function validateMasterAccount(accountId: string) {
  const account = db
    .prepare(
      'SELECT id, role, label, binance_square_api_key_enc FROM accounts WHERE id = ?'
    )
    .get(accountId) as
    | {
        id: string;
        role: string;
        label: string;
        binance_square_api_key_enc?: string;
      }
    | undefined;
  if (!account) {
    throw new Error('Master account not found.');
  }
  if (account.role !== 'publisher') {
    throw new Error('Master pipeline requires a Publisher account with a Persona and Square API Key.');
  }
  const creatorKey = account.binance_square_api_key_enc
    ? decryptSecret(account.binance_square_api_key_enc).trim()
    : '';
  if (!creatorKey) {
    throw new Error(
      `Account "${account.label}" does not have a Binance Square Creator OpenAPI Key configured. Add one in Accounts & Proxies before automating.`
    );
  }

  const persona = db
    .prepare('SELECT id, display_name FROM personas WHERE account_id = ?')
    .get(accountId) as { id: string; display_name: string } | undefined;
  if (!persona) {
    throw new Error(`No persona is linked to account "${account.label}".`);
  }

  return { account, persona };
}

function normalizeOptionalIso(value: string | null | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function normalizeHours(val: unknown, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.min(168, num);
}

function normalizePipelineConfig(input: PipelineConfigInput, existing?: PipelineRow) {
  const feedTab = (
    ['discover', 'following', 'news', 'academy', 'all'].includes(input.feedTab || '')
      ? input.feedTab
      : existing?.feed_tab || 'discover'
  ) as 'discover' | 'following' | 'news' | 'academy' | 'all';

  const headless =
    input.headless !== undefined
      ? Boolean(input.headless)
      : existing
      ? Boolean(existing.headless ?? 1)
      : true;

  const scrapeTargetCount = Math.min(
    200,
    Math.max(1, Math.round(Number(input.scrapeTargetCount ?? existing?.scrape_target_count) || 20))
  );
  const scrapeIntervalHours = normalizeHours(
    input.scrapeIntervalHours ?? existing?.scrape_interval_hours,
    5
  );
  const generatePerCycle = Math.min(
    10,
    Math.max(1, Math.round(Number(input.generatePerCycle ?? existing?.generate_per_cycle) || 1))
  );
  const generateIntervalHours = normalizeHours(
    input.generateIntervalHours ?? existing?.generate_interval_hours,
    0.5
  );
  const minSourceWords = Math.min(
    500,
    Math.max(20, Math.round(Number(input.minSourceWords ?? existing?.min_source_words) || 100))
  );
  const targetMinWords = Math.min(
    2000,
    Math.max(300, Math.round(Number(input.targetMinWords ?? existing?.target_min_words) || 870))
  );
  const targetMaxWords = Math.min(
    2500,
    Math.max(targetMinWords + 100, Math.round(Number(input.targetMaxWords ?? existing?.target_max_words) || 1340))
  );
  const publishIntervalHours = normalizeHours(
    input.publishIntervalHours ?? existing?.publish_interval_hours,
    1
  );
  const providerId = (
    ['gemini', 'groq', 'openrouter', 'amadd'].includes(input.providerId || '')
      ? input.providerId
      : existing?.provider_id || 'gemini'
  ) as ProviderId;
  const model = (input.model ?? existing?.model ?? '').trim();

  const nextScrapeAt = normalizeOptionalIso(input.nextScrapeAt, existing?.next_scrape_at ?? null);
  const nextGenerateAt = normalizeOptionalIso(input.nextGenerateAt, existing?.next_generate_at ?? null);
  const nextPublishAt = normalizeOptionalIso(input.nextPublishAt, existing?.next_publish_at ?? null);

  return {
    headless,
    feedTab,
    scrapeTargetCount,
    scrapeIntervalHours,
    generatePerCycle,
    generateIntervalHours,
    minSourceWords,
    targetMinWords,
    targetMaxWords,
    publishIntervalHours,
    providerId,
    model,
    nextScrapeAt,
    nextGenerateAt,
    nextPublishAt,
  };
}

export function savePipelineConfig(input: PipelineConfigInput): SanitizedPipeline {
  const existing = getPipelineRow(input.accountId);
  const cfg = normalizePipelineConfig(input, existing);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE pipelines SET
        headless = ?,
        feed_tab = ?,
        scrape_target_count = ?,
        scrape_interval_hours = ?,
        generate_per_cycle = ?,
        generate_interval_hours = ?,
        min_source_words = ?,
        target_min_words = ?,
        target_max_words = ?,
        provider_id = ?,
        model = ?,
        publish_interval_hours = ?,
        next_scrape_at = ?,
        next_generate_at = ?,
        next_publish_at = ?,
        updated_at = ?
      WHERE account_id = ?
    `).run(
      cfg.headless ? 1 : 0,
      cfg.feedTab,
      cfg.scrapeTargetCount,
      cfg.scrapeIntervalHours,
      cfg.generatePerCycle,
      cfg.generateIntervalHours,
      cfg.minSourceWords,
      cfg.targetMinWords,
      cfg.targetMaxWords,
      cfg.providerId,
      cfg.model,
      cfg.publishIntervalHours,
      cfg.nextScrapeAt,
      cfg.nextGenerateAt,
      cfg.nextPublishAt,
      now,
      input.accountId
    );
  } else {
    const id = `PIPE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.prepare(`
      INSERT INTO pipelines (
        id, account_id, status, current_stage, cycle_phase, headless, feed_tab,
        scrape_target_count, scrape_interval_hours, generate_per_cycle, generate_interval_hours,
        min_source_words, target_min_words, target_max_words,
        provider_id, model, publish_interval_hours,
        next_scrape_at, next_generate_at, next_publish_at, logs, updated_at
      ) VALUES (?, ?, 'idle', 'idle', 'scrape', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
    `).run(
      id,
      input.accountId,
      cfg.headless ? 1 : 0,
      cfg.feedTab,
      cfg.scrapeTargetCount,
      cfg.scrapeIntervalHours,
      cfg.generatePerCycle,
      cfg.generateIntervalHours,
      cfg.minSourceWords,
      cfg.targetMinWords,
      cfg.targetMaxWords,
      cfg.providerId,
      cfg.model,
      cfg.publishIntervalHours,
      cfg.nextScrapeAt,
      cfg.nextGenerateAt,
      cfg.nextPublishAt,
      now
    );
  }

  return serializePipeline(getPipelineRow(input.accountId)!);
}

async function waitForAutomationJob(jobId: string, accountId: string): Promise<{
  status: string;
  challenge_message: string;
}> {
  const maxWaitMs = 15 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    throwIfPipelineAborted(accountId);
    const job = db
      .prepare('SELECT status, challenge_message FROM automation_jobs WHERE id = ?')
      .get(jobId) as { status: string; challenge_message: string } | undefined;
    if (!job) {
      throw new Error(`Automation job ${jobId} disappeared.`);
    }
    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Automation job ${jobId} timed out waiting for completion.`);
}

async function runScrapePhase(row: PipelineRow, accountLabel: string): Promise<number> {
  throwIfPipelineAborted(row.account_id);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE pipelines SET current_stage = 'scraping', cycle_phase = 'scrape', updated_at = ? WHERE account_id = ?`
  ).run(now, row.account_id);

  const isHeadless = row.headless === undefined ? true : Boolean(row.headless);
  appendPipelineLog(
    row.account_id,
    'Scrape',
    `Starting guest-mode unique post scrape (${row.feed_tab}, target ${row.scrape_target_count} posts, ${
      isHeadless ? 'headless' : 'visible browser'
    }, no comments, no login) via ${accountLabel}...`
  );

  const beforeCount = (
    db.prepare('SELECT COUNT(*) as c FROM source_posts').get() as { c: number }
  ).c;

  const jobId = await startScrapeJob({
    accountId: row.account_id,
    feedTab: row.feed_tab,
    targetCount: row.scrape_target_count,
    includeComments: false,
    guestOnly: true,
    allowPublisherMaster: true,
    headless: isHeadless,
  });

  appendPipelineLog(row.account_id, 'Scrape', `Launched scrape job ${jobId}; collecting unique posts...`);

  const result = await waitForAutomationJob(jobId, row.account_id);
  const afterCount = (
    db.prepare('SELECT COUNT(*) as c FROM source_posts').get() as { c: number }
  ).c;
  const newlySaved = Math.max(0, afterCount - beforeCount);

  if (result.status === 'failed') {
    throw new Error(
      `Scrape job ${jobId} failed: ${result.challenge_message || 'Unable to scrape feed.'}`
    );
  }

  const finishedIso = new Date().toISOString();
  db.prepare(`
    UPDATE pipelines SET
      total_scraped = total_scraped + ?,
      last_scrape_at = ?,
      next_scrape_at = NULL,
      cycle_phase = 'generate',
      next_generate_at = ?,
      updated_at = ?
    WHERE account_id = ?
  `).run(newlySaved, finishedIso, finishedIso, finishedIso, row.account_id);

  appendPipelineLog(
    row.account_id,
    'Scrape',
    `Scrape finished (${jobId}): ${newlySaved} new unique post(s) collected. Scraping PAUSED -> Rewrite/Generate picking up now.`,
    'success'
  );

  return newlySaved;
}

function findQualifyingUnusedPosts(personaId: string, minSourceWords: number) {
  const allPosts = db
    .prepare('SELECT id, author, content, used_by_persona_ids, collected_at FROM source_posts ORDER BY collected_at DESC')
    .all() as Array<{
    id: string;
    author: string;
    content: string;
    used_by_persona_ids: string;
    collected_at: string;
  }>;

  let unusedCount = 0;
  let skippedShortCount = 0;
  const qualifying: Array<{ id: string; author: string; wordCount: number }> = [];

  for (const sp of allPosts) {
    let usedBy: string[] = [];
    try {
      const parsed = JSON.parse(sp.used_by_persona_ids || '[]');
      if (Array.isArray(parsed)) usedBy = parsed;
    } catch {
      usedBy = [];
    }
    if (usedBy.includes(personaId)) continue;
    unusedCount++;
    const wc = countArticleWords(sp.content);
    if (wc > minSourceWords) {
      qualifying.push({ id: sp.id, author: sp.author, wordCount: wc });
    } else {
      skippedShortCount++;
    }
  }

  return { unusedCount, skippedShortCount, qualifying };
}

function countApprovedDraftsForPersona(personaId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) as c FROM drafts WHERE persona_id = ? AND status = 'approved'`)
      .get(personaId) as { c: number }
  ).c;
}

async function runSingleRewriteStep(
  row: PipelineRow,
  persona: { id: string; display_name: string }
): Promise<'rewrote_more_left' | 'rewrote_all_done' | 'none_available'> {
  throwIfPipelineAborted(row.account_id);
  db.prepare(
    `UPDATE pipelines SET current_stage = 'generating', cycle_phase = 'generate', updated_at = ? WHERE account_id = ?`
  ).run(new Date().toISOString(), row.account_id);

  const { unusedCount, skippedShortCount, qualifying } = findQualifyingUnusedPosts(
    persona.id,
    row.min_source_words
  );

  if (qualifying.length === 0) {
    appendPipelineLog(
      row.account_id,
      'Filter',
      `Evaluated ${unusedCount} unused post(s): 0 exceed ${row.min_source_words} words (${skippedShortCount} skipped).`
    );
    return 'none_available';
  }

  const item = qualifying[0];
  const remainingAfterThis = qualifying.length - 1;

  appendPipelineLog(
    row.account_id,
    'Rewrite',
    `Rewriting 1 article (#${item.id.slice(-6)}, ${item.wordCount} source words, by ${item.author}) as "${persona.display_name}" -> ${row.target_min_words}–${row.target_max_words} words (${qualifying.length} qualifying in queue)...`
  );

  const { draft } = await generatePersonaArticle({
    sourcePostIds: [item.id],
    personaId: persona.id,
    providerId: row.provider_id,
    model: row.model || undefined,
    postFormat: 'long_article',
    targetWordRange: {
      min: row.target_min_words,
      max: row.target_max_words,
    },
    initialStatus: 'approved',
  });

  const typedDraft = draft as { id: string; title: string; content: string };
  const finalWords = countArticleWords(typedDraft.content || '');
  const latestCfg = getPipelineRow(row.account_id) || row;
  const perArticleHours = Number(latestCfg.generate_interval_hours ?? 0.5);
  const finishedAt = new Date();
  const finishedIso = finishedAt.toISOString();

  if (remainingAfterThis > 0) {
    const nextGenIso = new Date(finishedAt.getTime() + perArticleHours * 3600 * 1000).toISOString();
    db.prepare(`
      UPDATE pipelines SET
        total_generated = total_generated + 1,
        last_generate_at = ?,
        next_generate_at = ?,
        cycle_phase = 'generate',
        updated_at = ?
      WHERE account_id = ?
    `).run(finishedIso, nextGenIso, finishedIso, row.account_id);

    appendPipelineLog(
      row.account_id,
      'Rewrite',
      `Generated ${typedDraft.id} ("${typedDraft.title}", ${finalWords} words). ${remainingAfterThis} scraped article(s) left to rewrite -> next rewrite in ${perArticleHours}h.`,
      'success'
    );
    return 'rewrote_more_left';
  }

  // All qualifying scraped articles are done -> pause rewrite and start publish phase!
  db.prepare(`
    UPDATE pipelines SET
      total_generated = total_generated + 1,
      last_generate_at = ?,
      next_generate_at = NULL,
      cycle_phase = 'publish',
      next_publish_at = ?,
      updated_at = ?
    WHERE account_id = ?
  `).run(finishedIso, finishedIso, finishedIso, row.account_id);

  appendPipelineLog(
    row.account_id,
    'Rewrite',
    `Generated ${typedDraft.id} ("${typedDraft.title}", ${finalWords} words). All qualifying scraped articles rewritten -> Rewriting PAUSED, Publishing starting now.`,
    'success'
  );
  return 'rewrote_all_done';
}

async function runSinglePublishStep(
  row: PipelineRow,
  persona: { id: string; display_name: string }
): Promise<'published_more_left' | 'published_all_done' | 'none_available'> {
  throwIfPipelineAborted(row.account_id);
  validateMasterAccount(row.account_id);

  const nextDraft = db
    .prepare(
      `SELECT id, title, content FROM drafts WHERE persona_id = ? AND status = 'approved' ORDER BY generated_at ASC LIMIT 1`
    )
    .get(persona.id) as { id: string; title: string; content: string } | undefined;

  if (!nextDraft) {
    return 'none_available';
  }

  db.prepare(
    `UPDATE pipelines SET current_stage = 'publishing', cycle_phase = 'publish', updated_at = ? WHERE account_id = ?`
  ).run(new Date().toISOString(), row.account_id);

  const wordCount = countArticleWords(nextDraft.content);
  appendPipelineLog(
    row.account_id,
    'Publish',
    `Publishing 1 article ${nextDraft.id} ("${nextDraft.title}", ${wordCount} words) via Binance Square Creator OpenAPI...`
  );

  const { jobId, method } = await startPublishJob(nextDraft.id, row.account_id);
  if (method !== 'square_openapi') {
    throw new Error('Pipeline publishing requires Binance Square Creator OpenAPI Key.');
  }

  const jobResult = await waitForAutomationJob(jobId, row.account_id);
  if (jobResult.status === 'failed') {
    throw new Error(
      `OpenAPI publish job ${jobId} failed for ${nextDraft.id}: ${jobResult.challenge_message || 'API error'}`
    );
  }

  const publishedDraft = db
    .prepare('SELECT binance_post_id FROM drafts WHERE id = ?')
    .get(nextDraft.id) as { binance_post_id: string | null } | undefined;

  const latestCfg = getPipelineRow(row.account_id) || row;
  const perArticlePubHours = Number(latestCfg.publish_interval_hours ?? 1);
  const finishedAt = new Date();
  const finishedIso = finishedAt.toISOString();
  const remainingApproved = countApprovedDraftsForPersona(persona.id);

  if (remainingApproved > 0) {
    const nextPubIso = new Date(
      finishedAt.getTime() + perArticlePubHours * 3600 * 1000
    ).toISOString();
    db.prepare(`
      UPDATE pipelines SET
        total_published = total_published + 1,
        last_publish_at = ?,
        next_publish_at = ?,
        cycle_phase = 'publish',
        updated_at = ?
      WHERE account_id = ?
    `).run(finishedIso, nextPubIso, finishedIso, row.account_id);

    appendPipelineLog(
      row.account_id,
      'Publish',
      `Published ${nextDraft.id} (Post ID: ${
        publishedDraft?.binance_post_id || 'confirmed'
      }). ${remainingApproved} article(s) remaining in queue -> next publish in ${perArticlePubHours}h.`,
      'success'
    );
    return 'published_more_left';
  }

  // All generated articles published -> resume Scrape phase!
  const lastScrapeMs = latestCfg.last_scrape_at
    ? new Date(latestCfg.last_scrape_at).getTime()
    : finishedAt.getTime();
  const scrapeIntervalMs = Number(latestCfg.scrape_interval_hours ?? 5) * 3600 * 1000;
  const nextScrapeMs = Math.max(finishedAt.getTime(), lastScrapeMs + scrapeIntervalMs);
  const nextScrapeIso = new Date(nextScrapeMs).toISOString();
  const immediateResume = nextScrapeMs <= Date.now() + 2000;

  db.prepare(`
    UPDATE pipelines SET
      total_published = total_published + 1,
      last_publish_at = ?,
      next_publish_at = NULL,
      cycle_phase = 'scrape',
      next_scrape_at = ?,
      updated_at = ?
    WHERE account_id = ?
  `).run(finishedIso, nextScrapeIso, finishedIso, row.account_id);

  appendPipelineLog(
    row.account_id,
    'Publish',
    `Published ${nextDraft.id} (Post ID: ${
      publishedDraft?.binance_post_id || 'confirmed'
    }). All generated articles published -> ${
      immediateResume
        ? 'Scraping phase resuming now.'
        : `Scraping phase armed to resume in ${Math.max(
            1,
            Math.round((nextScrapeMs - finishedAt.getTime()) / 60000)
          )}m.`
    }`,
    'success'
  );
  return 'published_all_done';
}

function transitionGenerateToNextPhase(
  accountId: string,
  personaId: string,
  reason: string
): 'publish' | 'scrape' {
  const row = getPipelineRow(accountId)!;
  const approvedCount = countApprovedDraftsForPersona(personaId);
  const now = new Date();
  const nowIso = now.toISOString();

  if (approvedCount > 0) {
    db.prepare(`
      UPDATE pipelines SET
        cycle_phase = 'publish',
        next_generate_at = NULL,
        next_publish_at = ?,
        updated_at = ?
      WHERE account_id = ?
    `).run(nowIso, nowIso, accountId);
    appendPipelineLog(
      accountId,
      'Cycle',
      `${reason} Switching to Publish phase (${approvedCount} queued article(s)).`
    );
    return 'publish';
  }

  const scrapeWaitMs = Number(row.scrape_interval_hours ?? 5) * 3600 * 1000;
  const lastScrapeMs = row.last_scrape_at ? new Date(row.last_scrape_at).getTime() : now.getTime();
  const nextScrapeMs = Math.max(now.getTime(), lastScrapeMs + scrapeWaitMs);
  const nextScrapeIso = new Date(nextScrapeMs).toISOString();
  db.prepare(`
    UPDATE pipelines SET
      cycle_phase = 'scrape',
      next_generate_at = NULL,
      next_scrape_at = ?,
      updated_at = ?
    WHERE account_id = ?
  `).run(nextScrapeIso, nowIso, accountId);
  appendPipelineLog(
    accountId,
    'Cycle',
    `${reason} No drafts queued to publish; returning to Scrape phase (${
      nextScrapeMs <= Date.now() + 2000
        ? 'resuming immediately'
        : `next scrape in ${Math.max(1, Math.round((nextScrapeMs - now.getTime()) / 60000))}m`
    }).`
  );
  return 'scrape';
}

function transitionPublishToScrape(accountId: string, reason: string) {
  const row = getPipelineRow(accountId)!;
  const now = new Date();
  const scrapeWaitMs = Number(row.scrape_interval_hours ?? 5) * 3600 * 1000;
  const lastScrapeMs = row.last_scrape_at ? new Date(row.last_scrape_at).getTime() : now.getTime();
  const nextScrapeMs = Math.max(now.getTime(), lastScrapeMs + scrapeWaitMs);
  const nextScrapeIso = new Date(nextScrapeMs).toISOString();
  db.prepare(`
    UPDATE pipelines SET
      cycle_phase = 'scrape',
      next_publish_at = NULL,
      next_scrape_at = ?,
      updated_at = ?
    WHERE account_id = ?
  `).run(nextScrapeIso, now.toISOString(), accountId);
  appendPipelineLog(accountId, 'Cycle', `${reason} Scrape phase will resume at scheduled window.`);
}

async function executePipelineRun(
  accountId: string,
  mode: 'start' | 'resume' | 'scheduled' | 'trigger'
) {
  if (activePipelineRuns.has(accountId)) return;
  activePipelineRuns.add(accountId);

  try {
    let row = getPipelineRow(accountId);
    if (!row || row.status !== 'running') return;
    if (abortedPipelineAccounts.has(accountId)) return;

    const { account, persona } = validateMasterAccount(accountId);

    // Step through sequential state machine phases: scrape -> generate -> publish -> scrape
    let safetyHops = 0;
    while (safetyHops < 30) {
      safetyHops++;
      throwIfPipelineAborted(accountId);
      row = getPipelineRow(accountId)!;
      if (row.status !== 'running') break;

      const nowMs = Date.now();
      const phase: CyclePhase =
        row.cycle_phase === 'generate' || row.cycle_phase === 'publish' ? row.cycle_phase : 'scrape';

      if (phase === 'scrape') {
        const scrapeDue =
          mode === 'trigger' ||
          !row.next_scrape_at ||
          new Date(row.next_scrape_at).getTime() <= nowMs;
        if (!scrapeDue) {
          break;
        }
        await runScrapePhase(row, account.label);
        // Immediately pick up rewrite/generate phase in the same pass
        continue;
      }

      if (phase === 'generate') {
        const genDue =
          mode === 'trigger' ||
          !row.next_generate_at ||
          new Date(row.next_generate_at).getTime() <= nowMs;
        if (!genDue) {
          break;
        }
        const outcome = await runSingleRewriteStep(row, persona);
        if (outcome === 'none_available') {
          const next = transitionGenerateToNextPhase(
            accountId,
            persona.id,
            'No remaining >100w scraped posts to rewrite.'
          );
          if (next === 'publish') continue;
          break;
        }
        if (outcome === 'rewrote_all_done') {
          // Immediately transition into publish phase!
          continue;
        }
        // outcome === 'rewrote_more_left'
        const updatedRow = getPipelineRow(accountId)!;
        if (Number(updatedRow.generate_interval_hours ?? 0) === 0 || mode === 'trigger') {
          continue;
        }
        // Wait for configured per-article rewrite time via scheduler
        break;
      }

      if (phase === 'publish') {
        const pubDue =
          mode === 'trigger' ||
          !row.next_publish_at ||
          new Date(row.next_publish_at).getTime() <= nowMs;
        if (!pubDue) {
          break;
        }
        const outcome = await runSinglePublishStep(row, persona);
        if (outcome === 'none_available') {
          transitionPublishToScrape(accountId, 'Publish queue is empty.');
          const updatedRow = getPipelineRow(accountId)!;
          if (
            updatedRow.next_scrape_at &&
            new Date(updatedRow.next_scrape_at).getTime() <= Date.now() + 1000
          ) {
            // Avoid infinite immediate scrape loop if nothing yielded >100w sources
            break;
          }
          break;
        }
        if (outcome === 'published_all_done') {
          // Publish finished -> Scrape resumes on next due window (or next 15s tick if immediate)
          break;
        }
        // outcome === 'published_more_left'
        const updatedRow = getPipelineRow(accountId)!;
        if (Number(updatedRow.publish_interval_hours ?? 0) === 0) {
          continue;
        }
        // Wait for configured per-article publish time via scheduler
        break;
      }
    }

    const finalRow = getPipelineRow(accountId);
    if (finalRow && finalRow.status === 'running' && !abortedPipelineAccounts.has(accountId)) {
      db.prepare(`
        UPDATE pipelines SET
          current_stage = 'waiting',
          last_error = '',
          updated_at = ?
        WHERE account_id = ?
      `).run(new Date().toISOString(), accountId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Pipeline execution error';
    if (abortedPipelineAccounts.has(accountId) || /stopped by operator/i.test(msg)) {
      const current = getPipelineRow(accountId);
      const targetStatus: PipelineStatus = current?.status === 'paused' ? 'paused' : 'stopped';
      const targetStage: PipelineStage = targetStatus === 'paused' ? 'paused' : 'stopped';
      db.prepare(`
        UPDATE pipelines SET status = ?, current_stage = ?, updated_at = ? WHERE account_id = ?
      `).run(targetStatus, targetStage, new Date().toISOString(), accountId);
    } else {
      appendPipelineLog(accountId, 'Error', msg, 'error');
      db.prepare(`
        UPDATE pipelines SET status = 'error', current_stage = 'error', last_error = ?, updated_at = ? WHERE account_id = ?
      `).run(msg, new Date().toISOString(), accountId);
    }
  } finally {
    activePipelineRuns.delete(accountId);
  }
}

export async function startPipelineWorkflow(input: PipelineConfigInput): Promise<SanitizedPipeline> {
  const { account } = validateMasterAccount(input.accountId);
  savePipelineConfig(input);

  const row = getPipelineRow(input.accountId)!;
  abortedPipelineAccounts.delete(input.accountId);

  const now = new Date().toISOString();
  const hasFutureScrape =
    Boolean(row.next_scrape_at) && new Date(row.next_scrape_at!).getTime() > Date.now();
  const initialStage: PipelineStage = hasFutureScrape ? 'waiting' : 'scraping';

  db.prepare(`
    UPDATE pipelines SET
      status = 'running',
      current_stage = ?,
      cycle_phase = 'scrape',
      last_error = '',
      updated_at = ?
    WHERE account_id = ?
  `).run(initialStage, now, input.accountId);

  appendPipelineLog(
    input.accountId,
    'Started',
    `Master Pipeline started on ${account.label} (${
      row.headless ? 'headless' : 'headed'
    }): Scrape (${row.scrape_target_count} unique posts, cooldown ${
      row.scrape_interval_hours
    }h) -> Rewrite (1 article / ${row.generate_interval_hours}h until all scraped rewritten) -> Publish (1 article / ${
      row.publish_interval_hours
    }h until all published) -> Resume Scrape.`
  );

  void executePipelineRun(input.accountId, 'start');
  return serializePipeline(getPipelineRow(input.accountId)!);
}

export async function pausePipelineWorkflow(accountId: string): Promise<SanitizedPipeline> {
  const existing = getPipelineRow(accountId);
  if (!existing) {
    throw new Error('No pipeline configured for this account.');
  }

  abortedPipelineAccounts.add(accountId);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pipelines SET status = 'paused', current_stage = 'paused', updated_at = ? WHERE account_id = ?
  `).run(now, accountId);

  appendPipelineLog(
    accountId,
    'Paused',
    `Pipeline paused during ${existing.cycle_phase} phase. Cycle position and timers preserved until Resume Pipeline is clicked.`
  );

  await killAccountBrowser(accountId).catch(() => {});
  return serializePipeline(getPipelineRow(accountId)!);
}

export async function killPipelineWorkflow(accountId: string): Promise<SanitizedPipeline> {
  const existing = getPipelineRow(accountId);
  if (!existing) {
    throw new Error('No pipeline configured for this account.');
  }

  abortedPipelineAccounts.add(accountId);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pipelines SET status = 'stopped', current_stage = 'stopped', updated_at = ? WHERE account_id = ?
  `).run(now, accountId);

  appendPipelineLog(
    accountId,
    'Stopped',
    'Pipeline workflow stopped by operator and active browser closed.',
    'error'
  );

  await killAccountBrowser(accountId).catch(() => {});
  return serializePipeline(getPipelineRow(accountId)!);
}

export async function resumePipelineWorkflow(accountId: string): Promise<SanitizedPipeline> {
  const { account } = validateMasterAccount(accountId);
  const existing = getPipelineRow(accountId);
  if (!existing) {
    throw new Error('Configure and start the pipeline for this account first.');
  }

  abortedPipelineAccounts.delete(accountId);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pipelines SET status = 'running', current_stage = 'waiting', last_error = '', updated_at = ? WHERE account_id = ?
  `).run(now, accountId);

  appendPipelineLog(
    accountId,
    'Resumed',
    `Master Pipeline resumed on ${account.label} at ${existing.cycle_phase} phase.`
  );

  void executePipelineRun(accountId, 'resume');
  return serializePipeline(getPipelineRow(accountId)!);
}

export function triggerPipelineCycleNow(accountId: string): SanitizedPipeline {
  validateMasterAccount(accountId);
  const existing = getPipelineRow(accountId);
  if (!existing) {
    throw new Error('No pipeline configured for this account.');
  }
  if (existing.status !== 'running') {
    throw new Error('Start or resume the pipeline before triggering an immediate run.');
  }
  appendPipelineLog(
    accountId,
    'Manual Step',
    `Operator triggered immediate execution in active "${existing.cycle_phase}" phase.`
  );
  void executePipelineRun(accountId, 'trigger');
  return serializePipeline(getPipelineRow(accountId)!);
}

export function startPipelineScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Recover any stale active stages on process startup
  try {
    db.prepare(`
      UPDATE pipelines
      SET current_stage = 'waiting'
      WHERE status = 'running' AND current_stage IN ('scraping', 'generating', 'publishing')
    `).run();
  } catch {
    // ignore startup recovery errors
  }

  setInterval(() => {
    try {
      const nowIso = new Date().toISOString();
      const runningPipelines = db
        .prepare(`SELECT * FROM pipelines WHERE status = 'running'`)
        .all() as unknown as PipelineRow[];

      for (const p of runningPipelines) {
        if (activePipelineRuns.has(p.account_id) || abortedPipelineAccounts.has(p.account_id)) {
          continue;
        }
        const phase: CyclePhase =
          p.cycle_phase === 'generate' || p.cycle_phase === 'publish' ? p.cycle_phase : 'scrape';
        const isDue =
          (phase === 'scrape' && (!p.next_scrape_at || p.next_scrape_at <= nowIso)) ||
          (phase === 'generate' && (!p.next_generate_at || p.next_generate_at <= nowIso)) ||
          (phase === 'publish' && (!p.next_publish_at || p.next_publish_at <= nowIso));

        if (isDue) {
          void executePipelineRun(p.account_id, 'scheduled');
        }
      }
    } catch {
      // ignore tick errors
    }
  }, 15000);
}
