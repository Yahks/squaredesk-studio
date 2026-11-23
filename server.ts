import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  GenerationPipelineError,
  generatePersonaArticle,
  generateStandaloneArticle,
  type ProviderId,
  validateAndSaveProviderKey,
} from './server/aiProviders.ts';
import { encryptSecret, maskSecret } from './server/crypto.ts';
import {
  db,
  deletePostBundleFile,
  getRelativeScrapedBundlePath,
  insertUniqueSourcePosts,
  readPersonaWritingRules,
  resolveSafePersonaRulesPath,
  resolveSafeScrapedBundlePath,
  writePersonaWritingRules,
} from './server/db.ts';
import {
  getActiveBrowserAccountIds,
  killAccountBrowser,
  resolveActiveChallenge,
  startAuthSessionCheck,
  startPublishJob,
  startScrapeJob,
  verifyAccountProxy,
} from './server/playwrightEngine.ts';
import {
  parseBinanceSquareHtml,
  parseBinanceSquarePostDetailHtml,
  type ParsedSquareComment,
} from './server/squareParser.ts';
import {
  killPipelineWorkflow,
  listPipelines,
  pausePipelineWorkflow,
  resumePipelineWorkflow,
  savePipelineConfig,
  startPipelineScheduler,
  startPipelineWorkflow,
  triggerPipelineCycleNow,
} from './server/pipelineEngine.ts';

const PORT = Number(process.env.PORT) || 3000;
const PROFILES_DIR = path.resolve(process.cwd(), 'data', 'profiles');

