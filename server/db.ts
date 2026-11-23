import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computePostContentHash, type ParsedSquarePost } from './squareParser.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const SCRAPED_POSTS_DIR = path.resolve(DATA_DIR, 'scraped_posts');
export const PERSONA_RULES_DIR = path.resolve(DATA_DIR, 'persona_rules');
const DB_PATH = path.join(DATA_DIR, 'squaredesk.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}
if (!fs.existsSync(SCRAPED_POSTS_DIR)) {
  fs.mkdirSync(SCRAPED_POSTS_DIR, { recursive: true });
}
if (!fs.existsSync(PERSONA_RULES_DIR)) {
  fs.mkdirSync(PERSONA_RULES_DIR, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('scraper', 'publisher')),
    label TEXT NOT NULL,
    login_identifier TEXT NOT NULL DEFAULT '',
    login_password_enc TEXT NOT NULL DEFAULT '',
    binance_square_api_key_ref TEXT NOT NULL DEFAULT '',
    binance_square_api_key_enc TEXT NOT NULL DEFAULT '',
    binance_square_api_key_masked TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'needs_auth', 'challenge_required')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    account_id TEXT UNIQUE REFERENCES accounts(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '[]',
    tone TEXT NOT NULL DEFAULT '',
    style_examples TEXT NOT NULL DEFAULT '[]',
    posting_frequency TEXT NOT NULL DEFAULT '3/day',
    active_hours TEXT NOT NULL DEFAULT '["08:00","13:00","20:00"]',
    banned_topics TEXT NOT NULL DEFAULT '["price predictions","financial advice"]',
    writing_rules TEXT NOT NULL DEFAULT '',
    writing_rules_file TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS browser_profiles (
    id TEXT PRIMARY KEY,
    account_id TEXT UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    dechromium_profile_id TEXT NOT NULL,
    proxy_url_enc TEXT NOT NULL DEFAULT '',
    proxy_display TEXT NOT NULL DEFAULT '',
    proxy_country TEXT NOT NULL DEFAULT '',
    proxy_timezone TEXT NOT NULL DEFAULT '',
    proxy_locale TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport_width INTEGER NOT NULL DEFAULT 1366,
    viewport_height INTEGER NOT NULL DEFAULT 860,
    cookies_json TEXT NOT NULL DEFAULT '[]',
    storage_state_json TEXT NOT NULL DEFAULT '{}',
    last_launched_at TEXT,
    last_health_check TEXT,
    health_status TEXT NOT NULL DEFAULT 'unconfigured' CHECK(health_status IN ('healthy', 'expired', 'challenge', 'unconfigured', 'error')),
    session_valid_until TEXT
  );

  CREATE TABLE IF NOT EXISTS source_posts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL DEFAULT 'playwright',
    feed_tab TEXT NOT NULL DEFAULT 'discover',
    external_id TEXT UNIQUE NOT NULL,
    author TEXT NOT NULL,
    author_handle TEXT NOT NULL DEFAULT '',
    author_avatar TEXT NOT NULL DEFAULT '',
    post_url TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    cashtags TEXT NOT NULL DEFAULT '[]',
    hashtags TEXT NOT NULL DEFAULT '[]',
    media_urls TEXT NOT NULL DEFAULT '[]',
    engagement_metrics TEXT NOT NULL DEFAULT '{}',
    collected_at TEXT NOT NULL,
    used_by_persona_ids TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL DEFAULT '',
    comments_json TEXT NOT NULL DEFAULT '[]',
    bundle_file_path TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY CHECK(id IN ('gemini', 'groq', 'openrouter', 'amadd')),
    provider_name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key_enc TEXT NOT NULL DEFAULT '',
    key_masked TEXT NOT NULL DEFAULT '',
    available_models TEXT NOT NULL DEFAULT '[]',
    selected_model TEXT NOT NULL DEFAULT '',
    validated INTEGER NOT NULL DEFAULT 0,
    last_validated_at TEXT,
    validation_error TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    source_post_ids TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    media_paths TEXT NOT NULL DEFAULT '[]',
    post_format TEXT NOT NULL DEFAULT 'short_post' CHECK(post_format IN ('short_post', 'long_article')),
    status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('draft', 'pending_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'rejected')),
    llm_provider TEXT NOT NULL DEFAULT '',
    llm_model TEXT NOT NULL DEFAULT '',
    uniqueness_notes TEXT NOT NULL DEFAULT '',
    scheduled_for TEXT,
    generated_at TEXT NOT NULL,
    reviewed_at TEXT,
    published_at TEXT,
    binance_post_id TEXT
  );

  CREATE TABLE IF NOT EXISTS publish_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'playwright_ui',
    http_status INTEGER NOT NULL DEFAULT 200,
    response_body TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS automation_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL CHECK(job_type IN ('scrape', 'publish', 'auth_check')),
    account_id TEXT NOT NULL,
    draft_id TEXT,
    feed_tab TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'awaiting_mfa', 'awaiting_captcha', 'completed', 'failed')),
    current_step TEXT NOT NULL DEFAULT '',
    logs TEXT NOT NULL DEFAULT '[]',
    challenge_screenshot TEXT,
    challenge_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standalone_generations (
    id TEXT PRIMARY KEY,
    source_post_ids TEXT NOT NULL DEFAULT '[]',
    custom_input TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    llm_provider TEXT NOT NULL,
    llm_model TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    error_message TEXT NOT NULL DEFAULT '',
    logs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    account_id TEXT UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'paused', 'stopped', 'error')),
    current_stage TEXT NOT NULL DEFAULT 'idle',
    cycle_phase TEXT NOT NULL DEFAULT 'scrape' CHECK(cycle_phase IN ('scrape', 'generate', 'publish')),
    headless INTEGER NOT NULL DEFAULT 1,
    feed_tab TEXT NOT NULL DEFAULT 'discover',
    scrape_target_count INTEGER NOT NULL DEFAULT 20,
    scrape_interval_hours REAL NOT NULL DEFAULT 5,
    generate_per_cycle INTEGER NOT NULL DEFAULT 2,
    generate_interval_hours REAL NOT NULL DEFAULT 2,
    min_source_words INTEGER NOT NULL DEFAULT 100,
    target_min_words INTEGER NOT NULL DEFAULT 870,
    target_max_words INTEGER NOT NULL DEFAULT 1340,
    provider_id TEXT NOT NULL DEFAULT 'gemini',
    model TEXT NOT NULL DEFAULT '',
    publish_interval_hours REAL NOT NULL DEFAULT 1,
    total_scraped INTEGER NOT NULL DEFAULT 0,
    total_generated INTEGER NOT NULL DEFAULT 0,
    total_published INTEGER NOT NULL DEFAULT 0,
    last_scrape_at TEXT,
    next_scrape_at TEXT,
    last_generate_at TEXT,
    next_generate_at TEXT,
    last_publish_at TEXT,
    next_publish_at TEXT,
    last_error TEXT NOT NULL DEFAULT '',
    logs TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );

  UPDATE browser_profiles
  SET proxy_country = '', proxy_timezone = '', proxy_locale = ''
  WHERE proxy_url_enc = '';
`);

// Safe migrations for accounts Creator OpenAPI key columns
const accountCols = db.prepare(`PRAGMA table_info(accounts)`).all() as Array<{ name: string }>;
if (!accountCols.some((c) => c.name === 'binance_square_api_key_enc')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN binance_square_api_key_enc TEXT NOT NULL DEFAULT ''`);
}
if (!accountCols.some((c) => c.name === 'binance_square_api_key_masked')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN binance_square_api_key_masked TEXT NOT NULL DEFAULT ''`);
}

// Safe migrations for source_posts columns + index
const sourcePostCols = db.prepare(`PRAGMA table_info(source_posts)`).all() as Array<{ name: string }>;
if (!sourcePostCols.some((c) => c.name === 'content_hash')) {
  db.exec(`ALTER TABLE source_posts ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`);
}
if (!sourcePostCols.some((c) => c.name === 'comments_json')) {
  db.exec(`ALTER TABLE source_posts ADD COLUMN comments_json TEXT NOT NULL DEFAULT '[]'`);
}
if (!sourcePostCols.some((c) => c.name === 'bundle_file_path')) {
  db.exec(`ALTER TABLE source_posts ADD COLUMN bundle_file_path TEXT NOT NULL DEFAULT ''`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_source_posts_content_hash ON source_posts(content_hash)`);

// Safe migrations for standalone_generations execution log columns
const standaloneCols = db
  .prepare(`PRAGMA table_info(standalone_generations)`)
  .all() as Array<{ name: string }>;
if (!standaloneCols.some((c) => c.name === 'status')) {
  db.exec(`ALTER TABLE standalone_generations ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'`);
}
if (!standaloneCols.some((c) => c.name === 'error_message')) {
  db.exec(`ALTER TABLE standalone_generations ADD COLUMN error_message TEXT NOT NULL DEFAULT ''`);
}
if (!standaloneCols.some((c) => c.name === 'logs')) {
  db.exec(`ALTER TABLE standalone_generations ADD COLUMN logs TEXT NOT NULL DEFAULT '[]'`);
}

// Safe migrations for independent pipeline rewrite schedule columns
const pipelineCols = db.prepare(`PRAGMA table_info(pipelines)`).all() as Array<{ name: string }>;
if (!pipelineCols.some((c) => c.name === 'generate_interval_hours')) {
  db.exec(`ALTER TABLE pipelines ADD COLUMN generate_interval_hours REAL NOT NULL DEFAULT 2`);
}
if (!pipelineCols.some((c) => c.name === 'next_generate_at')) {
  db.exec(`ALTER TABLE pipelines ADD COLUMN next_generate_at TEXT`);
}