function maskProxyUrl(proxyUrl: string): string {
  const trimmed = (proxyUrl || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    const authPart = u.username ? `${u.username.slice(0, 2)}•••@` : '';
    return `${u.protocol}//${authPart}${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'configured';
  }
}

function getSanitizedBootstrap() {
  const rawAccounts = db.prepare('SELECT * FROM accounts ORDER BY role ASC, created_at ASC').all() as Array<{
    id: string;
    role: 'scraper' | 'publisher';
    label: string;
    login_identifier: string;
    login_password_enc: string;
    binance_square_api_key_ref: string;
    binance_square_api_key_enc?: string;
    binance_square_api_key_masked?: string;
    status: string;
    created_at: string;
  }>;

  const accounts = rawAccounts.map((a) => ({
    id: a.id,
    role: a.role,
    label: a.label,
    login_identifier: a.login_identifier,
    has_password: Boolean(a.login_password_enc),
    binance_square_api_key_ref: a.binance_square_api_key_ref,
    has_square_api_key: Boolean(a.binance_square_api_key_enc),
    square_api_key_masked: a.binance_square_api_key_masked || '',
    status: a.status,
    created_at: a.created_at,
  }));

  const existingPersonaAccountIds = new Set(
    (
      db.prepare('SELECT account_id FROM personas WHERE account_id IS NOT NULL').all() as Array<{
        account_id: string;
      }>
    ).map((r) => r.account_id)
  );
  for (const acc of accounts) {
    if (acc.role === 'publisher' && !existingPersonaAccountIds.has(acc.id)) {
      const personaId = `per_${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(`
        INSERT INTO personas (
          id, account_id, display_name, bio, niche, tone, style_examples,
          posting_frequency, active_hours, banned_topics, created_at
        ) VALUES (?, ?, ?, '', ?, 'analytical, objective', '[]', '3/day', ?, ?, ?)
      `).run(
        personaId,
        acc.id,
        acc.label,
        JSON.stringify(['Crypto', 'Market Structure']),
        JSON.stringify(['08:00', '13:00', '20:00']),
        JSON.stringify(['price predictions', 'financial advice']),
        new Date().toISOString()
      );
    }
  }

  const rawPersonas = db.prepare('SELECT * FROM personas ORDER BY created_at ASC').all() as Array<{
    id: string;
    account_id: string | null;
    display_name: string;
    bio: string;
    niche: string;
    tone: string;
    style_examples: string;
    posting_frequency: string;
    active_hours: string;
    banned_topics: string;
    writing_rules?: string;
    writing_rules_file?: string;
    created_at: string;
  }>;

  const personas = rawPersonas.map((p) => {
    const fileRules = readPersonaWritingRules(p.id);
    return {
      ...p,
      niche: JSON.parse(p.niche || '[]'),
      style_examples: JSON.parse(p.style_examples || '[]'),
      active_hours: JSON.parse(p.active_hours || '[]'),
      banned_topics: JSON.parse(p.banned_topics || '[]'),
      writing_rules: fileRules.rules,
      writing_rules_file: fileRules.filePath,
    };
  });

  const rawProfiles = db.prepare('SELECT * FROM browser_profiles').all() as Array<{
    id: string;
    account_id: string;
    dechromium_profile_id: string;
    proxy_url_enc: string;
    proxy_display: string;
    proxy_country: string;
    proxy_timezone: string;
    proxy_locale: string;
    user_agent: string;
    viewport_width: number;
    viewport_height: number;
    cookies_json: string;
    last_launched_at: string | null;
    last_health_check: string | null;
    health_status: string;
    session_valid_until: string | null;
  }>;

  const browserProfiles = rawProfiles.map((bp) => {
    let cookieCount = 0;
    try {
      const parsed = JSON.parse(bp.cookies_json || '[]');
      if (Array.isArray(parsed)) cookieCount = parsed.length;
    } catch {
      cookieCount = 0;
    }
    return {
      id: bp.id,
      account_id: bp.account_id,
      dechromium_profile_id: bp.dechromium_profile_id,
      proxy_display: bp.proxy_display,
      has_proxy: Boolean(bp.proxy_url_enc),
      proxy_country: bp.proxy_country,
      proxy_timezone: bp.proxy_timezone,
      proxy_locale: bp.proxy_locale,
      user_agent: bp.user_agent,
      viewport_width: bp.viewport_width,
      viewport_height: bp.viewport_height,
      cookie_count: cookieCount,
      last_launched_at: bp.last_launched_at,
      last_health_check: bp.last_health_check,
      health_status: bp.health_status,
      session_valid_until: bp.session_valid_until,
    };
  });

  const rawPosts = db.prepare('SELECT * FROM source_posts ORDER BY collected_at DESC LIMIT 1000').all() as Array<{
    id: string;
    source_type: string;
    feed_tab: string;
    external_id: string;
    author: string;
    author_handle: string;
    author_avatar: string;
    post_url: string;
    content: string;
    cashtags: string;
    hashtags: string;
    media_urls: string;
    engagement_metrics: string;
    collected_at: string;
    used_by_persona_ids: string;
    comments_json?: string;
    bundle_file_path?: string;
  }>;

  const sourcePosts = rawPosts.map((sp) => {
    let comments: ParsedSquareComment[] = [];
    try {
      const parsedComments = JSON.parse(sp.comments_json || '[]');
      if (Array.isArray(parsedComments)) comments = parsedComments;
    } catch {
      comments = [];
    }
    return {
      ...sp,
      cashtags: JSON.parse(sp.cashtags || '[]'),
      hashtags: JSON.parse(sp.hashtags || '[]'),
      media_urls: JSON.parse(sp.media_urls || '[]'),
      engagement_metrics: JSON.parse(sp.engagement_metrics || '{}'),
      used_by_persona_ids: JSON.parse(sp.used_by_persona_ids || '[]'),
      comments,
      bundle_file_path: sp.bundle_file_path || getRelativeScrapedBundlePath(sp.id),
    };
  });

  const rawProviders = db.prepare('SELECT * FROM ai_providers').all() as Array<{
    id: string;
    provider_name: string;
    base_url: string;
    key_masked: string;
    available_models: string;
    selected_model: string;
    validated: number;
    last_validated_at: string | null;
    validation_error: string;
  }>;

  const providers = rawProviders.map((pr) => ({
    id: pr.id,
    provider_name: pr.provider_name,
    base_url: pr.base_url,
    key_masked: pr.key_masked,
    available_models: JSON.parse(pr.available_models || '[]'),
    selected_model: pr.selected_model,
    validated: Boolean(pr.validated),
    last_validated_at: pr.last_validated_at,
    validation_error: pr.validation_error,
  }));

  const rawDrafts = db.prepare('SELECT * FROM drafts ORDER BY generated_at DESC').all() as Array<{
    id: string;
    persona_id: string;
    source_post_ids: string;
    title: string;
    content: string;
    media_paths: string;
    post_format: string;
    status: string;
    llm_provider: string;
    llm_model: string;
    uniqueness_notes: string;
    scheduled_for: string | null;
    generated_at: string;
    reviewed_at: string | null;
    published_at: string | null;
    binance_post_id: string | null;
  }>;

  const drafts = rawDrafts.map((d) => ({
    ...d,
    source_post_ids: JSON.parse(d.source_post_ids || '[]'),
    media_paths: JSON.parse(d.media_paths || '[]'),
  }));

  const publishLogs = db
    .prepare('SELECT * FROM publish_log ORDER BY published_at DESC LIMIT 100')
    .all();

  const rawJobs = db
    .prepare('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT 30')
    .all() as Array<{
    id: string;
    job_type: string;
    account_id: string;
    draft_id: string | null;
    feed_tab: string | null;
    status: string;
    current_step: string;
    logs: string;
    challenge_screenshot: string | null;
    challenge_message: string;
    created_at: string;
    updated_at: string;
  }>;

  const jobs = rawJobs.map((j) => ({
    ...j,
    logs: JSON.parse(j.logs || '[]'),
  }));

  const rawStandalone = db
    .prepare('SELECT * FROM standalone_generations ORDER BY created_at DESC LIMIT 30')
    .all() as Array<{
    id: string;
    source_post_ids: string;
    custom_input: string;
    prompt: string;
    title: string;
    content: string;
    llm_provider: string;
    llm_model: string;
    latency_ms: number;
    status?: string;
    error_message?: string;
    logs?: string;
    created_at: string;
  }>;

  const standaloneGenerations = rawStandalone.map((sg) => {
    let parsedLogs: Array<{ ts: string; step: string; level: string; message: string }> = [];
    try {
      const p = JSON.parse(sg.logs || '[]');
      if (Array.isArray(p)) parsedLogs = p;
    } catch {
      parsedLogs = [];
    }
    return {
      ...sg,
      status: sg.status === 'failed' ? 'failed' : 'completed',
      error_message: sg.error_message || '',
      logs: parsedLogs,
      source_post_ids: JSON.parse(sg.source_post_ids || '[]'),
    };
  });

  return {
    accounts,
    personas,
    browserProfiles,
    sourcePosts,
    providers,
    drafts,
    publishLogs,
    jobs,
    standaloneGenerations,
    pipelines: listPipelines(),
    activeBrowserAccountIds: getActiveBrowserAccountIds(),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get('/api/bootstrap', (_req, res) => {
    res.json(getSanitizedBootstrap());
  });

  // --- Accounts & Browser Profiles ---
  app.post('/api/accounts', (req, res) => {
    try {
      const {
        role = 'publisher',
        label,
        login_identifier = '',
        login_password = '',
        binance_square_api_key_ref = '',
        binance_square_api_key = '',
        proxy_url = '',
        proxy_country = '',
        proxy_timezone = '',
        proxy_locale = '',
        persona,
      } = req.body as {
        role: 'scraper' | 'publisher';
        label: string;
        login_identifier?: string;
        login_password?: string;
        binance_square_api_key_ref?: string;
        binance_square_api_key?: string;
        proxy_url?: string;
        proxy_country?: string;
        proxy_timezone?: string;
        proxy_locale?: string;
        persona?: {
          display_name: string;
          bio?: string;
          niche?: string[];
          tone?: string;
          style_examples?: string[];
          posting_frequency?: string;
          active_hours?: string[];
          banned_topics?: string[];
        };
      };

      if (!label?.trim()) {
        res.status(400).json({ error: 'Account label is required.' });
        return;
      }

      const trimmedProxy = (proxy_url || '').trim();
      if (trimmedProxy && !/^(https?|socks5h?):\/\//i.test(trimmedProxy)) {
        res.status(400).json({
          error: 'Proxy URL must use http://, https://, socks5://, or socks5h:// (or leave empty to skip proxy).',
        });
        return;
      }

      const trimmedSquareApiKey = role === 'publisher' ? (binance_square_api_key || '').trim() : '';
      const accountId = `acc_${role === 'scraper' ? 'scr' : 'pub'}_${crypto.randomBytes(3).toString('hex')}`;
      const profileId = `prof_${crypto.randomBytes(3).toString('hex')}`;
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO accounts (
          id, role, label, login_identifier, login_password_enc, binance_square_api_key_ref,
          binance_square_api_key_enc, binance_square_api_key_masked, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        role,
        label.trim(),
        login_identifier.trim(),
        login_password ? encryptSecret(login_password) : '',
        binance_square_api_key_ref.trim() || (role === 'scraper' ? 'none://scraper-only' : `vault://binance/${accountId}`),
        trimmedSquareApiKey ? encryptSecret(trimmedSquareApiKey) : '',
        trimmedSquareApiKey ? maskSecret(trimmedSquareApiKey) : '',
        (login_identifier && login_password) || trimmedSquareApiKey ? 'active' : 'needs_auth',
        now
      );

      db.prepare(`
        INSERT INTO browser_profiles (
          id, account_id, dechromium_profile_id, proxy_url_enc, proxy_display,
          proxy_country, proxy_timezone, proxy_locale, cookies_json, health_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'unconfigured')
      `).run(
        profileId,
        accountId,
        path.join(PROFILES_DIR, profileId),
        trimmedProxy ? encryptSecret(trimmedProxy) : '',
        maskProxyUrl(trimmedProxy),
        trimmedProxy ? (proxy_country || '').toUpperCase() : '',
        trimmedProxy ? (proxy_timezone || '') : '',
        trimmedProxy ? (proxy_locale || '') : ''
      );

      if (role === 'publisher') {
        const personaId = `per_${crypto.randomBytes(3).toString('hex')}`;
        const personaDisplayName = (persona?.display_name || '').trim() || label.trim();
        db.prepare(`
          INSERT INTO personas (
            id, account_id, display_name, bio, niche, tone, style_examples,
            posting_frequency, active_hours, banned_topics, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          personaId,
          accountId,
          personaDisplayName,
          persona?.bio || '',
          JSON.stringify(persona?.niche?.length ? persona.niche : ['Crypto', 'Market Structure']),
          persona?.tone || 'analytical, objective',
          JSON.stringify(persona?.style_examples || []),
          persona?.posting_frequency || '3/day',
          JSON.stringify(persona?.active_hours?.length ? persona.active_hours : ['08:00', '13:00', '20:00']),
          JSON.stringify(persona?.banned_topics?.length ? persona.banned_topics : ['price predictions', 'financial advice']),
          now
        );
        const starterRules = `# Writing & Formatting Rules — ${personaDisplayName}\n\n## Article Shape & Structure\n1. Opening Hook (2-3 crisp sentences): Lead with the concrete market metric, event, or structural shift.\n2. Core Thesis & Data Breakdown: Organize into scannable sections with clear subheadings.\n3. Closing Takeaway: End with an actionable watch-item grounded in the source facts.\n`;
        writePersonaWritingRules(personaId, starterRules);
      }

      res.json({ ok: true, accountId, profileId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create account' });
    }
  });

  app.put('/api/accounts/:id', (req, res) => {
    try {
      const { id } = req.params;
      const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
        | {
            id: string;
            role: 'scraper' | 'publisher';
            login_password_enc: string;
            binance_square_api_key_enc?: string;
            binance_square_api_key_masked?: string;
          }
        | undefined;
      if (!existing) {
        res.status(404).json({ error: 'Account not found.' });
        return;
      }

      const {
        label,
        login_identifier,
        login_password,
        binance_square_api_key_ref,
        binance_square_api_key,
        clear_square_api_key,
        status,
        proxy_url,
        clear_proxy,
        proxy_country,
        proxy_timezone,
        proxy_locale,
        viewport_width,
        viewport_height,
      } = req.body as {
        label?: string;
        login_identifier?: string;
        login_password?: string;
        binance_square_api_key_ref?: string;
        binance_square_api_key?: string;
        clear_square_api_key?: boolean;
        status?: string;
        proxy_url?: string;
        clear_proxy?: boolean;
        proxy_country?: string;
        proxy_timezone?: string;
        proxy_locale?: string;
        viewport_width?: number;
        viewport_height?: number;
      };

      if (proxy_url && proxy_url.trim() && !/^(https?|socks5h?):\/\//i.test(proxy_url.trim())) {
        res.status(400).json({
          error: 'Proxy URL must use http://, https://, socks5://, or socks5h:// (or leave empty to skip proxy).',
        });
        return;
      }

      const trimmedApiKey = (binance_square_api_key || '').trim();
      const nextApiKeyEnc =
        existing.role !== 'publisher' || clear_square_api_key
          ? ''
          : trimmedApiKey
          ? encryptSecret(trimmedApiKey)
          : existing.binance_square_api_key_enc || '';
      const nextApiKeyMasked =
        existing.role !== 'publisher' || clear_square_api_key
          ? ''
          : trimmedApiKey
          ? maskSecret(trimmedApiKey)
          : existing.binance_square_api_key_masked || '';

      db.prepare(`
        UPDATE accounts SET
          label = COALESCE(?, label),
          login_identifier = COALESCE(?, login_identifier),
          login_password_enc = ?,
          binance_square_api_key_ref = COALESCE(?, binance_square_api_key_ref),
          binance_square_api_key_enc = ?,
          binance_square_api_key_masked = ?,
          status = COALESCE(?, status)
        WHERE id = ?
      `).run(
        label?.trim() || null,
        login_identifier !== undefined ? login_identifier.trim() : null,
        login_password && login_password.trim()
          ? encryptSecret(login_password.trim())
          : existing.login_password_enc,
        binance_square_api_key_ref !== undefined ? binance_square_api_key_ref.trim() : null,
        nextApiKeyEnc,
        nextApiKeyMasked,
        status || null,
        id
      );

      const profile = db.prepare('SELECT * FROM browser_profiles WHERE account_id = ?').get(id) as
        | { proxy_url_enc: string; proxy_display: string }
        | undefined;
      if (profile) {
        const nextProxyEnc = clear_proxy
          ? ''
          : proxy_url && proxy_url.trim()
          ? encryptSecret(proxy_url.trim())
          : profile.proxy_url_enc;
        const nextProxyDisplay = clear_proxy
          ? ''
          : proxy_url && proxy_url.trim()
          ? maskProxyUrl(proxy_url.trim())
          : profile.proxy_display;
        const hasProxyAfterUpdate = Boolean(nextProxyEnc);

        db.prepare(`
          UPDATE browser_profiles SET
            proxy_url_enc = ?,
            proxy_display = ?,
            proxy_country = ?,
            proxy_timezone = ?,
            proxy_locale = ?,
            viewport_width = COALESCE(?, viewport_width),
            viewport_height = COALESCE(?, viewport_height)
          WHERE account_id = ?
        `).run(
          nextProxyEnc,
          nextProxyDisplay,
          hasProxyAfterUpdate
            ? proxy_country !== undefined
              ? proxy_country.toUpperCase()
              : ''
            : '',
          hasProxyAfterUpdate ? proxy_timezone || '' : '',
          hasProxyAfterUpdate ? proxy_locale || '' : '',
          viewport_width || null,
          viewport_height || null,
          id
        );
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update account' });
    }
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    try {
      await killAccountBrowser(req.params.id).catch(() => {});
      db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete account' });
    }
  });

  app.post('/api/accounts/:id/clear-cookies', (req, res) => {
    db.prepare(
      `UPDATE browser_profiles SET cookies_json = '[]', storage_state_json = '{}', health_status = 'expired' WHERE account_id = ?`
    ).run(req.params.id);
    db.prepare(`UPDATE accounts SET status = 'needs_auth' WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/accounts/:id/check-proxy', async (req, res) => {
    try {
      const result = await verifyAccountProxy(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Proxy check failed' });
    }
  });

  app.post('/api/accounts/:id/auth-check', async (req, res) => {
    try {
      const jobId = await startAuthSessionCheck(req.params.id);
      res.json({ ok: true, jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start session verification' });
    }
  });

  app.post('/api/accounts/:id/kill-browser', async (req, res) => {
    try {
      const result = await killAccountBrowser(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to stop browser' });
    }
  });

  // --- Personas ---
  app.put('/api/personas/:id', (req, res) => {
    try {
      const { id } = req.params;
      const {
        display_name,
        bio,
        niche,
        tone,
        style_examples,
        posting_frequency,
        active_hours,
        banned_topics,
        writing_rules,
      } = req.body as {
        display_name?: string;
        bio?: string;
        niche?: string[];
        tone?: string;
        style_examples?: string[];
        posting_frequency?: string;
        active_hours?: string[];
        banned_topics?: string[];
        writing_rules?: string;
      };

      db.prepare(`
        UPDATE personas SET
          display_name = COALESCE(?, display_name),
          bio = COALESCE(?, bio),
          niche = COALESCE(?, niche),
          tone = COALESCE(?, tone),
          style_examples = COALESCE(?, style_examples),
          posting_frequency = COALESCE(?, posting_frequency),
          active_hours = COALESCE(?, active_hours),
          banned_topics = COALESCE(?, banned_topics)
        WHERE id = ?
      `).run(
        display_name?.trim() || null,
        bio !== undefined ? bio : null,
        niche ? JSON.stringify(niche) : null,
        tone !== undefined ? tone : null,
        style_examples ? JSON.stringify(style_examples) : null,
        posting_frequency || null,
        active_hours ? JSON.stringify(active_hours) : null,
        banned_topics ? JSON.stringify(banned_topics) : null,
        id
      );

      if (writing_rules !== undefined) {
        writePersonaWritingRules(id, writing_rules);
      }

      const latestRules = readPersonaWritingRules(id);
      res.json({ ok: true, writing_rules_file: latestRules.filePath });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update persona' });
    }
  });

  app.get('/api/personas/:id/rules-file', (req, res) => {
    const safePath = resolveSafePersonaRulesPath(req.params.id);
    if (!safePath) {
      res.status(400).json({ error: 'Invalid persona identifier.' });
      return;
    }
    const { rules, filePath } = readPersonaWritingRules(req.params.id);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(safePath)}"`);
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('X-Persona-Rules-Path', filePath);
    res.send(rules);
  });

  // --- Feature 1: Scraper & Source Posts ---
  app.post('/api/scrape/run', async (req, res) => {
    try {
      const { accountId, feedTab = 'discover', targetCount = 100, includeComments = true } = req.body as {
        accountId: string;
        feedTab: 'discover' | 'following' | 'news' | 'academy' | 'all';
        targetCount?: number;
        includeComments?: boolean;
      };
      const numericTarget = Number(targetCount);
      if (!Number.isFinite(numericTarget) || numericTarget < 1 || numericTarget > 200) {
        res.status(400).json({ error: 'Target posts to scrape must be between 1 and 200.' });
        return;
      }
      const jobId = await startScrapeJob({
        accountId,
        feedTab,
        targetCount: Math.round(numericTarget),
        includeComments: Boolean(includeComments),
      });
      res.json({ ok: true, jobId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to launch scraper' });
    }
  });

  app.post('/api/posts/import-html', (req, res) => {
    try {
      const { html, feedTab = 'discover' } = req.body as { html: string; feedTab?: string };
      if (!html || !html.trim()) {
        res.status(400).json({ error: 'Paste Binance Square HTML DOM markup to extract posts.' });
        return;
      }

      const isPostDetailHtml =
        /id="articleBody"/i.test(html) ||
        /post-detail-content-block/i.test(html) ||
        /id="comment"/i.test(html);

      let parsed = isPostDetailHtml
        ? (() => {
            const detail = parseBinanceSquarePostDetailHtml(html);
            return detail ? [detail.post] : [];
          })()
        : [];

      if (parsed.length === 0) {
        parsed = parseBinanceSquareHtml(html);
      }

      if (parsed.length === 0) {
        res.status(400).json({
          error: 'No Binance Square posts found in HTML (expected FeedBuzzBaseViewRootBox, #articleBody, or data-id elements).',
        });
        return;
      }

      const { insertedCount, skippedCount, insertedIds } = insertUniqueSourcePosts(parsed, {
        sourceType: 'dom_import',
        feedTab,
      });

      res.json({
        ok: true,
        count: insertedCount,
        skippedDuplicates: skippedCount,
        postIds: insertedIds,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to parse HTML' });
    }
  });

  app.get('/api/posts/:id/file', (req, res) => {
    const safePath = resolveSafeScrapedBundlePath(req.params.id);
    if (!safePath) {
      res.status(400).json({ error: 'Invalid post identifier.' });
      return;
    }

    const wantDownload = req.query.download === '1';
    if (wantDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="post-${path.basename(safePath)}"`);
    }

    if (fs.existsSync(safePath)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(fs.readFileSync(safePath, 'utf8'));
      return;
    }

    const row = db.prepare('SELECT * FROM source_posts WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          external_id: string;
          source_type: string;
          feed_tab: string;
          post_url: string;
          author: string;
          author_handle: string;
          author_avatar: string;
          collected_at: string;
          content: string;
          cashtags: string;
          hashtags: string;
          media_urls: string;
          engagement_metrics: string;
          comments_json?: string;
        }
      | undefined;

    if (!row) {
      res.status(404).json({ error: 'Scraped post file not found.' });
      return;
    }

    const comments = JSON.parse(row.comments_json || '[]') as ParsedSquareComment[];
    res.json({
      id: row.id,
      external_id: row.external_id,
      source_type: row.source_type,
      feed_tab: row.feed_tab,
      post_url: row.post_url,
      author: row.author,
      author_handle: row.author_handle,
      author_avatar: row.author_avatar,
      collected_at: row.collected_at,
      content: row.content,
      cashtags: JSON.parse(row.cashtags || '[]'),
      hashtags: JSON.parse(row.hashtags || '[]'),
      media_urls: JSON.parse(row.media_urls || '[]'),
      engagement_metrics: JSON.parse(row.engagement_metrics || '{}'),
      comments_count: comments.length,
      comments,
    });
  });

  app.delete('/api/posts/:id', (req, res) => {
    deletePostBundleFile(req.params.id);
    db.prepare('DELETE FROM source_posts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // --- Feature 2: AI Providers & Article Generation ---
  app.post('/api/providers/:id/validate', async (req, res) => {
    try {
      const providerId = req.params.id as ProviderId;
      const { apiKey = '', baseUrl, selectedModel } = req.body as {
        apiKey?: string;
        baseUrl?: string;
        selectedModel?: string;
      };
      const result = await validateAndSaveProviderKey({ providerId, apiKey, baseUrl, selectedModel });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Validation failed' });
    }
  });

  app.put('/api/providers/:id/model', (req, res) => {
    const { selectedModel, baseUrl } = req.body as { selectedModel?: string; baseUrl?: string };
    db.prepare(
      'UPDATE ai_providers SET selected_model = COALESCE(?, selected_model), base_url = COALESCE(?, base_url) WHERE id = ?'
    ).run(selectedModel || null, baseUrl?.trim() || null, req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/generate', async (req, res) => {
    try {
      const { sourcePostIds, personaId, providerId, model, postFormat, customAngle, scheduledFor } = req.body as {
        sourcePostIds: string[];
        personaId: string;
        providerId: ProviderId;
        model?: string;
        postFormat?: 'short_post' | 'long_article';
        customAngle?: string;
        scheduledFor?: string;
      };

      if (!Array.isArray(sourcePostIds) || sourcePostIds.length === 0) {
        res.status(400).json({ error: 'Select at least one scraped post to rewrite.' });
        return;
      }

      const { draft, logs } = await generatePersonaArticle({
        sourcePostIds,
        personaId,
        providerId,
        model,
        postFormat,
        customAngle,
        scheduledFor,
      });

      res.json({ ok: true, draft, logs });
    } catch (err) {
      if (err instanceof GenerationPipelineError) {
        res.status(400).json({ error: err.message, logs: err.logs });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Article generation failed' });
    }
  });

  app.post('/api/generate/standalone', async (req, res) => {
    try {
      const { sourcePostIds, providerId, model, prompt, customInput } = req.body as {
        sourcePostIds?: string[];
        providerId: ProviderId;
        model?: string;
        prompt: string;
        customInput?: string;
      };

      const generation = await generateStandaloneArticle({
        sourcePostIds,
        providerId,
        model,
        prompt,
        customInput,
      });

      res.json({ ok: true, generation });
    } catch (err) {
      if (err instanceof GenerationPipelineError) {
        res.status(400).json({
          error: err.message,
          logs: err.logs,
          generation: err.generation,
        });
        return;
      }
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Standalone generation failed',
      });
    }
  });

  app.delete('/api/generate/standalone/:id', (req, res) => {
    db.prepare('DELETE FROM standalone_generations WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // --- Feature 3: Human Review, Scheduler & Publisher ---
  app.put('/api/drafts/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { title, content, status, scheduled_for, media_paths } = req.body as {
        title?: string;
        content?: string;
        status?: string;
        scheduled_for?: string | null;
        media_paths?: string[];
      };

      const reviewedAt =
        status === 'approved' || status === 'scheduled' || status === 'rejected'
          ? new Date().toISOString()
          : undefined;

      db.prepare(`
        UPDATE drafts SET
          title = COALESCE(?, title),
          content = COALESCE(?, content),
          status = COALESCE(?, status),
          scheduled_for = COALESCE(?, scheduled_for),
          media_paths = COALESCE(?, media_paths),
          reviewed_at = COALESCE(?, reviewed_at)
        WHERE id = ?
      `).run(
        title !== undefined ? title : null,
        content !== undefined ? content : null,
        status || null,
        scheduled_for !== undefined ? scheduled_for : null,
        media_paths ? JSON.stringify(media_paths) : null,
        reviewedAt || null,
        id
      );

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update draft' });
    }
  });

  app.delete('/api/drafts/:id', (req, res) => {
    db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/drafts/:id/publish', async (req, res) => {
    try {
      const { accountId } = (req.body || {}) as { accountId?: string };
      const { jobId, method } = await startPublishJob(req.params.id, accountId);
      res.json({ ok: true, jobId, method });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to trigger publish job' });
    }
  });

  // --- Automation Jobs & Challenge Resolver ---
  app.get('/api/jobs', (_req, res) => {
    const rows = db.prepare('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT 30').all() as Array<{
      logs: string;
      [key: string]: unknown;
    }>;
    res.json(
      rows.map((r) => ({
        ...r,
        logs: JSON.parse(r.logs || '[]'),
      }))
    );
  });

  app.post('/api/jobs/:id/resolve', (req, res) => {
    const { mfaCode, captchaAction } = req.body as {
      mfaCode?: string;
      captchaAction?: { type: 'click' | 'confirm' | 'abort'; x?: number; y?: number };
    };
    const resolved = resolveActiveChallenge(req.params.id, { mfaCode, captchaAction });
    if (!resolved) {
      res.status(404).json({ error: 'No active interactive challenge found for this job.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Master Automated Pipeline (Scrape -> Generate -> Publish) ---
  app.put('/api/pipelines/:accountId', (req, res) => {
    try {
      const pipeline = savePipelineConfig({
        ...(req.body || {}),
        accountId: req.params.accountId,
      });
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save pipeline configuration' });
    }
  });

  app.post('/api/pipelines/start', async (req, res) => {
    try {
      if (!req.body?.accountId) {
        res.status(400).json({ error: 'Select a Master Publisher account to automate.' });
        return;
      }
      const pipeline = await startPipelineWorkflow(req.body);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start master pipeline' });
    }
  });

  app.post('/api/pipelines/:accountId/pause', async (req, res) => {
    try {
      const pipeline = await pausePipelineWorkflow(req.params.accountId);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to pause master pipeline' });
    }
  });

  app.post('/api/pipelines/:accountId/stop', async (req, res) => {
    try {
      const pipeline = await killPipelineWorkflow(req.params.accountId);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to stop master pipeline' });
    }
  });

  app.post('/api/pipelines/:accountId/kill', async (req, res) => {
    try {
      const pipeline = await killPipelineWorkflow(req.params.accountId);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to stop master pipeline' });
    }
  });

  app.post('/api/pipelines/:accountId/resume', async (req, res) => {
    try {
      const pipeline = await resumePipelineWorkflow(req.params.accountId);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to resume master pipeline' });
    }
  });

  app.post('/api/pipelines/:accountId/trigger', (req, res) => {
    try {
      const pipeline = triggerPipelineCycleNow(req.params.accountId);
      res.json({ ok: true, pipeline });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to trigger pipeline cycle' });
    }
  });

  // --- Background Staggered Queue Scheduler (runs every 30s) ---
  setInterval(() => {
    try {
      const dueDrafts = db
        .prepare(
          `SELECT id FROM drafts WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?`
        )
        .all(new Date().toISOString()) as Array<{ id: string }>;

      for (const d of dueDrafts) {
        void startPublishJob(d.id).catch(() => {});
      }
    } catch {
      // ignore scheduler loop errors
    }
  }, 30000);

  startPipelineScheduler();

  // Vite middleware in dev, static dist in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SquareDesk Studio listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