// Upgrade existing pipelines table CHECK constraint to allow 'paused' status cleanly
const pipelineSchemaRow = db
  .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pipelines'`)
  .get() as { sql?: string } | undefined;
if (pipelineSchemaRow?.sql && !pipelineSchemaRow.sql.includes("'paused'")) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE pipelines_v2 (
      id TEXT PRIMARY KEY,
      account_id TEXT UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'paused', 'stopped', 'error')),
      current_stage TEXT NOT NULL DEFAULT 'idle',
      feed_tab TEXT NOT NULL DEFAULT 'discover',
      scrape_target_count INTEGER NOT NULL DEFAULT 20,
      scrape_interval_hours REAL NOT NULL DEFAULT 5,
      generate_per_cycle INTEGER NOT NULL DEFAULT 2,
      generate_interval_hours REAL NOT NULL DEFAULT 2,
      min_source_words INTEGER NOT NULL DEFAULT 100,
      target_min_words INTEGER NOT NULL DEFAULT 870,
      target_max_words INTEGER NOT NULL DEFAULT 1340,
      provider_id TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT '',
      publish_interval_hours REAL NOT NULL DEFAULT 1,
      total_scraped INTEGER NOT NULL DEFAULT 0,
      total_generated INTEGER NOT NULL DEFAULT 0,
      total_published INTEGER NOT NULL DEFAULT 0,
      last_scrape_at TEXT,
      next_scrape_at TEXT,
      last_generate_at TEXT,
      next_generate_at TEXT,
      last_publish_at TEXT,
      next_publish_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      logs TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    INSERT INTO pipelines_v2 (
      id, account_id, status, current_stage, feed_tab,
      scrape_target_count, scrape_interval_hours, generate_per_cycle, generate_interval_hours,
      min_source_words, target_min_words, target_max_words,
      provider_id, model, publish_interval_hours,
      total_scraped, total_generated, total_published,
      last_scrape_at, next_scrape_at, last_generate_at, next_generate_at,
      last_publish_at, next_publish_at, last_error, logs, updated_at
    )
    SELECT
      id, account_id, status, current_stage, feed_tab,
      scrape_target_count, scrape_interval_hours, generate_per_cycle, COALESCE(generate_interval_hours, 2),
      min_source_words, target_min_words, target_max_words,
      provider_id, model, publish_interval_hours,
      total_scraped, total_generated, total_published,
      last_scrape_at, next_scrape_at, last_generate_at, next_generate_at,
      last_publish_at, next_publish_at, last_error, logs, updated_at
    FROM pipelines;
    DROP TABLE pipelines;
    ALTER TABLE pipelines_v2 RENAME TO pipelines;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// Safe migrations for cycle_phase & headless columns on pipelines
const pipelineColsAfter = db.prepare(`PRAGMA table_info(pipelines)`).all() as Array<{ name: string }>;
if (!pipelineColsAfter.some((c) => c.name === 'cycle_phase')) {
  db.exec(`ALTER TABLE pipelines ADD COLUMN cycle_phase TEXT NOT NULL DEFAULT 'scrape'`);
}
if (!pipelineColsAfter.some((c) => c.name === 'headless')) {
  db.exec(`ALTER TABLE pipelines ADD COLUMN headless INTEGER NOT NULL DEFAULT 1`);
}

// Safe migrations for persona writing_rules & writing_rules_file
const personaCols = db.prepare(`PRAGMA table_info(personas)`).all() as Array<{ name: string }>;
if (!personaCols.some((c) => c.name === 'writing_rules')) {
  db.exec(`ALTER TABLE personas ADD COLUMN writing_rules TEXT NOT NULL DEFAULT ''`);
}
if (!personaCols.some((c) => c.name === 'writing_rules_file')) {
  db.exec(`ALTER TABLE personas ADD COLUMN writing_rules_file TEXT NOT NULL DEFAULT ''`);
}

// Backfill content_hash for any existing rows
const missingHashRows = db
  .prepare(`SELECT id, content FROM source_posts WHERE content_hash = '' OR content_hash IS NULL`)
  .all() as Array<{ id: string; content: string }>;
if (missingHashRows.length > 0) {
  const updateHash = db.prepare(`UPDATE source_posts SET content_hash = ? WHERE id = ?`);
  for (const row of missingHashRows) {
    updateHash.run(computePostContentHash(row.content), row.id);
  }
}

export function resolveSafeScrapedBundlePath(postId: string): string | null {
  const safeId = (postId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId) return null;
  const resolved = path.resolve(SCRAPED_POSTS_DIR, `${safeId}.json`);
  if (!resolved.startsWith(SCRAPED_POSTS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

export function resolveSafePersonaRulesPath(personaId: string): string | null {
  const safeId = (personaId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId) return null;
  const resolved = path.resolve(PERSONA_RULES_DIR, `${safeId}.md`);
  if (!resolved.startsWith(PERSONA_RULES_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

export function getRelativePersonaRulesPath(personaId: string): string {
  const safePath = resolveSafePersonaRulesPath(personaId);
  if (!safePath) return '';
  return `data/persona_rules/${path.basename(safePath)}`;
}

export function writePersonaWritingRules(personaId: string, rulesText: string): string {
  const safePath = resolveSafePersonaRulesPath(personaId);
  if (!safePath) return '';
  const normalized = (rulesText || '').replace(/\r\n/g, '\n');
  fs.writeFileSync(safePath, normalized, 'utf8');
  const relPath = getRelativePersonaRulesPath(personaId);
  db.prepare(`UPDATE personas SET writing_rules = ?, writing_rules_file = ? WHERE id = ?`).run(
    normalized,
    relPath,
    personaId
  );
  return relPath;
}

export function readPersonaWritingRules(personaId: string): {
  rules: string;
  filePath: string;
} {
  const safePath = resolveSafePersonaRulesPath(personaId);
  const relPath = getRelativePersonaRulesPath(personaId);
  if (safePath && fs.existsSync(safePath)) {
    const fileContent = fs.readFileSync(safePath, 'utf8');
    return { rules: fileContent, filePath: relPath };
  }
  const row = db
    .prepare(`SELECT writing_rules, writing_rules_file FROM personas WHERE id = ?`)
    .get(personaId) as { writing_rules?: string; writing_rules_file?: string } | undefined;
  return {
    rules: row?.writing_rules || '',
    filePath: row?.writing_rules_file || relPath,
  };
}

export function getRelativeScrapedBundlePath(postId: string): string {
  const safePath = resolveSafeScrapedBundlePath(postId);
  if (!safePath) return '';
  return `data/scraped_posts/${path.basename(safePath)}`;
}

export function writePostWithCommentsFile(
  post: ParsedSquarePost,
  meta: { sourceType: string; feedTab: string; collectedAt: string }
): string {
  const safePath = resolveSafeScrapedBundlePath(post.id);
  if (!safePath) return '';
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const payload = {
    id: post.id,
    external_id: post.external_id,
    source_type: meta.sourceType,
    feed_tab: meta.feedTab,
    post_url: post.post_url,
    author: post.author,
    author_handle: post.author_handle,
    author_avatar: post.author_avatar,
    collected_at: meta.collectedAt,
    content: post.content,
    cashtags: post.cashtags,
    hashtags: post.hashtags,
    media_urls: post.media_urls,
    engagement_metrics: post.engagement_metrics,
    comments_count: comments.length,
    comments,
  };
  fs.writeFileSync(safePath, JSON.stringify(payload, null, 2), 'utf8');
  return `data/scraped_posts/${path.basename(safePath)}`;
}

export function deletePostBundleFile(postId: string): void {
  const safePath = resolveSafeScrapedBundlePath(postId);
  if (safePath && fs.existsSync(safePath)) {
    fs.unlinkSync(safePath);
  }
}

export function loadExistingSourceSignatures(): {
  existingIds: Set<string>;
  existingHashes: Set<string>;
} {
  const rows = db
    .prepare(`SELECT id, external_id, content, content_hash FROM source_posts`)
    .all() as Array<{ id: string; external_id: string; content: string; content_hash: string }>;

  const existingIds = new Set<string>();
  const existingHashes = new Set<string>();
  for (const r of rows) {
    if (r.id) existingIds.add(r.id);
    if (r.external_id) existingIds.add(r.external_id);
    const hash = r.content_hash || computePostContentHash(r.content);
    if (hash) existingHashes.add(hash);
  }
  return { existingIds, existingHashes };
}

export function insertUniqueSourcePosts(
  posts: ParsedSquarePost[],
  options: {
    sourceType: 'playwright' | 'dom_import';
    feedTab: string;
    collectedAt?: string;
    existingIds?: Set<string>;
    existingHashes?: Set<string>;
  }
): {
  insertedCount: number;
  skippedCount: number;
  insertedIds: string[];
} {
  const { existingIds, existingHashes } =
    options.existingIds && options.existingHashes
      ? { existingIds: options.existingIds, existingHashes: options.existingHashes }
      : loadExistingSourceSignatures();

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO source_posts (
      id, source_type, feed_tab, external_id, author, author_handle, author_avatar,
      post_url, content, cashtags, hashtags, media_urls, engagement_metrics, collected_at, used_by_persona_ids, content_hash,
      comments_json, bundle_file_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
  `);

  const collectedAt = options.collectedAt || new Date().toISOString();
  let insertedCount = 0;
  let skippedCount = 0;
  const insertedIds: string[] = [];

  for (const p of posts) {
    const hash = computePostContentHash(p.content);
    if (existingIds.has(p.id) || existingIds.has(p.external_id) || existingHashes.has(hash)) {
      skippedCount++;
      continue;
    }

    const comments = Array.isArray(p.comments) ? p.comments : [];
    const relativeBundlePath = getRelativeScrapedBundlePath(p.id);

    const result = insertStmt.run(
      p.id,
      options.sourceType,
      options.feedTab,
      p.external_id,
      p.author,
      p.author_handle,
      p.author_avatar,
      p.post_url,
      p.content,
      JSON.stringify(p.cashtags),
      JSON.stringify(p.hashtags),
      JSON.stringify(p.media_urls),
      JSON.stringify(p.engagement_metrics),
      collectedAt,
      hash,
      JSON.stringify(comments),
      relativeBundlePath
    );

    if (result.changes > 0) {
      writePostWithCommentsFile(
        { ...p, comments },
        { sourceType: options.sourceType, feedTab: options.feedTab, collectedAt }
      );
      existingIds.add(p.id);
      existingIds.add(p.external_id);
      existingHashes.add(hash);
      insertedCount++;
      insertedIds.push(p.id);
    } else {
      skippedCount++;
    }
  }

  return { insertedCount, skippedCount, insertedIds };
}

function seedInitialData() {
  const now = new Date().toISOString();

  // Seed 4 AI providers (Gemini pre-populated with curated models; ready to validate or use env GEMINI_API_KEY)
  const providerCount = db.prepare('SELECT COUNT(*) as c FROM ai_providers').get() as { c: number };
  if (providerCount.c === 0) {
    const hasEnvGemini = Boolean(process.env.GEMINI_API_KEY);
    const insertProvider = db.prepare(`
      INSERT INTO ai_providers (id, provider_name, base_url, api_key_enc, key_masked, available_models, selected_model, validated, last_validated_at, validation_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProvider.run(
      'gemini',
      'Google Gemini',
      'https://generativelanguage.googleapis.com/v1beta',
      '',
      hasEnvGemini ? 'ENV••••INJECTED' : '',
      JSON.stringify([
        'gemini-4-hydrogen',
        'gemini-4-neon',
        'gemini-4-carbon',
        'gemini-4-argon',
        'gemini-3.1-flash-lite',
      ]),
      'gemini-4-hydrogen',
      hasEnvGemini ? 1 : 0,
      hasEnvGemini ? now : null,
      ''
    );

    insertProvider.run(
      'groq',
      'Groq Cloud',
      'https://api.groq.com/openai/v1',
      '',
      '',
      JSON.stringify([
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'mixtral-8x7b-32768',
        'deepseek-r1-distill-llama-70b',
        'qwen-qwq-32b',
      ]),
      'llama-3.3-70b-versatile',
      0,
      null,
      ''
    );

    insertProvider.run(
      'openrouter',
      'OpenRouter',
      'https://openrouter.ai/api/v1',
      '',
      '',
      JSON.stringify([
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'meta-llama/llama-3.3-70b-instruct',
        'deepseek/deepseek-r1',
        'google/gemini-2.5-flash',
      ]),
      'anthropic/claude-3.5-sonnet',
      0,
      null,
      ''
    );

    insertProvider.run(
      'amadd',
      'api.amadd',
      'https://api.amadd.io/v1',
      '',
      '',
      JSON.stringify([
        'gpt-4o',
        'gpt-4o-mini',
        'claude-3-5-sonnet-20241022',
        'deepseek-chat',
        'deepseek-reasoner',
      ]),
      'gpt-4o',
      0,
      null,
      ''
    );
  }

  // Seed Accounts, Browser Profiles, Personas
  const accountCount = db.prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number };
  if (accountCount.c === 0) {
    const insertAccount = db.prepare(`
      INSERT INTO accounts (id, role, label, login_identifier, login_password_enc, binance_square_api_key_ref, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertProfile = db.prepare(`
      INSERT INTO browser_profiles (id, account_id, dechromium_profile_id, proxy_url_enc, proxy_display, proxy_country, proxy_timezone, proxy_locale, user_agent, viewport_width, viewport_height, cookies_json, health_status, last_health_check)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPersona = db.prepare(`
      INSERT INTO personas (id, account_id, display_name, bio, niche, tone, style_examples, posting_frequency, active_hours, banned_topics, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 1. Dedicated Independent Scraper Account (NEVER publishes!)
    insertAccount.run(
      'acc_scraper_01',
      'scraper',
      'Scraper Node 01 (Read-Only)',
      '',
      '',
      'none://scraper-only',
      'needs_auth',
      now
    );
    insertProfile.run(
      'prof_scraper_01',
      'acc_scraper_01',
      path.join(PROFILES_DIR, 'prof_scraper_01'),
      '',
      '',
      '',
      '',
      '',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      1440,
      900,
      '[]',
      'unconfigured',
      null
    );

    // 2. Publisher Account 1 <-> The DeFi Desk
    insertAccount.run(
      'acc_pub_01',
      'publisher',
      'Publisher 01 — DeFi Desk',
      '',
      '',
      'vault://binance/key_01',
      'needs_auth',
      now
    );
    insertProfile.run(
      'prof_pub_01',
      'acc_pub_01',
      path.join(PROFILES_DIR, 'prof_pub_01'),
      '',
      '',
      '',
      '',
      '',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      1366,
      860,
      '[]',
      'unconfigured',
      null
    );
    insertPersona.run(
      'defi_analyst_01',
      'acc_pub_01',
      'The DeFi Desk',
      'Tracking protocol revenue, real yield mechanics, and Ethereum L2 liquidity migrations without hype.',
      JSON.stringify(['DeFi', 'Yield Mechanics', 'Layer 2s', 'Protocol TVL']),
      'analytical, calm, data-driven, structured with bullet takeaways',
      JSON.stringify([
        'Stablecoin velocity on Arbitrum and Base outpaced fee compression this week. Watch net inflows rather than headline APYs when assessing sustainable protocol revenue.',
        'Restaking yields are normalizing as AVS emissions taper. The real signal now is slashable stake concentration across top operators.',
        'L2 blob fees remained below 0.01 gwei for 14 consecutive days, turning rollup sequencers into net margin engines.'
      ]),
      '3/day',
      JSON.stringify(['08:00', '13:00', '20:00']),
      JSON.stringify(['price predictions', 'financial advice', 'guaranteed returns']),
      now
    );

    // 3. Publisher Account 2 <-> Macro Tape
    insertAccount.run(
      'acc_pub_02',
      'publisher',
      'Publisher 02 — Macro Tape',
      '',
      '',
      'vault://binance/key_02',
      'needs_auth',
      now
    );
    insertProfile.run(
      'prof_pub_02',
      'acc_pub_02',
      path.join(PROFILES_DIR, 'prof_pub_02'),
      '',
      '',
      '',
      '',
      '',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      1536,
      960,
      '[]',
      'unconfigured',
      null
    );
    insertPersona.run(
      'macro_tape_02',
      'acc_pub_02',
      'Macro Tape',
      'Connecting central bank liquidity, Treasury yields, DXY flows, and institutional crypto ETF demand.',
      JSON.stringify(['Macro', 'ETF Flows', 'Liquidity', 'Market Structure']),
      'concise, institutional desk note style, crisp observations',
      JSON.stringify([
        'Spot BTC ETF net creations absorbed 3x daily miner issuance over the past four sessions while US 10Y real yields cooled 9 bps.',
        'Funding rates across perpetual venues remain muted despite spot expansion — a cleaner positioning setup than March.',
        'Dollar liquidity impulse continues to lead risk assets by roughly 10 weeks; watch TGA drawdown schedules into month-end.'
      ]),
      '2/day',
      JSON.stringify(['10:30', '17:30']),
      JSON.stringify(['price predictions', 'financial advice', 'meme shills']),
      now
    );

    // 4. Publisher Account 3 <-> Builders & Research
    insertAccount.run(
      'acc_pub_03',
      'publisher',
      'Publisher 03 — Builders & Research',
      '',
      '',
      'vault://binance/key_03',
      'needs_auth',
      now
    );
    insertProfile.run(
      'prof_pub_03',
      'acc_pub_03',
      path.join(PROFILES_DIR, 'prof_pub_03'),
      '',
      '',
      '',
      '',
      '',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      1280,
      800,
      '[]',
      'unconfigured',
      null
    );
    insertPersona.run(
      'builders_pulse_03',
      'acc_pub_03',
      'On-Chain Pulse',
      'Breaking down new listings, ecosystem developer tooling, security architecture, and Binance Academy primers.',
      JSON.stringify(['Ecosystem', 'Security', 'Listings', 'Education']),
      'educational, accessible, builder-focused, clear analogies',
      JSON.stringify([
        'Before interacting with any new cross-chain bridge, verify whether message validation relies on optimistic fraud windows or ZK light clients.',
        'Account abstraction adoption is quietly accelerating through passkey-backed smart wallets, removing seed phrase friction for new cohorts.'
      ]),
      '2/day',
      JSON.stringify(['11:45', '21:15']),
      JSON.stringify(['price predictions', 'financial advice', 'leverage calls']),
      now
    );
  }

  // Seed Source Posts (including the exact post 389531667063617 from user DOM snippet)
  const postCount = db.prepare('SELECT COUNT(*) as c FROM source_posts').get() as { c: number };
  if (postCount.c === 0) {
    const insertPost = db.prepare(`
      INSERT INTO source_posts (id, source_type, feed_tab, external_id, author, author_handle, author_avatar, post_url, content, cashtags, hashtags, media_urls, engagement_metrics, collected_at, used_by_persona_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertPost.run(
      '389531667063617',
      'dom_import',
      'news',
      '389531667063617',
      'Binance Square Official',
      '@binance_square_official',
      'https://public.bnbstatic.com/image/pgc/202310/4f74b69ed53c1d3c0f3d6d30f54155bb.png',
      'https://www.binance.com/en/square/post/389531667063617',
      'The Binance Trading Master Tournament, where traders go head-to-head live in Bangkok at #BinanceBlockchainWeek\n\n$170K total prize pool, with $100K going to the champion 🏆\n\n📍 Binance Square\n🗓️ Nov 28 · 6 AM (UTC)\n\nSet your reminder: https://www.binance.com/en/square/audio?id=48680649615354',
      JSON.stringify([]),
      JSON.stringify(['#BinanceBlockchainWeek']),
      JSON.stringify([
        'https://public.bnbstatic.com/image/pgc/20261118/3e161cd33d2c402393ab9342bb404337.jpg',
        'https://public.bnbstatic.com/video/pgc/ArticleContent/12511158-0460-4bf6-afd3-de6f8153afc5.mp4'
      ]),
      JSON.stringify({ comments: '98', quotes: '23', likes: '437', views: '1.4M', timestamp_label: '15h' }),
      now,
      JSON.stringify(['builders_pulse_03'])
    );

    insertPost.run(
      '389540112948210',
      'playwright',
      'discover',
      '389540112948210',
      'DeFiLlama Research',
      '@defillama_research',
      '',
      'https://www.binance.com/en/square/post/389540112948210',
      'Decentralized perpetual exchanges recorded $48.2B in 7-day cumulative volume across Arbitrum, Solana, and Hyperliquid. Protocol fee capture hit a 90-day high as liquidity migrated away from high-gas execution layers toward low-latency appchains and L2 orderbooks. $ETH $SOL $ARB',
      JSON.stringify(['$ETH', '$SOL', '$ARB']),
      JSON.stringify(['#DeFi', '#Perps', '#Layer2']),
      JSON.stringify([]),
      JSON.stringify({ comments: '64', quotes: '19', likes: '512', views: '284K', timestamp_label: '4h' }),
      now,
      JSON.stringify(['defi_analyst_01'])
    );

    insertPost.run(
      '389542881039402',
      'playwright',
      'following',
      '389542881039402',
      'Macro Liquidity Monitor',
      '@macro_liquidity',
      '',
      'https://www.binance.com/en/square/post/389542881039402',
      'US spot Bitcoin ETFs logged $614M in net daily inflows across 9 funds, led by IBIT and FBTC, while CME open interest expanded by 4.8% week-over-week. Institutional basis spreads remain anchored near 9.4% annualized, signaling steady carry demand without retail leverage overheating. $BTC',
      JSON.stringify(['$BTC']),
      JSON.stringify(['#Bitcoin', '#ETF', '#Macro']),
      JSON.stringify([]),
      JSON.stringify({ comments: '112', quotes: '41', likes: '890', views: '620K', timestamp_label: '2h' }),
      now,
      JSON.stringify(['macro_tape_02'])
    );

    insertPost.run(
      '389545901220018',
      'playwright',
      'academy',
      '389545901220018',
      'Binance Academy',
      '@binance_academy',
      '',
      'https://www.binance.com/en/square/post/389545901220018',
      'Understanding Impermanent Loss vs. Concentrated Liquidity Range Risk: In automated market makers like Uniswap v3, narrowing your tick range boosts capital efficiency and fee capture—but accelerates inventory divergence when spot moves outside bounds. Always model fee APR against rebalancing cost before deploying LP capital. #DeFi #Liquidity',
      JSON.stringify([]),
      JSON.stringify(['#DeFi', '#Liquidity']),
      JSON.stringify([]),
      JSON.stringify({ comments: '37', quotes: '15', likes: '310', views: '145K', timestamp_label: '6h' }),
      now,
      JSON.stringify([])
    );
  }

  // Seed initial drafts for Human Review Dashboard
  const draftCount = db.prepare('SELECT COUNT(*) as c FROM drafts').get() as { c: number };
  if (draftCount.c === 0) {
    const insertDraft = db.prepare(`
      INSERT INTO drafts (id, persona_id, source_post_ids, title, content, media_paths, post_format, status, llm_provider, llm_model, uniqueness_notes, scheduled_for, generated_at, reviewed_at, published_at, binance_post_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertDraft.run(
      'ART-20261118-D101',
      'defi_analyst_01',
      JSON.stringify(['389540112948210']),
      'On-Chain Perp Execution Shifts Toward Appchains & L2 Orderbooks',
      'Orderflow on decentralized perpetual venues is quietly restructuring around execution latency rather than token incentives.\n\nKey metrics from the past 7 days:\n- $48.2B cumulative perp volume cleared across $ARB, $SOL, and appchain orderbooks\n- Protocol fee capture reached a 90-day peak despite compressed gas overhead\n- Liquidity depth is consolidating on low-latency venues where market makers can re-quote without block-time friction\n\nWatch net fee retention over raw incentives as the primary signal for sustainable DeFi revenue. #DeFi #Layer2',
      JSON.stringify([]),
      'short_post',
      'pending_review',
      'gemini',
      'gemini-4-hydrogen',
      'Original angle focused on market-maker latency & fee retention; zero verbatim phrasing from source.',
      new Date(Date.now() + 3600 * 1000).toISOString(),
      now,
      null,
      null,
      null
    );

    insertDraft.run(
      'ART-20261118-M204',
      'macro_tape_02',
      JSON.stringify(['389542881039402']),
      'Institutional Basis & ETF Creations Signal Disciplined $BTC Demand',
      'Spot $BTC allocation continues to absorb supply through regulated wrappers rather than high-beta retail leverage.\n\nDesk notes:\n1. $614M in single-day net ETF creations across 9 US issuers\n2. CME open interest climbed +4.8% WoW\n3. Annualized futures basis sits near 9.4% — healthy cash-and-carry appetite without frothy perp funding\n\nWhen spot inflows lead derivatives positioning, structural trends tend to endure longer than leverage-driven spikes. #Bitcoin #Macro',
      JSON.stringify([]),
      'short_post',
      'approved',
      'gemini',
      'gemini-4-hydrogen',
      'Reframed into institutional desk note structure; preserves $614M, +4.8% CME OI, and 9.4% basis facts.',
      new Date(Date.now() + 7200 * 1000).toISOString(),
      now,
      now,
      null,
      null
    );

    insertDraft.run(
      'ART-20261118-B309',
      'builders_pulse_03',
      JSON.stringify(['389531667063617']),
      'Live Competitive Execution Takes Center Stage at Binance Blockchain Week',
      'Live trading competitions test risk discipline in ways backtests never can.\n\nAt #BinanceBlockchainWeek in Bangkok on Nov 28 (06:00 UTC), top traders will compete head-to-head on Binance Square for a $170K prize pool — including $100K for first place.\n\nIf you study orderbook execution and position sizing under pressure, tune into the live stream to watch how top desks manage volatility in real time.',
      JSON.stringify([]),
      'short_post',
      'pending_review',
      'gemini',
      'gemini-4-hydrogen',
      'Rewritten from an educational execution-analysis perspective while retaining event date, Bangkok location, and $170K/$100K figures.',
      new Date(Date.now() + 10800 * 1000).toISOString(),
      now,
      null,
      null,
      null
    );
  }
}

seedInitialData();

const DEFAULT_PERSONA_RULES_TEMPLATE = (displayName: string) =>
  `# Writing & Formatting Rules — ${displayName}

## Article Shape & Structure
1. Opening Hook (2-3 crisp sentences): Lead with the concrete market metric, event, or structural shift from the source—never start with generic filler like "In the fast-paced world of crypto".
2. Core Thesis & Data Breakdown: Organize analysis into scannable sections with clear, plain-text subheadings (avoid excessive emojis).
3. Mechanisms & Implications: Explain why the event matters (liquidity, fee capture, positioning, risk factors) strictly grounded in the source facts.
4. Closing Takeaway (2-3 sentences): End with a sharp watch-item or key level/metric to monitor next.

## Style & Constraints
- Short paragraphs (2-4 lines max) for Binance Square readability.
- Use clean bullet points for multi-metric comparisons.
- Include relevant $CASHTAGS and 2-3 #Hashtags naturally at the end.
- Do not fabricate metrics, quotes, or price targets not present in the source.`;

const allPersonaRows = db
  .prepare(`SELECT id, display_name, writing_rules, writing_rules_file FROM personas`)
  .all() as Array<{
  id: string;
  display_name: string;
  writing_rules?: string;
  writing_rules_file?: string;
}>;

for (const pr of allPersonaRows) {
  const safePath = resolveSafePersonaRulesPath(pr.id);
  const relPath = getRelativePersonaRulesPath(pr.id);
  if (safePath && !fs.existsSync(safePath)) {
    const initialRules =
      pr.writing_rules && pr.writing_rules.trim()
        ? pr.writing_rules
        : DEFAULT_PERSONA_RULES_TEMPLATE(pr.display_name);
    fs.writeFileSync(safePath, initialRules, 'utf8');
    db.prepare(`UPDATE personas SET writing_rules = ?, writing_rules_file = ? WHERE id = ?`).run(
      initialRules,
      relPath,
      pr.id
    );
  } else if (!pr.writing_rules_file && relPath) {
    db.prepare(`UPDATE personas SET writing_rules_file = ? WHERE id = ?`).run(relPath, pr.id);
  }
}
