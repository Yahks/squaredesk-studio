import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { chromium } from 'playwright';
import { decryptSecret } from './crypto.ts';
import { db, insertUniqueSourcePosts, loadExistingSourceSignatures } from './db.ts';
import {
  computePostContentHash,
  parseBinanceSquareFeedLinks,
  parseBinanceSquarePostDetailHtml,
  type DiscoveredFeedLink,
  type ParsedSquareComment,
  type ParsedSquarePost,
} from './squareParser.ts';

const execFileAsync = promisify(execFile);

interface ActiveChallenge {
  page: Page;
  context: BrowserContext;
  type: 'mfa' | 'captcha';
  resolveMfa?: (code: string) => void;
  resolveCaptcha?: (action: { type: 'click' | 'confirm' | 'abort'; x?: number; y?: number }) => void;
}

interface ActiveBrowserSession {
  accountId: string;
  jobId?: string;
  context?: BrowserContext;
  browser?: Browser;
  userDataDir?: string;
  aborted: boolean;
}

const activeChallenges = new Map<string, ActiveChallenge>();
const activeAccountBrowsers = new Map<string, Set<ActiveBrowserSession>>();
const abortedJobIds = new Set<string>();

function registerAccountSession(session: ActiveBrowserSession): () => void {
  let set = activeAccountBrowsers.get(session.accountId);
  if (!set) {
    set = new Set();
    activeAccountBrowsers.set(session.accountId, set);
  }
  set.add(session);
  return () => {
    const current = activeAccountBrowsers.get(session.accountId);
    if (!current) return;
    current.delete(session);
    if (current.size === 0) {
      activeAccountBrowsers.delete(session.accountId);
    }
  };
}

function throwIfJobAborted(jobId: string) {
  if (abortedJobIds.has(jobId)) {
    throw new Error('Browser stopped by operator.');
  }
}

async function closeWithTimeout(fn: () => Promise<void>, timeoutMs = 2500) {
  await Promise.race([
    fn().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function killStrayChromiumForUserDataDir(userDataDir: string): Promise<number> {
  const cleanDir = (userDataDir || '').trim();
  if (!cleanDir || process.platform === 'win32') return 0;
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,args'], { timeout: 3000 });
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(cleanDir)) continue;
      if (!/(chrom|playwright)/i.test(line)) continue;
      const match = line.trim().match(/^(\d+)\s+/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (Number.isFinite(pid) && pid > 1 && pid !== process.pid) {
        pids.push(pid);
      }
    }
    let killed = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        killed++;
      } catch {
        // Already exited
      }
    }
    if (pids.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

export function getActiveBrowserAccountIds(): string[] {
  const ids = new Set<string>();
  for (const [accountId, sessions] of activeAccountBrowsers.entries()) {
    if (sessions.size > 0) {
      ids.add(accountId);
    }
  }
  const activeRows = db
    .prepare(
      `SELECT DISTINCT account_id FROM automation_jobs WHERE status IN ('running', 'queued', 'awaiting_mfa', 'awaiting_captcha')`
    )
    .all() as Array<{ account_id: string }>;
  for (const row of activeRows) {
    if (row.account_id) ids.add(row.account_id);
  }
  return Array.from(ids);
}

export async function killAccountBrowser(accountId: string): Promise<{
  ok: boolean;
  accountId: string;
  label: string;
  closedContexts: number;
  stoppedJobs: number;
  killedPids: number;
}> {
  const account = db.prepare('SELECT id, label FROM accounts WHERE id = ?').get(accountId) as
    | { id: string; label: string }
    | undefined;
  if (!account) {
    throw new Error('Account not found.');
  }

  const profile = db
    .prepare('SELECT dechromium_profile_id FROM browser_profiles WHERE account_id = ?')
    .get(accountId) as { dechromium_profile_id: string } | undefined;

  let closedContexts = 0;
  const sessions = Array.from(activeAccountBrowsers.get(accountId) || []);
  for (const session of sessions) {
    session.aborted = true;
    if (session.jobId) {
      abortedJobIds.add(session.jobId);
      const challenge = activeChallenges.get(session.jobId);
      if (challenge) {
        activeChallenges.delete(session.jobId);
        if (challenge.type === 'mfa' && challenge.resolveMfa) {
          challenge.resolveMfa('__ABORT__');
        } else if (challenge.type === 'captcha' && challenge.resolveCaptcha) {
          challenge.resolveCaptcha({ type: 'abort' });
        }
      }
    }
    if (session.context) {
      await closeWithTimeout(() => session.context!.close());
      closedContexts++;
    }
    if (session.browser) {
      await closeWithTimeout(() => session.browser!.close());
      closedContexts++;
    }
  }
  activeAccountBrowsers.delete(accountId);

  const runningJobs = db
    .prepare(
      `SELECT id, draft_id FROM automation_jobs WHERE account_id = ? AND status IN ('running', 'queued', 'awaiting_mfa', 'awaiting_captcha')`
    )
    .all(accountId) as Array<{ id: string; draft_id: string | null }>;

  let stoppedJobs = 0;
  for (const job of runningJobs) {
    abortedJobIds.add(job.id);
    const challenge = activeChallenges.get(job.id);
    if (challenge) {
      activeChallenges.delete(job.id);
      if (challenge.type === 'mfa' && challenge.resolveMfa) {
        challenge.resolveMfa('__ABORT__');
      } else if (challenge.type === 'captcha' && challenge.resolveCaptcha) {
        challenge.resolveCaptcha({ type: 'abort' });
      }
    }
    appendJobLog(job.id, 'Browser Killed', `Browser stopped, quit, and closed for ${account.label} by operator.`);
    setJobStatus(job.id, 'failed', 'Browser stopped by operator.');
    if (job.draft_id) {
      db.prepare(`UPDATE drafts SET status = 'failed' WHERE id = ? AND status = 'publishing'`).run(job.draft_id);
    }
    stoppedJobs++;
  }

  const killedPids = profile?.dechromium_profile_id
    ? await killStrayChromiumForUserDataDir(profile.dechromium_profile_id)
    : 0;

  return {
    ok: true,
    accountId: account.id,
    label: account.label,
    closedContexts,
    stoppedJobs,
    killedPids,
  };
}

function appendJobLog(jobId: string, step: string, message: string, screenshotBase64?: string) {
  const row = db.prepare('SELECT logs FROM automation_jobs WHERE id = ?').get(jobId) as
    | { logs: string }
    | undefined;
  const logs = row ? (JSON.parse(row.logs || '[]') as Array<{ ts: string; step: string; message: string }>) : [];
  logs.push({ ts: new Date().toISOString(), step, message });
  const now = new Date().toISOString();

  if (screenshotBase64 !== undefined) {
    db.prepare(
      'UPDATE automation_jobs SET current_step = ?, logs = ?, challenge_screenshot = ?, updated_at = ? WHERE id = ?'
    ).run(step, JSON.stringify(logs), screenshotBase64, now, jobId);
  } else {
    db.prepare('UPDATE automation_jobs SET current_step = ?, logs = ?, updated_at = ? WHERE id = ?').run(
      step,
      JSON.stringify(logs),
      now,
      jobId
    );
  }
}

function setJobStatus(
  jobId: string,
  status: 'queued' | 'running' | 'awaiting_mfa' | 'awaiting_captcha' | 'completed' | 'failed',
  challengeMessage = ''
) {
  db.prepare('UPDATE automation_jobs SET status = ?, challenge_message = ?, updated_at = ? WHERE id = ?').run(
    status,
    challengeMessage,
    new Date().toISOString(),
    jobId
  );
}

function parseProxyOption(proxyUrl: string): { server: string; username?: string; password?: string } | undefined {
  const trimmed = (proxyUrl || '').trim();
  if (!trimmed) return undefined;
  try {
    const u = new URL(trimmed);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const result: { server: string; username?: string; password?: string } = { server };
    if (u.username) result.username = decodeURIComponent(u.username);
    if (u.password) result.password = decodeURIComponent(u.password);
    return result;
  } catch {
    return { server: trimmed };
  }
}

async function capturePageBase64(page: Page): Promise<string> {
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    return buf.toString('base64');
  } catch {
    return '';
  }
}

const COUNTRY_TO_LOCALE: Record<string, string> = {
  US: 'en-US',
  GB: 'en-GB',
  UK: 'en-GB',
  SG: 'en-SG',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  IN: 'en-IN',
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  ES: 'es-ES',
  IT: 'it-IT',
  NL: 'nl-NL',
  PT: 'pt-PT',
  BR: 'pt-BR',
  JP: 'ja-JP',
  KR: 'ko-KR',
  TW: 'zh-TW',
  HK: 'zh-HK',
  CN: 'zh-CN',
  AE: 'en-AE',
  SA: 'ar-SA',
  TR: 'tr-TR',
  PL: 'pl-PL',
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
};

function resolveLocaleForCountry(countryCode: string): string {
  const iso = (countryCode || '').trim().toUpperCase();
  if (!iso) return 'en-US';
  return COUNTRY_TO_LOCALE[iso] || `en-${iso}`;
}

async function probeProxyGeo(
  proxyConfig: { server: string; username?: string; password?: string },
  profileId: string,
  jobId?: string,
  accountId?: string
): Promise<{ ip: string; country: string; timezone: string; locale: string }> {
  if (jobId) {
    appendJobLog(jobId, 'Proxy Check', `Verifying proxy tunnel ${proxyConfig.server} and detecting exit country/timezone...`);
  }

  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS === 'false' ? false : true,
    proxy: proxyConfig,
    args: ['--disable-quic', '--disable-background-networking', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const unregisterProbe = accountId
    ? registerAccountSession({ accountId, jobId, browser, aborted: false })
    : () => {};
  try {
    const page = await browser.newPage();
    let detectedIp = '';
    let detectedCountry = '';
    let detectedTimezone = '';

    // Primary geo probe via ip-api.com
    try {
      await gotoWithRetry(page, 'http://ip-api.com/json/?fields=status,message,countryCode,timezone,query', 15000);
      const text = (await page.locator('body').innerText().catch(() => '')).trim();
      const json = JSON.parse(text || '{}') as {
        status?: string;
        message?: string;
        countryCode?: string;
        timezone?: string;
        query?: string;
      };
      if (json.status === 'success' && json.countryCode && json.timezone) {
        detectedIp = json.query || '';
        detectedCountry = json.countryCode.toUpperCase();
        detectedTimezone = json.timezone;
      }
    } catch {
      // Fall through to secondary geo probe
    }

    // Secondary geo probe via ipwho.is
    if (!detectedCountry || !detectedTimezone) {
      await gotoWithRetry(page, 'https://ipwho.is/', 15000);
      const text = (await page.locator('body').innerText().catch(() => '')).trim();
      const json = JSON.parse(text || '{}') as {
        success?: boolean;
        message?: string;
        ip?: string;
        country_code?: string;
        timezone?: { id?: string };
      };
      if (json.success && json.country_code && json.timezone?.id) {
        detectedIp = json.ip || detectedIp;
        detectedCountry = json.country_code.toUpperCase();
        detectedTimezone = json.timezone.id;
      } else {
        throw new Error(json.message || 'Unable to resolve proxy exit IP/country/timezone.');
      }
    }

    const detectedLocale = resolveLocaleForCountry(detectedCountry);
    db.prepare(`
      UPDATE browser_profiles
      SET proxy_country = ?, proxy_timezone = ?, proxy_locale = ?, last_health_check = ?
      WHERE id = ?
    `).run(detectedCountry, detectedTimezone, detectedLocale, new Date().toISOString(), profileId);

    if (jobId) {
      appendJobLog(
        jobId,
        'Proxy Verified',
        `Proxy exit IP ${detectedIp || 'verified'} · Country: ${detectedCountry} · Timezone: ${detectedTimezone} · Locale: ${detectedLocale}`
      );
    }

    return {
      ip: detectedIp,
      country: detectedCountry,
      timezone: detectedTimezone,
      locale: detectedLocale,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy connection check failed';
    throw new Error(`Proxy check failed (${proxyConfig.server}): ${msg}`);
  } finally {
    unregisterProbe();
    await browser.close().catch(() => {});
  }
}

export async function verifyAccountProxy(accountId: string): Promise<{
  ok: boolean;
  ip: string;
  country: string;
  timezone: string;
  locale: string;
}> {
  const profile = db
    .prepare('SELECT id, proxy_url_enc FROM browser_profiles WHERE account_id = ?')
    .get(accountId) as { id: string; proxy_url_enc: string } | undefined;

  if (!profile) {
    throw new Error('Browser profile not found.');
  }

  const proxyRaw = decryptSecret(profile.proxy_url_enc);
  const proxyConfig = parseProxyOption(proxyRaw);
  if (!proxyConfig) {
    throw new Error('No proxy URL configured on this account.');
  }

  const geo = await probeProxyGeo(proxyConfig, profile.id, undefined, accountId);
  return { ok: true, ...geo };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(page: Page, minMs = 220, maxMs = 520) {
  await page.waitForTimeout(randomInt(minMs, maxMs));
}

async function waitForVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return locator.isVisible().catch(() => false);
  }
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function humanType(
  page: Page,
  locator: ReturnType<Page['locator']>,
  text: string,
  options?: { minDelayMs?: number; maxDelayMs?: number; pauseEvery?: number; pauseMinMs?: number; pauseMaxMs?: number }
) {
  const minDelayMs = options?.minDelayMs ?? 55;
  const maxDelayMs = options?.maxDelayMs ?? 145;
  const pauseMinMs = options?.pauseMinMs ?? 160;
  const pauseMaxMs = options?.pauseMaxMs ?? 320;
  let nextPauseAt = options?.pauseEvery ?? randomInt(5, 8);

  await locator.waitFor({ state: 'visible', timeout: 25000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ delay: randomInt(40, 110) });
  await humanPause(page, 160, 340);

  const existing = (
    (await locator.inputValue().catch(() => '')) ||
    (await locator.innerText().catch(() => ''))
  ).trim();
  if (existing) {
    await locator.press('Control+a').catch(() => {});
    await locator.press('Meta+a').catch(() => {});
    await page.waitForTimeout(randomInt(60, 140));
    await locator.press('Backspace').catch(() => {});
    await humanPause(page, 140, 280);
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      await page.keyboard.press('Enter', { delay: randomInt(minDelayMs, maxDelayMs) });
    } else {
      await page.keyboard.type(ch, { delay: randomInt(minDelayMs, maxDelayMs) });
    }
    if (i > 0 && i >= nextPauseAt) {
      await page.waitForTimeout(randomInt(pauseMinMs, pauseMaxMs));
      nextPauseAt = i + (options?.pauseEvery ?? randomInt(5, 8));
    }
  }

  await humanPause(page, 300, 620);
}

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_SOCKET_NOT_CONNECTED|Timeout/i.test(
    msg
  );
}

async function gotoWithRetry(page: Page, url: string, timeoutMs = 45000, maxAttempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // On retry after ERR_NETWORK_CHANGED or ERR_ABORTED, commit + domcontentloaded handles redirects/DNS flaps better
      const waitUntil = attempt === 1 ? 'domcontentloaded' : 'commit';
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      if (waitUntil === 'commit') {
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      }
      return;
    } catch (err) {
      lastErr = err;
      const currentUrl = page.url();
      // If the page actually navigated off about:blank onto Binance despite a transient sub-navigation abort, let load settle
      if (currentUrl && currentUrl !== 'about:blank' && /binance\.(bh|com)/i.test(currentUrl)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
        const hasInteractiveNode = await page
          .locator('[data-e2e="input-username"], input[name="username"], #password-input, #captcha-container, .amzn-captcha-root, #ba-Square')
          .first()
          .isVisible()
          .catch(() => false);
        if (hasInteractiveNode) {
          return;
        }
      }

      if (attempt < maxAttempts && isTransientNetworkError(err)) {
        await page.waitForTimeout(1400 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to navigate to ${url}`);
}

async function gotoWithFallback(page: Page, urls: string[], jobId: string, stepLabel: string): Promise<string> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      appendJobLog(jobId, stepLabel, `Navigating to ${url}`);
      await gotoWithRetry(page, url, 50000, 3);
      // Allow CloudFront AWS WAF JS challenge or SPA hydration to settle
      await page.waitForTimeout(2500);
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      if (page.url() === 'about:blank') {
        throw new Error(`Browser stayed on about:blank after navigating to ${url}`);
      }
      return url;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      appendJobLog(jobId, stepLabel, `Navigation to ${url} failed (${msg}); trying next endpoint if available.`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to load ${urls.join(' or ')}`);
}

async function launchIsolatedContext(
  accountId: string,
  jobId: string,
  options?: { forceProxyCheck?: boolean; headless?: boolean }
): Promise<{
  context: BrowserContext;
  page: Page;
  profileId: string;
  hasSavedCookies: boolean;
}> {
  const profile = db
    .prepare('SELECT * FROM browser_profiles WHERE account_id = ?')
    .get(accountId) as {
    id: string;
    dechromium_profile_id: string;
    proxy_url_enc: string;
    proxy_country: string;
    proxy_timezone: string;
    proxy_locale: string;
    user_agent: string;
    viewport_width: number;
    viewport_height: number;
    cookies_json: string;
    storage_state_json: string;
    health_status: string;
  } | undefined;

  if (!profile) {
    throw new Error(`No browser profile configured for account ${accountId}`);
  }

  const userDataDir = profile.dechromium_profile_id || path.resolve(process.cwd(), 'data', 'profiles', profile.id);
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const proxyRaw = decryptSecret(profile.proxy_url_enc);
  const proxyConfig = parseProxyOption(proxyRaw);

  let resolvedCountry = profile.proxy_country;
  let resolvedTimezone = profile.proxy_timezone;
  let resolvedLocale = profile.proxy_locale;

  const effectiveHeadless =
    options?.headless !== undefined
      ? options.headless
      : process.env.PLAYWRIGHT_HEADLESS === 'false'
      ? false
      : true;

  if (proxyConfig) {
    if (options?.forceProxyCheck || !resolvedCountry || !resolvedTimezone || !resolvedLocale) {
      const geo = await probeProxyGeo(proxyConfig, profile.id, jobId, accountId);
      resolvedCountry = geo.country;
      resolvedTimezone = geo.timezone;
      resolvedLocale = geo.locale;
    }

    throwIfJobAborted(jobId);

    appendJobLog(
      jobId,
      'Launch Browser',
      `Launching isolated Chromium profile (${effectiveHeadless ? 'headless' : 'headed/visible'} · ${resolvedLocale} · ${resolvedTimezone} · ${resolvedCountry}) via proxy ${proxyConfig.server}`
    );
  } else {
    throwIfJobAborted(jobId);
    appendJobLog(
      jobId,
      'Launch Browser',
      `Launching isolated Chromium profile without proxy (${effectiveHeadless ? 'headless' : 'headed/visible'})`
    );
  }

  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: effectiveHeadless,
    userAgent: profile.user_agent,
    viewport: {
      width: profile.viewport_width || 1366,
      height: profile.viewport_height || 860,
    },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-quic',
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };

  if (proxyConfig) {
    launchOpts.proxy = proxyConfig;
    if (resolvedLocale) launchOpts.locale = resolvedLocale;
    if (resolvedTimezone) launchOpts.timezoneId = resolvedTimezone;
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  const unregister = registerAccountSession({
    accountId,
    jobId,
    context,
    userDataDir,
    aborted: false,
  });
  context.on('close', unregister);

  if (abortedJobIds.has(jobId)) {
    unregister();
    await context.close().catch(() => {});
    throw new Error('Browser stopped by operator.');
  }

  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });"
  );

  // Restore saved cookies into persistent context only if a healthy session was previously saved
  let savedCookieCount = 0;
  try {
    const savedCookies = JSON.parse(profile.cookies_json || '[]');
    if (Array.isArray(savedCookies) && savedCookies.length > 0 && profile.health_status === 'healthy') {
      await context.addCookies(savedCookies);
      savedCookieCount = savedCookies.length;
      appendJobLog(jobId, 'Session Restore', `Loaded ${savedCookieCount} saved authenticated cookies into profile.`);
    }
  } catch {
    // Ignore malformed cookie cache
  }

  const hasSavedCookies = savedCookieCount > 0;
  if (!hasSavedCookies) {
    appendJobLog(jobId, 'Session Check', 'No authenticated cookies saved — starting credential login first.');
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  // Brief pause after launch so Chromium's network service initializes before first goto (prevents ERR_NETWORK_CHANGED)
  await page.waitForTimeout(500);

  db.prepare('UPDATE browser_profiles SET last_launched_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    profile.id
  );

  return { context, page, profileId: profile.id, hasSavedCookies };
}

async function persistProfileSession(context: BrowserContext, profileId: string, accountId: string) {
  try {
    const cookies = await context.cookies();
    const storageState = await context.storageState();
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();

    db.prepare(`
      UPDATE browser_profiles
      SET cookies_json = ?, storage_state_json = ?, last_health_check = ?, health_status = 'healthy', session_valid_until = ?
      WHERE id = ?
    `).run(JSON.stringify(cookies), JSON.stringify(storageState), now, validUntil, profileId);

    db.prepare(`UPDATE accounts SET status = 'active' WHERE id = ?`).run(accountId);
  } catch {
    // Ignore persistence failure if browser closed
  }
}

async function handleCaptchaIfPresent(page: Page, context: BrowserContext, jobId: string, accountId: string) {
  const captchaVisible = await page
    .locator('#captcha-container, .amzn-captcha-root')
    .first()
    .isVisible()
    .catch(() => false);
  if (!captchaVisible) return;

  appendJobLog(jobId, 'Captcha Check', 'Security verification detected. Clicking Begin button automatically.');
  const beginBtn = page.locator('#amzn-captcha-verify-button').first();
  if (await beginBtn.isVisible().catch(() => false)) {
    await beginBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  let attempts = 0;
  while (
    (await page.locator('#captcha-container, .amzn-captcha-root').first().isVisible().catch(() => false)) &&
    attempts < 20
  ) {
    attempts++;
    const screenshot = await capturePageBase64(page);
    setJobStatus(
      jobId,
      'awaiting_captcha',
      'Binance security puzzle is active. Interact with the verification viewport below, then continue.'
    );
    db.prepare(`UPDATE accounts SET status = 'challenge_required' WHERE id = ?`).run(accountId);
    appendJobLog(jobId, 'Captcha Challenge', 'Waiting for manual CAPTCHA resolution in Dashboard.', screenshot);

    const action = await new Promise<{ type: 'click' | 'confirm' | 'abort'; x?: number; y?: number }>((resolve) => {
      activeChallenges.set(jobId, {
        page,
        context,
        type: 'captcha',
        resolveCaptcha: resolve,
      });
    });
    activeChallenges.delete(jobId);

    if (action.type === 'abort') {
      throw new Error('CAPTCHA challenge aborted by operator.');
    }
    if (action.type === 'click' && typeof action.x === 'number' && typeof action.y === 'number') {
      await page.mouse.click(action.x, action.y);
      await page.waitForTimeout(1200);
    } else if (action.type === 'confirm') {
      await page.waitForTimeout(1500);
      break;
    }
  }

  setJobStatus(jobId, 'running', '');
}

async function dismissOnboardingPopupIfPresent(page: Page, jobId: string) {
  const skipLocator = page
    .locator('div.css-pb1j2u div.css-12uqp0a:has-text("Skip"), [data-bn-type="text"]:has-text("Skip")')
    .first();
  if (await waitForVisible(skipLocator, 3000)) {
    await skipLocator.click().catch(() => {});
    appendJobLog(jobId, 'Onboarding Dismissed', 'Clicked Skip on Binance Square guidance popup.');
    await page.waitForTimeout(600);
  }
}

async function detectBinanceDashboardState(
  page: Page
): Promise<{ onDashboard: boolean; origin: string; nickname: string }> {
  return page
    .evaluate(() => {
      const href = window.location.href || '';
      let origin = '';
      try {
        const u = new URL(href);
        if (/^https?:$/i.test(u.protocol) && u.host) {
          origin = `${u.protocol}//${u.host}`;
        }
      } catch {
        // ignore invalid URL
      }
      const nicknameEl = document.querySelector('#dashboard-userinfo-nickname');
      const squareWidget = document.querySelector('#dashboard-square');
      const depositBtn = document.querySelector('#dashboard-assets-deposit-btn');
      const isDashboardRoute = /\/my\/dashboard/i.test(href);
      const hasDashboardMarkers = Boolean(nicknameEl || squareWidget || depositBtn);
      return {
        onDashboard: isDashboardRoute || hasDashboardMarkers,
        origin,
        nickname: (nicknameEl?.textContent || '').trim(),
      };
    })
    .catch(() => ({ onDashboard: false, origin: '', nickname: '' }));
}

function getOrderedSquareUrlsForOrigin(preferredOriginOrHost?: string): string[] {
  const hint = (preferredOriginOrHost || '').toLowerCase();
  return hint.includes('binance.bh')
    ? ['https://www.binance.bh/en/square', 'https://www.binance.com/en/square']
    : ['https://www.binance.com/en/square', 'https://www.binance.bh/en/square'];
}

async function navigateDashboardToSquare(params: {
  page: Page;
  context: BrowserContext;
  jobId: string;
  preferredOrigin?: string;
}): Promise<Page> {
  const { context, jobId, preferredOrigin } = params;
  let activePage = params.page;
  const orderedSquareUrls = getOrderedSquareUrlsForOrigin(preferredOrigin || activePage.url());

  const squareNavTrigger = activePage
    .locator('#ba-Square, #dashboard-square .subtitle4:has-text("More"), a[href*="/en/square"]')
    .first();

  if (await waitForVisible(squareNavTrigger, 2500)) {
    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await squareNavTrigger.scrollIntoViewIfNeeded().catch(() => {});
    await squareNavTrigger.click({ delay: randomInt(45, 110) }).catch(() => {});
    appendJobLog(jobId, 'Open Square', 'Clicked Square link on Binance Dashboard.');

    const maybeSquareTab = await popupPromise;
    if (maybeSquareTab) {
      await maybeSquareTab.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await maybeSquareTab.bringToFront().catch(() => {});
      if (!activePage.isClosed() && activePage !== maybeSquareTab) {
        await activePage.close().catch(() => {});
      }
      activePage = maybeSquareTab;
    } else {
      await activePage.waitForURL(/\/square/i, { timeout: 8000 }).catch(() => {});
    }
  }

  if (!activePage.url().includes('/square')) {
    await gotoWithFallback(activePage, orderedSquareUrls, jobId, 'Open Square');
  }

  return activePage;
}

async function checkSquareLoginState(
  page: Page,
  options?: { waitMs?: number }
): Promise<{ loggedIn: boolean; username: string; reason: string }> {
  const waitMs = options?.waitMs ?? 3000;
  if (waitMs > 0) {
    await Promise.race([
      page
        .locator('.user-info.nav-user-card, .nav-user-card, #feed-nav-profile, .user-info-name .username')
        .first()
        .waitFor({ state: 'visible', timeout: waitMs }),
      page
        .locator(
          'div.css-132gffl button, [data-e2e="input-username"], #header_login, a[href*="accounts.binance."], button:has-text("Log In"), button:has-text("Login"), a:has-text("Log In"), #dashboard-userinfo-nickname, #dashboard-square'
        )
        .first()
        .waitFor({ state: 'visible', timeout: waitMs }),
    ]).catch(() => {});
  }

  let lastEvalError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (page.isClosed()) {
      return { loggedIn: false, username: '', reason: 'Browser page was closed' };
    }
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      return await page.evaluate(() => {
        const href = window.location.href || '';
        if (href.includes('/login') || href.includes('accounts.binance.')) {
          return { loggedIn: false, username: '', reason: 'Redirected to Binance login page' };
        }

        if (
          /\/my\/dashboard/i.test(href) ||
          document.querySelector('#dashboard-userinfo-nickname, #dashboard-square')
        ) {
          const dashNick = (document.querySelector('#dashboard-userinfo-nickname')?.textContent || '').trim();
          return {
            loggedIn: false,
            username: dashNick,
            reason: 'Currently on Binance Dashboard (/my/dashboard) — redirecting to Square',
          };
        }

        const loggedOutSelectors: Array<[string, string]> = [
          ['[data-e2e="input-username"]', 'Login username input visible'],
          ['#password-input, [data-e2e="input-password"]', 'Login password input visible'],
          ['[data-e2e="input-mfa"], .mfa-verify-page', 'Login MFA verification visible'],
          ['div.css-132gffl button, .css-132gffl button', 'Square Login button (.css-132gffl) visible'],
          ['#header_login', 'Header Log In button visible'],
        ];
        for (const pair of loggedOutSelectors) {
          const el = document.querySelector(pair[0]);
          if (el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
              return { loggedIn: false, username: '', reason: pair[1] };
            }
          }
        }

        const loginButtons = document.querySelectorAll('a, button');
        for (let i = 0; i < loginButtons.length; i++) {
          const el = loginButtons[i];
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
            continue;
          }
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const linkHref = el.getAttribute('href') || '';
          if (/^(log\s*in|sign\s*in)$/i.test(text) || linkHref.includes('accounts.binance.')) {
            return { loggedIn: false, username: '', reason: 'Log In CTA visible' };
          }
        }

        const authSelectors = [
          '.user-info.nav-user-card',
          '.nav-user-card',
          '.style_Navbar__QQOOL .user-info',
          '#feed-nav-profile',
          '#feed-nav-notifications',
          '.news-post-button',
        ];
        let authElVisible = false;
        for (const sel of authSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
              authElVisible = true;
              break;
            }
          }
        }

        const handleEl = document.querySelector('.user-info-name .username, .user-info .username');
        const nicknameEl = document.querySelector('.user-info-name .nickname, .user-info .nickname');
        const handleText = (handleEl?.textContent || '').trim();
        const nicknameText = (nicknameEl?.textContent || '').trim();

        if (authElVisible || Boolean(handleText)) {
          return {
            loggedIn: true,
            username: handleText || nicknameText || 'authenticated-user',
            reason: 'Navbar user card (.user-info.nav-user-card) verified',
          };
        }

        return {
          loggedIn: false,
          username: '',
          reason: 'Navbar user card (.user-info.nav-user-card) not present',
        };
      });
    } catch (err) {
      lastEvalError = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && !page.isClosed()) {
        await page.waitForTimeout(800).catch(() => {});
      }
    }
  }

  return {
    loggedIn: false,
    username: '',
    reason: lastEvalError ? `Unable to inspect login state (${lastEvalError})` : 'Unable to inspect login state',
  };
}

async function ensureAuthenticatedOnSquare(params: {
  page: Page;
  context: BrowserContext;
  accountId: string;
  profileId: string;
  jobId: string;
  hasSavedCookies: boolean;
  allowGuestFallback?: boolean;
  guestOnly?: boolean;
}): Promise<Page> {
  const {
    page,
    context,
    accountId,
    profileId,
    jobId,
    hasSavedCookies,
    allowGuestFallback = false,
    guestOnly = false,
  } = params;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as {
    id: string;
    login_identifier: string;
    login_password_enc: string;
  };

  const loginUrls = [
    'https://accounts.binance.bh/en/login',
    'https://accounts.binance.com/en/login',
  ];
  const squareUrls = [
    'https://www.binance.bh/en/square',
    'https://www.binance.com/en/square',
  ];

  const username = account.login_identifier;
  const password = decryptSecret(account.login_password_enc);

  let activeSquarePage: Page = page;
  let authenticatedOrigin = '';

  if (guestOnly) {
    appendJobLog(
      jobId,
      'Guest Scrape Mode',
      'No comments required — opening Binance Square directly without requiring login.'
    );
    await gotoWithFallback(activeSquarePage, squareUrls, jobId, 'Open Square (No Login)');
    await handleCaptchaIfPresent(activeSquarePage, context, jobId, accountId);
    await dismissOnboardingPopupIfPresent(activeSquarePage, jobId);
    return activeSquarePage;
  }

  if (hasSavedCookies) {
    appendJobLog(jobId, 'Testing Saved Cookies', 'Opening Binance Square to verify active user card (.user-info.nav-user-card).');
    await gotoWithFallback(activeSquarePage, squareUrls, jobId, 'Testing Saved Cookies');
    await handleCaptchaIfPresent(activeSquarePage, context, jobId, accountId);

    const dashCookieState = await detectBinanceDashboardState(activeSquarePage);
    if (dashCookieState.onDashboard) {
      authenticatedOrigin = dashCookieState.origin || authenticatedOrigin;
      appendJobLog(
        jobId,
        'Dashboard Redirect',
        `Saved session landed on Binance Dashboard (${dashCookieState.origin || activeSquarePage.url()}) — redirecting to Square.`
      );
      activeSquarePage = await navigateDashboardToSquare({
        page: activeSquarePage,
        context,
        jobId,
        preferredOrigin: authenticatedOrigin,
      });
      await handleCaptchaIfPresent(activeSquarePage, context, jobId, accountId);
    }

    const cookieState = await checkSquareLoginState(activeSquarePage, { waitMs: 3500 });
    if (cookieState.loggedIn) {
      appendJobLog(
        jobId,
        'Session Reused',
        `Authenticated as ${cookieState.username} (${cookieState.reason}) — skipping email/password login.`
      );
      await dismissOnboardingPopupIfPresent(activeSquarePage, jobId);
      await persistProfileSession(context, profileId, accountId);
      return activeSquarePage;
    }

    appendJobLog(
      jobId,
      'Cookies Expired',
      `Saved cookies inactive (${cookieState.reason}) — clearing stale cookies and logging back in.`
    );
    await context.clearCookies().catch(() => {});
    db.prepare(`UPDATE browser_profiles SET cookies_json = '[]', health_status = 'expired' WHERE id = ?`).run(profileId);
  } else {
    appendJobLog(
      jobId,
      'Credential Login',
      'Preparing authenticated Binance session using account email and password.'
    );
  }

  if (!username || !password) {
    if (allowGuestFallback) {
      if (!activeSquarePage.url().includes('/square')) {
        await gotoWithFallback(activeSquarePage, squareUrls, jobId, 'Guest Square Access');
        await handleCaptchaIfPresent(activeSquarePage, context, jobId, accountId);
      }
      appendJobLog(
        jobId,
        'Guest Mode',
        'No credentials set and comment scraping is off — continuing in read-only post mode.'
      );
      return activeSquarePage;
    }
    const shot = await capturePageBase64(activeSquarePage);
    appendJobLog(jobId, 'Missing Credentials', 'Account email/phone and password are required when scraping with comments.', shot);
    throw new Error('Account login email/phone or password not configured in Accounts & Profiles.');
  }

  let loginPage: Page = activeSquarePage;

  if (!loginPage.url().includes('accounts.binance.') && !loginPage.url().includes('/login')) {
    const squareLoginBtn = activeSquarePage
      .locator(
        'div.css-132gffl button, .css-132gffl button, #header_login, button.bn-button:has-text("Login"), button:has-text("Log In")'
      )
      .first();

    if (await waitForVisible(squareLoginBtn, 2500)) {
      appendJobLog(
        jobId,
        'Square Login Trigger',
        'Clicking on-page Square Login button (.css-132gffl) and watching for a new login tab.'
      );
      const popupPromise = context.waitForEvent('page', { timeout: 6500 }).catch(() => null);
      await squareLoginBtn.scrollIntoViewIfNeeded().catch(() => {});
      await squareLoginBtn.click({ delay: randomInt(45, 115) });
      const maybeNewTab = await popupPromise;

      if (maybeNewTab) {
        loginPage = maybeNewTab;
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await loginPage.bringToFront().catch(() => {});
        appendJobLog(
          jobId,
          'Login Tab Opened',
          `Switched to newly opened login tab (${loginPage.url() || 'about:blank'}).`
        );
      } else {
        loginPage = activeSquarePage;
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        appendJobLog(
          jobId,
          'Login Navigation',
          'Login opened in the current tab without spawning a second tab.'
        );
      }
    } else {
      await gotoWithFallback(loginPage, loginUrls, jobId, 'Login Page');
    }

    await loginPage
      .locator(
        '[data-e2e="input-username"], input[name="username"], #password-input, input[type="password"], #captcha-container, .amzn-captcha-root'
      )
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {});
    await handleCaptchaIfPresent(loginPage, context, jobId, accountId);
  }

  throwIfJobAborted(jobId);

  // Step 1: Human-type email/phone into [data-e2e="input-username"] and click Log In
  const usernameInput = loginPage.locator('[data-e2e="input-username"], input[name="username"]').first();
  if (await waitForVisible(usernameInput, 8000)) {
    await humanType(loginPage, usernameInput, username);
    const submitEmailBtn = loginPage
      .locator('[data-e2e="btn-accounts-form-submit"], button[type="submit"], button:has-text("Next"), button:has-text("Continue")')
      .first();
    if (await waitForVisible(submitEmailBtn, 5000)) {
      await submitEmailBtn.click({ delay: randomInt(45, 115) });
      appendJobLog(jobId, 'Submit Identifier', `Typed account identifier (${username}) with human cadence and clicked Log In.`);
    }

    // Wait for Binance to transition off the email screen (captcha, password screen, passkey fallback, or MFA)
    await Promise.race([
      loginPage
        .locator(
          '#password-input, [data-e2e="input-password"], input[type="password"], input[name="password"], #captcha-container, .amzn-captcha-root, #amzn-captcha-verify-button, [data-e2e="input-mfa"], .mfa-verify-page, #stay-signed-checkbox, #dashboard-userinfo-nickname, button:has-text("Log in with password"), button:has-text("Use password")'
        )
        .first()
        .waitFor({ state: 'visible', timeout: 15000 }),
      loginPage.waitForURL(/\/(my\/dashboard|square)/i, { timeout: 15000 }),
    ]).catch(() => {});

    await humanPause(loginPage, 700, 1300);
    await handleCaptchaIfPresent(loginPage, context, jobId, accountId);
  }

  throwIfJobAborted(jobId);

  // If Binance presented a Passkey/alternative screen with "Log in with password" / "Use password", switch to password
  const passwordInput = loginPage
    .locator('#password-input, [data-e2e="input-password"], input[type="password"], input[name="password"]')
    .first();
  if (!loginPage.isClosed() && !(await waitForVisible(passwordInput, 1200))) {
    const usePasswordBtn = loginPage
      .locator('button:has-text("Log in with password"), button:has-text("Use password"), a:has-text("Use password")')
      .first();
    if (await waitForVisible(usePasswordBtn, 2000)) {
      await usePasswordBtn.click({ delay: randomInt(45, 110) }).catch(() => {});
      appendJobLog(jobId, 'Password Method', 'Selected password login option.');
    }
  }

  // Step 2: Wait for password page ("Enter your password"), human-type password, and click Continue
  const onLoginDomain =
    !loginPage.isClosed() &&
    (loginPage.url().includes('accounts.binance.') || loginPage.url().includes('/login'));
  if (!loginPage.isClosed() && (await waitForVisible(passwordInput, onLoginDomain ? 15000 : 2500))) {
    await humanType(loginPage, passwordInput, password);
    const submitPasswordBtn = loginPage
      .locator('[data-e2e="btn-accounts-form-submit"], button[type="submit"], button:has-text("Continue"), button:has-text("Log In")')
      .first();
    if (await waitForVisible(submitPasswordBtn, 5000)) {
      await submitPasswordBtn.click({ delay: randomInt(45, 115) });
      appendJobLog(jobId, 'Submit Password', 'Typed password with human cadence and clicked Continue.');
    }
    await humanPause(loginPage, 1400, 2400);
    await handleCaptchaIfPresent(loginPage, context, jobId, accountId);
  }

  throwIfJobAborted(jobId);

  // Wait briefly for post-password transition (Email Verification MFA, Stay Logged In, Captcha, Dashboard, or Square redirect)
  if (
    !loginPage.isClosed() &&
    (loginPage.url().includes('accounts.binance.') || loginPage.url().includes('/login'))
  ) {
    await Promise.race([
      loginPage.locator('[data-e2e="input-mfa"], .mfa-verify-page').first().waitFor({ state: 'visible', timeout: 14000 }),
      loginPage.locator('#stay-signed-checkbox').first().waitFor({ state: 'visible', timeout: 14000 }),
      loginPage
        .locator('#dashboard-userinfo-nickname, #dashboard-square, #ba-Square, .user-info.nav-user-card, #feed-nav-profile')
        .first()
        .waitFor({ state: 'visible', timeout: 14000 }),
      loginPage.waitForURL(/\/(my\/dashboard|square)/i, { timeout: 14000 }),
      loginPage.locator('#captcha-container, .amzn-captcha-root').first().waitFor({ state: 'visible', timeout: 14000 }),
      loginPage.waitForEvent('close', { timeout: 14000 }),
    ]).catch(() => {});
  }

  if (!loginPage.isClosed()) {
    await handleCaptchaIfPresent(loginPage, context, jobId, accountId);
  }

  // Step 3: Email Verification (.mfa-verify-page / [data-e2e="input-mfa"] / [data-e2e="btn-mfa-verify"])
  for (let mfaAttempt = 0; mfaAttempt < 3; mfaAttempt++) {
    throwIfJobAborted(jobId);
    if (loginPage.isClosed()) break;

    const mfaInput = loginPage.locator('[data-e2e="input-mfa"], .mfa-form-input input').first();
    if (!(await waitForVisible(mfaInput, mfaAttempt === 0 ? 4500 : 2500))) {
      break;
    }

    const shot = await capturePageBase64(loginPage);
    setJobStatus(
      jobId,
      'awaiting_mfa',
      mfaAttempt === 0
        ? 'Enter the 6-digit Email Verification code sent by Binance.'
        : 'Email Verification code is still required — enter the 6-digit code and submit.'
    );
    db.prepare(`UPDATE accounts SET status = 'challenge_required' WHERE id = ?`).run(accountId);
    appendJobLog(
      jobId,
      'Email Verification',
      'Email Verification page detected ([data-e2e="input-mfa"]). Waiting for 6-digit code from operator.',
      shot
    );

    const mfaCode = await new Promise<string>((resolve) => {
      activeChallenges.set(jobId, {
        page: loginPage,
        context,
        type: 'mfa',
        resolveMfa: resolve,
      });
    });
    activeChallenges.delete(jobId);

    if (!mfaCode || mfaCode === '__ABORT__') {
      throw new Error('Email verification aborted by operator.');
    }

    const cleanCode = mfaCode.trim();
    setJobStatus(jobId, 'running', '');
    await humanType(loginPage, mfaInput, cleanCode);
    const typedValue = await mfaInput.inputValue().catch(() => '');
    if (typedValue !== cleanCode) {
      await mfaInput.fill(cleanCode).catch(() => {});
    }
    appendJobLog(jobId, 'MFA Submitted', 'Entered 6-digit Email Verification code.');
    await humanPause(loginPage, 700, 1400);

    const submitMfaBtn = loginPage
      .locator('[data-e2e="btn-mfa-verify"], button.mfa-verify-buttonv2, button:has-text("Submit")')
      .first();
    if (await waitForVisible(submitMfaBtn, 3000)) {
      await submitMfaBtn.click({ delay: randomInt(45, 115) }).catch(() => {});
      appendJobLog(jobId, 'MFA Confirm Clicked', 'Clicked Email Verification Submit button ([data-e2e="btn-mfa-verify"]).');
    }

    await Promise.race([
      loginPage.waitForEvent('close', { timeout: 12000 }),
      loginPage.waitForURL(/\/(my\/dashboard|square)/i, { timeout: 12000 }),
      mfaInput.waitFor({ state: 'hidden', timeout: 12000 }),
      loginPage
        .locator('#stay-signed-checkbox, #dashboard-userinfo-nickname, #dashboard-square, #ba-Square, .user-info.nav-user-card')
        .first()
        .waitFor({ state: 'visible', timeout: 12000 }),
    ]).catch(() => {});

    if (!loginPage.isClosed()) {
      await handleCaptchaIfPresent(loginPage, context, jobId, accountId);
    }
  }

  throwIfJobAborted(jobId);

  // Step 4: Stay Logged In check (#stay-signed-checkbox + Yes button)
  if (!loginPage.isClosed()) {
    const staySignedCheckbox = loginPage.locator('#stay-signed-checkbox').first();
    if (await waitForVisible(staySignedCheckbox, 5000)) {
      const isChecked = await staySignedCheckbox.getAttribute('aria-checked');
      if (isChecked !== 'true') {
        await staySignedCheckbox.click({ delay: randomInt(45, 110) });
        appendJobLog(jobId, 'Stay Logged In', 'Checked "Don\'t show this message again on this device".');
        await humanPause(loginPage, 250, 550);
      }
      const yesBtn = loginPage.locator('button[aria-label="Yes"], button:has-text("Yes")').first();
      if (await waitForVisible(yesBtn, 2500)) {
        await yesBtn.click({ delay: randomInt(45, 110) });
        appendJobLog(jobId, 'Stay Logged In', 'Clicked Yes to persist device session for 5 days.');
      }
      await Promise.race([
        loginPage.waitForEvent('close', { timeout: 9000 }),
        loginPage.waitForURL(/\/(my\/dashboard|square)/i, { timeout: 9000 }),
        loginPage
          .locator('#dashboard-userinfo-nickname, #dashboard-square, #ba-Square, .user-info.nav-user-card')
          .first()
          .waitFor({ state: 'visible', timeout: 9000 }),
      ]).catch(() => {});
    }
  }

  throwIfJobAborted(jobId);

  // Allow any in-flight redirect from accounts.binance.* to /en/my/dashboard or /en/square to settle before reconciling tabs
  if (
    !loginPage.isClosed() &&
    (loginPage.url().includes('accounts.binance.') || loginPage.url().includes('/login'))
  ) {
    await Promise.race([
      loginPage.waitForEvent('close', { timeout: 8000 }),
      loginPage.waitForURL(/\/(my\/dashboard|square)/i, { timeout: 8000 }),
      loginPage
        .locator('#dashboard-userinfo-nickname, #dashboard-square, #ba-Square, .user-info.nav-user-card')
        .first()
        .waitFor({ state: 'visible', timeout: 8000 }),
    ]).catch(() => {});
  }

  // If still stuck on accounts.binance.*/login with an active input, abort early with diagnostic screenshot rather than abandoning login
  if (
    !loginPage.isClosed() &&
    (loginPage.url().includes('accounts.binance.') || loginPage.url().includes('/login'))
  ) {
    const stillOnAuthInput = await loginPage
      .locator('[data-e2e="input-username"], #password-input, [data-e2e="input-password"], [data-e2e="input-mfa"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stillOnAuthInput) {
      const shot = await capturePageBase64(loginPage);
      appendJobLog(
        jobId,
        'Login Blocked',
        `Login did not advance past ${loginPage.url()} — form input or challenge is still active.`,
        shot
      );
      throw new Error(`Binance login remained on authentication screen (${loginPage.url()}). Check credentials or verification prompt.`);
    }
  }

  if (!loginPage.isClosed()) {
    const loginOrigin = getPageOrigin(loginPage);
    if (loginOrigin.includes('www.binance.')) {
      authenticatedOrigin = loginOrigin;
    }
  }

  // Reconcile popup login tab back to active Square tab if a separate tab was opened
  if (loginPage !== activeSquarePage) {
    if (!loginPage.isClosed()) {
      const loginDash = await detectBinanceDashboardState(loginPage);
      if (loginDash.onDashboard) {
        authenticatedOrigin = loginDash.origin || authenticatedOrigin;
        appendJobLog(
          jobId,
          'Dashboard Reached',
          `Login tab landed on Binance Dashboard (${loginDash.origin || loginPage.url()}${loginDash.nickname ? `, ${loginDash.nickname}` : ''}) — persisting session and returning to Square.`
        );
        await persistProfileSession(context, profileId, accountId);
      } else {
        await loginPage.waitForTimeout(1200).catch(() => {});
      }
    }

    const reconciledSquareUrls = getOrderedSquareUrlsForOrigin(authenticatedOrigin || activeSquarePage.url());

    if (!activeSquarePage.isClosed()) {
      if (!loginPage.isClosed()) {
        await loginPage.close().catch(() => {});
        appendJobLog(jobId, 'Login Tab Closed', 'Closed login tab and returned to primary Square tab.');
      } else {
        appendJobLog(jobId, 'Returned to Square Tab', 'Login tab closed automatically after verification; returning to primary tab.');
      }
      await activeSquarePage.bringToFront().catch(() => {});
      if (activeSquarePage.url().includes('/square')) {
        if (authenticatedOrigin && !activeSquarePage.url().startsWith(authenticatedOrigin)) {
          await gotoWithFallback(activeSquarePage, reconciledSquareUrls, jobId, 'Open Square');
        } else {
          await activeSquarePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      } else {
        await gotoWithFallback(activeSquarePage, reconciledSquareUrls, jobId, 'Open Square');
      }
    } else if (!loginPage.isClosed()) {
      activeSquarePage = loginPage;
    }
  }

  // Step 5: Handle post-login Binance Dashboard (/en/my/dashboard) -> navigate to Binance Square
  const postLoginDash = await detectBinanceDashboardState(activeSquarePage);
  if (postLoginDash.onDashboard) {
    authenticatedOrigin = postLoginDash.origin || authenticatedOrigin;
    appendJobLog(
      jobId,
      'Dashboard Reached',
      `Authenticated login landed on Binance Dashboard (${postLoginDash.origin || activeSquarePage.url()}${postLoginDash.nickname ? `, ${postLoginDash.nickname}` : ''}) — saving session and opening Binance Square.`
    );
    await persistProfileSession(context, profileId, accountId);
    activeSquarePage = await navigateDashboardToSquare({
      page: activeSquarePage,
      context,
      jobId,
      preferredOrigin: authenticatedOrigin,
    });
  } else if (!activeSquarePage.url().includes('/square')) {
    const orderedSquareUrls = getOrderedSquareUrlsForOrigin(authenticatedOrigin || activeSquarePage.url());
    const squareLink = activeSquarePage.locator('#ba-Square').first();
    if (await waitForVisible(squareLink, 3500)) {
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await squareLink.click({ delay: randomInt(45, 110) }).catch(() => {});
      appendJobLog(jobId, 'Open Square', 'Clicked #ba-Square navigation item.');
      const maybeTab = await popupPromise;
      if (maybeTab) {
        await maybeTab.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await maybeTab.bringToFront().catch(() => {});
        if (!activeSquarePage.isClosed()) await activeSquarePage.close().catch(() => {});
        activeSquarePage = maybeTab;
      } else {
        await activeSquarePage.waitForURL(/\/square/i, { timeout: 8000 }).catch(() => {});
      }
    }
    if (!activeSquarePage.url().includes('/square')) {
      await gotoWithFallback(activeSquarePage, orderedSquareUrls, jobId, 'Open Square');
    }
  }

  await humanPause(activeSquarePage, 2000, 3000);

  // Step 6: Captcha check after Square load
  await handleCaptchaIfPresent(activeSquarePage, context, jobId, accountId);

  // Step 7: Skip onboarding popup
  await dismissOnboardingPopupIfPresent(activeSquarePage, jobId);

  // Step 8: Verify authenticated user card on Square navbar (.user-info.nav-user-card)
  const verifiedLogin = await checkSquareLoginState(activeSquarePage, { waitMs: 5000 });
  if (!verifiedLogin.loggedIn && !allowGuestFallback) {
    const shot = await capturePageBase64(activeSquarePage);
    appendJobLog(
      jobId,
      'Login Verification Failed',
      `Expected logged-in navbar card (.user-info.nav-user-card) on Square, got: ${verifiedLogin.reason}`,
      shot
    );
    throw new Error(`Unable to confirm authenticated Binance Square session (${verifiedLogin.reason}).`);
  }

  // Persist cookies & session state
  await persistProfileSession(context, profileId, accountId);
  appendJobLog(
    jobId,
    'Cookies Persisted',
    verifiedLogin.loggedIn
      ? `Verified logged-in user (${verifiedLogin.username}) and saved session cookies.`
      : 'Saved browser session state to profile.'
  );

  return activeSquarePage;
}

export function resolveActiveChallenge(
  jobId: string,
  payload: { mfaCode?: string; captchaAction?: { type: 'click' | 'confirm' | 'abort'; x?: number; y?: number } }
): boolean {
  const challenge = activeChallenges.get(jobId);
  if (!challenge) return false;
  if (challenge.type === 'mfa' && challenge.resolveMfa) {
    challenge.resolveMfa(payload.mfaCode || '__ABORT__');
    return true;
  }
  if (challenge.type === 'captcha' && challenge.resolveCaptcha && payload.captchaAction) {
    challenge.resolveCaptcha(payload.captchaAction);
    return true;
  }
  return false;
}

function getPageOrigin(page: Page): string {
  try {
    const u = new URL(page.url());
    if (/^https?:$/i.test(u.protocol) && u.host) {
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    // ignore malformed url
  }
  return 'https://www.binance.com';
}

function alignPostUrlToOrigin(postUrl: string, origin: string): string {
  try {
    const u = new URL(postUrl);
    const o = new URL(origin);
    if (o.host && o.host.includes('binance.')) {
      u.protocol = o.protocol;
      u.host = o.host;
    }
    return u.toString();
  } catch {
    return postUrl;
  }
}

async function scrapeCurrentPostDetailWithComments(
  page: Page,
  item: DiscoveredFeedLink,
  activeOrigin: string,
  includeComments: boolean
): Promise<{ post: ParsedSquarePost | null; loginLost: boolean }> {
  // Verify browser independently reached this post URL
  if (!page.url().includes(`/square/post/${item.id}`)) {
    await page.goto(item.postUrl, { waitUntil: 'load', timeout: 35000 }).catch(() => {});
  }

  // Wait for post detail body to mount
  await page
    .locator('#articleBody, .post-detail-content-block, .post-detail-article')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => {});

  if (!includeComments) {
    await page.waitForTimeout(450);
    const html = await page.content();
    const parsed = parseBinanceSquarePostDetailHtml(html, {
      postId: item.id,
      postUrl: item.postUrl,
      origin: activeOrigin,
      fallbackPost: item.previewPost,
    });
    const post = parsed?.post || item.previewPost || null;
    return {
      post: post ? { ...post, comments: [] } : null,
      loginLost: false,
    };
  }

  // Let initial client-side comment API fetch settle
  await page.waitForLoadState('networkidle', { timeout: 4500 }).catch(() => {});

  // Verify user is still logged in when scraping comments
  const postLoginState = await checkSquareLoginState(page, { waitMs: 2000 });
  if (!postLoginState.loggedIn) {
    return { post: null, loginLost: true };
  }

  // Scroll #comment / Replies tab / Virtuoso into viewport to trigger Binance lazy comment loading
  await page
    .evaluate(() => {
      const target =
        document.getElementById('comment') ||
        document.querySelector('[role="tablist"]') ||
        document.querySelector('[data-testid="virtuoso-item-list"]');
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } else {
        window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.45));
      }
    })
    .catch(() => {});

  // Explicitly wait up to 6s for either Virtuoso comment items or an explicit empty state
  await Promise.race([
    page
      .locator(
        '[data-testid="virtuoso-item-list"] [data-id], [data-testid="virtuoso-item-list"] [class*="FeedBuzzBaseViewRootBox"]'
      )
      .first()
      .waitFor({ state: 'visible', timeout: 6000 }),
    page
      .locator('text=/No comments|No replies|Be the first to/i')
      .first()
      .waitFor({ state: 'visible', timeout: 6000 }),
    page
      .locator('[role="tab"]:has-text("Replies 0")')
      .first()
      .waitFor({ state: 'visible', timeout: 6000 }),
  ]).catch(() => {});

  await page.waitForTimeout(600);

  const commentLoginPrompt = await page
    .locator('text=/Log in to view|Log in to comment|Sign in to view comments/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (commentLoginPrompt) {
    return { post: null, loginLost: true };
  }

  const initialHtml = await page.content();
  const initialParsed = parseBinanceSquarePostDetailHtml(initialHtml, {
    postId: item.id,
    postUrl: item.postUrl,
    origin: activeOrigin,
    fallbackPost: item.previewPost,
  });

  let latestPost: ParsedSquarePost | null = initialParsed?.post || item.previewPost || null;
  if (!latestPost) return { post: null, loginLost: false };

  let expectedRepliesCount = initialParsed?.expectedRepliesCount || 0;
  const commentMap = new Map<string, ParsedSquareComment>();
  for (const c of initialParsed?.post.comments || []) {
    commentMap.set(c.id, c);
  }

  let stagnantCommentScrolls = 0;
  const MAX_COMMENT_SCROLLS = 14;

  for (let pass = 0; pass < MAX_COMMENT_SCROLLS; pass++) {
    // Expand visible reply threads inside Virtuoso (NOTE: #comment is an empty sibling anchor div, buttons live in virtuoso-item-list)
    const expandButtons = page.locator(
      '[data-testid="virtuoso-item-list"] :is(button, a, div, span):text-is("Show More Replies"), [data-testid="virtuoso-item-list"] :is(button, a, div, span):text-is("View more replies"), [data-testid="virtuoso-item-list"] :is(button, a, div, span):text-is("View More Replies")'
    );
    const expandCount = Math.min(await expandButtons.count().catch(() => 0), 4);
    for (let i = 0; i < expandCount; i++) {
      const btn = expandButtons.nth(i);
      if (await waitForVisible(btn, 250)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ delay: randomInt(35, 90) }).catch(() => {});
        await page.waitForTimeout(650);
      }
    }

    const html = await page.content();
    const parsed = parseBinanceSquarePostDetailHtml(html, {
      postId: item.id,
      postUrl: item.postUrl,
      origin: activeOrigin,
      fallbackPost: latestPost,
    });

    const beforeCount = commentMap.size;
    if (parsed) {
      if (parsed.post.content && parsed.post.content.length >= latestPost.content.length) {
        latestPost = parsed.post;
      }
      if (parsed.expectedRepliesCount > expectedRepliesCount) {
        expectedRepliesCount = parsed.expectedRepliesCount;
      }
      for (const c of parsed.post.comments) {
        commentMap.set(c.id, c);
      }
    }

    if (expectedRepliesCount > 0 && commentMap.size >= expectedRepliesCount) {
      break;
    }

    if (commentMap.size > beforeCount) {
      stagnantCommentScrolls = 0;
    } else {
      stagnantCommentScrolls++;
    }

    const atBottom = await page
      .evaluate(() => {
        const prevY = window.scrollY;
        window.scrollBy(0, 560);
        const scroller = document.querySelector('[data-virtuoso-scroller="true"]');
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 20) {
          scroller.scrollTop += 560;
        }
        return (
          window.scrollY === prevY &&
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 40
        );
      })
      .catch(() => true);

    // If page explicitly reports 0 replies and no comments mounted after 2 passes, finish quickly
    if (expectedRepliesCount === 0 && commentMap.size === 0 && pass >= 1 && atBottom) {
      break;
    }
    // If replies ARE expected but still loading, allow up to 4 passes before breaking
    const requiredStagnant = expectedRepliesCount > 0 && commentMap.size === 0 ? 4 : 2;
    if (stagnantCommentScrolls >= requiredStagnant && atBottom) {
      break;
    }
    if (stagnantCommentScrolls >= 4) {
      break;
    }

    await page.waitForTimeout(randomInt(800, 1150));
  }

  return {
    post: {
      ...latestPost,
      comments: Array.from(commentMap.values()),
    },
    loginLost: false,
  };
}

export async function startScrapeJob(params: {
  accountId: string;
  feedTab: 'discover' | 'following' | 'news' | 'academy' | 'all';
  targetCount?: number;
  includeComments?: boolean;
  guestOnly?: boolean;
  allowPublisherMaster?: boolean;
  headless?: boolean;
}): Promise<string> {
  const account = db.prepare('SELECT id, role FROM accounts WHERE id = ?').get(params.accountId) as
    | { id: string; role: string }
    | undefined;
  if (!account) throw new Error('Account not found.');
  if (account.role !== 'scraper' && !params.allowPublisherMaster) {
    throw new Error('Role isolation violation: Scraping can only run on a dedicated scraper account.');
  }

  const targetLimit = Math.min(200, Math.max(1, Math.round(Number(params.targetCount) || 100)));
  const includeComments = params.includeComments !== false;
  const guestOnly = Boolean(params.guestOnly) || !includeComments;

  const jobId = `JOB-SCR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO automation_jobs (id, job_type, account_id, feed_tab, status, current_step, logs, created_at, updated_at)
    VALUES (?, 'scrape', ?, ?, 'running', 'Initializing', '[]', ?, ?)
  `).run(jobId, params.accountId, params.feedTab, now, now);

  void (async () => {
    let context: BrowserContext | null = null;
    try {
      const launched = await launchIsolatedContext(params.accountId, jobId, {
        headless: params.headless,
      });
      context = launched.context;
      let { page } = launched;
      const { profileId, hasSavedCookies } = launched;

      page = await ensureAuthenticatedOnSquare({
        page,
        context,
        accountId: params.accountId,
        profileId,
        jobId,
        hasSavedCookies,
        allowGuestFallback: !includeComments,
        guestOnly,
      });

      const MAX_PHASE1_SCROLLS = Math.max(25, Math.min(120, Math.ceil(targetLimit * 0.85) + 15));
      const MAX_STAGNANT_SCROLLS = 10;

      const tabLabelMap: Record<'discover' | 'following' | 'news' | 'academy', string> = {
        discover: 'Discover',
        following: 'Following',
        news: 'News',
        academy: 'Academy',
      };

      const tabsToScrape: Array<'discover' | 'following' | 'news' | 'academy'> =
        params.feedTab === 'all'
          ? ['discover', 'following', 'news', 'academy']
          : [params.feedTab];

      const { existingIds, existingHashes } = loadExistingSourceSignatures();
      const seenFeedIds = new Set<string>();
      const collectedQueue: Array<DiscoveredFeedLink & { feedTab: 'discover' | 'following' | 'news' | 'academy' }> = [];
      let totalDuplicatesSkipped = 0;

      // PHASE 1: Scroll feed and collect up to `targetLimit` unique unseen post URLs before visiting them independently
      appendJobLog(
        jobId,
        'Phase 1 · Collecting URLs',
        `Scrolling Binance Square (${params.feedTab}) to queue up to ${targetLimit} unique new post URLs.`
      );

      for (const activeTab of tabsToScrape) {
        throwIfJobAborted(jobId);
        if (collectedQueue.length >= targetLimit) break;

        const desiredTab = tabLabelMap[activeTab];
        if (desiredTab) {
          const tabEl = page
            .locator(`a:has-text("${desiredTab}"), button:has-text("${desiredTab}"), [role="tab"]:has-text("${desiredTab}")`)
            .first();
          if (await waitForVisible(tabEl, 3000)) {
            await tabEl.click({ delay: randomInt(40, 100) }).catch(() => {});
            await page.waitForTimeout(2000);
            appendJobLog(jobId, 'Feed Tab', `Switched Binance Square feed to ${desiredTab}.`);
          }
        }

        let stagnantScrolls = 0;
        const viewport = page.viewportSize() || { width: 1366, height: 860 };

        for (let step = 0; step < MAX_PHASE1_SCROLLS; step++) {
          throwIfJobAborted(jobId);
          if (collectedQueue.length >= targetLimit) break;

          const prevSeenSize = seenFeedIds.size;
          const prevQueueSize = collectedQueue.length;

          const activeOrigin = getPageOrigin(page);
          const html = await page.content();
          const discoveredLinks = parseBinanceSquareFeedLinks(html, activeOrigin);

          for (const link of discoveredLinks) {
            if (collectedQueue.length >= targetLimit) break;
            if (seenFeedIds.has(link.id)) continue;
            seenFeedIds.add(link.id);

            const isKnownId = existingIds.has(link.id);
            const isKnownContent = Boolean(
              link.previewPost?.content &&
                existingHashes.has(computePostContentHash(link.previewPost.content))
            );
            if (isKnownId || isKnownContent) {
              totalDuplicatesSkipped++;
              continue;
            }

            collectedQueue.push({ ...link, feedTab: activeTab });
          }

          const progressed = seenFeedIds.size > prevSeenSize || collectedQueue.length > prevQueueSize;
          if (progressed) {
            stagnantScrolls = 0;
          } else {
            stagnantScrolls++;
          }

          if (step === 0 || (step + 1) % 3 === 0 || collectedQueue.length - prevQueueSize >= 4) {
            appendJobLog(
              jobId,
              'Phase 1 · URLs',
              `[${desiredTab}] Scroll ${step + 1}: queued ${collectedQueue.length}/${targetLimit} unique post URLs (${totalDuplicatesSkipped} existing skipped).`
            );
          }

          if (collectedQueue.length >= targetLimit) {
            break;
          }

          if (stagnantScrolls >= MAX_STAGNANT_SCROLLS) {
            appendJobLog(
              jobId,
              'Phase 1 · Feed End',
              `[${desiredTab}] No additional post URLs loaded after ${MAX_STAGNANT_SCROLLS} scroll checks (${collectedQueue.length} URLs queued).`
            );
            break;
          }

          await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2)).catch(() => {});
          if (stagnantScrolls === 5) {
            await page.mouse.wheel(0, -450).catch(() => {});
            await page.waitForTimeout(450);
          }

          await page.mouse.wheel(0, randomInt(1150, 1650)).catch(() => {});
          await page
            .evaluate(() => {
              window.scrollBy(0, 1250);
              const cards = document.querySelectorAll('[class*="FeedBuzzBaseViewRootBox"], [data-id]');
              if (cards.length > 0) {
                cards[cards.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
              }
            })
            .catch(() => {});

          const loadMoreBtn = page
            .locator('button:has-text("Load more"), button:has-text("View more"), button:has-text("Show more")')
            .first();
          if (await waitForVisible(loadMoreBtn, 250)) {
            await loadMoreBtn.click({ delay: randomInt(40, 95) }).catch(() => {});
          }

          await page.waitForTimeout(randomInt(1250, 1850));
        }
      }

      appendJobLog(
        jobId,
        'Phase 1 Complete',
        `Collected ${collectedQueue.length} unique new post URLs (${totalDuplicatesSkipped} duplicates skipped). Starting Phase 2 independent post scraping (${includeComments ? 'with comments + session guard' : 'posts only'}).`
      );

      // PHASE 2: Visit each collected post URL independently and scrape full post (+ comments if enabled) into one file per post
      let totalNewSaved = 0;
      let totalCommentsSaved = 0;

      for (let idx = 0; idx < collectedQueue.length; idx++) {
        throwIfJobAborted(jobId);
        const item = collectedQueue[idx];
        try {
          let targetOrigin = getPageOrigin(page);
          let targetPostUrl = alignPostUrlToOrigin(item.postUrl, targetOrigin);
          item.postUrl = targetPostUrl;

          appendJobLog(
            jobId,
            'Phase 2 · Loading',
            `(${idx + 1}/${collectedQueue.length}) Opening post independently: ${targetPostUrl}`
          );

          await gotoWithRetry(page, targetPostUrl, 45000, 3);
          await handleCaptchaIfPresent(page, context, jobId, params.accountId);

          if (includeComments) {
            const preCheck = await checkSquareLoginState(page, { waitMs: 2500 });
            if (!preCheck.loggedIn) {
              appendJobLog(
                jobId,
                'Session Logged Out',
                `(${idx + 1}/${collectedQueue.length}) Detected logged-out state (${preCheck.reason}) while scraping with comments — re-logging in before continuing.`
              );
              page = await ensureAuthenticatedOnSquare({
                page,
                context,
                accountId: params.accountId,
                profileId,
                jobId,
                hasSavedCookies: false,
                allowGuestFallback: false,
              });
              targetOrigin = getPageOrigin(page);
              targetPostUrl = alignPostUrlToOrigin(item.postUrl, targetOrigin);
              item.postUrl = targetPostUrl;
              await gotoWithRetry(page, targetPostUrl, 45000, 3);
              await handleCaptchaIfPresent(page, context, jobId, params.accountId);
            }
          }

          let activeOrigin = getPageOrigin(page);
          let detailResult = await scrapeCurrentPostDetailWithComments(
            page,
            item,
            activeOrigin,
            includeComments
          );

          if (includeComments && detailResult.loginLost) {
            appendJobLog(
              jobId,
              'Session Logged Out',
              `(${idx + 1}/${collectedQueue.length}) Session logged out before comments loaded — re-authenticating and retrying post ${item.id}.`
            );
            page = await ensureAuthenticatedOnSquare({
              page,
              context,
              accountId: params.accountId,
              profileId,
              jobId,
              hasSavedCookies: false,
              allowGuestFallback: false,
            });
            targetOrigin = getPageOrigin(page);
            targetPostUrl = alignPostUrlToOrigin(item.postUrl, targetOrigin);
            item.postUrl = targetPostUrl;
            await gotoWithRetry(page, targetPostUrl, 45000, 3);
            await handleCaptchaIfPresent(page, context, jobId, params.accountId);
            activeOrigin = getPageOrigin(page);
            detailResult = await scrapeCurrentPostDetailWithComments(
              page,
              item,
              activeOrigin,
              includeComments
            );
          }

          const detailPost = detailResult.post;
          if (!detailPost || !detailPost.content) {
            appendJobLog(
              jobId,
              'Phase 2 · Skipped',
              `(${idx + 1}/${collectedQueue.length}) Unable to extract body from ${item.postUrl}; skipping.`
            );
            continue;
          }

          const { insertedCount, skippedCount } = insertUniqueSourcePosts([detailPost], {
            sourceType: 'playwright',
            feedTab: item.feedTab,
            existingIds,
            existingHashes,
          });

          if (insertedCount > 0) {
            totalNewSaved += insertedCount;
            totalCommentsSaved += detailPost.comments.length;
            appendJobLog(
              jobId,
              'Phase 2 · Saved',
              `(${idx + 1}/${collectedQueue.length}) Saved post ${detailPost.id} + ${detailPost.comments.length} comment(s) -> data/scraped_posts/${detailPost.id}.json`
            );
          } else {
            totalDuplicatesSkipped += skippedCount;
          }

          if ((idx + 1) % 10 === 0) {
            await persistProfileSession(context, profileId, params.accountId);
          }
        } catch (postErr) {
          if (abortedJobIds.has(jobId)) {
            throw postErr;
          }
          const errMsg = postErr instanceof Error ? postErr.message : String(postErr);
          appendJobLog(
            jobId,
            'Phase 2 · Warning',
            `(${idx + 1}/${collectedQueue.length}) Error scraping ${item.postUrl}: ${errMsg}`
          );
        }

        throwIfJobAborted(jobId);
        await humanPause(page, 450, 900);
      }

      await persistProfileSession(context, profileId, params.accountId);
      const finalShot = await capturePageBase64(page);
      appendJobLog(
        jobId,
        'Completed',
        `Saved ${totalNewSaved} new unique Binance Square posts (${includeComments ? `${totalCommentsSaved} comment(s) included` : 'posts only'}) into individual post files (${totalDuplicatesSkipped} duplicate posts skipped).`,
        finalShot
      );
      setJobStatus(jobId, 'completed');
    } catch (err) {
      if (!abortedJobIds.has(jobId)) {
        const msg = err instanceof Error ? err.message : 'Scrape job failed';
        appendJobLog(jobId, 'Failed', msg);
        setJobStatus(jobId, 'failed', msg);
        db.prepare(`UPDATE browser_profiles SET health_status = 'error' WHERE account_id = ?`).run(params.accountId);
      }
    } finally {
      abortedJobIds.delete(jobId);
      if (context) await context.close().catch(() => {});
    }
  })();

  return jobId;
}

const BINANCE_SQUARE_OPENAPI_URLS = [
  'https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add',
  'https://www.binance.bh/bapi/composite/v1/public/pgc/openApi/content/add',
];

function formatFetchErrorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err || 'Unknown network error');
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    const parts = [cause.code, cause.message].filter(Boolean);
    if (parts.length > 0) return `${err.message} (${parts.join(': ')})`;
  }
  return err.message;
}

function mapSquareOpenApiError(code: string | undefined, message: string | null | undefined, httpStatus: number): string {
  switch (code) {
    case '20002':
    case '20022':
      return `Binance Square rejected post due to sensitive/prohibited words (${code}${message ? `: ${message}` : ''}).`;
    case '220003':
      return 'Binance Square Creator OpenAPI Key not found or invalid (220003). Check the key in Account settings.';
    case '220004':
      return 'Binance Square Creator OpenAPI Key has expired (220004). Generate a new Creator API key on Binance Square.';
    case '220009':
      return 'Daily Binance Square Creator OpenAPI post limit exceeded (220009). Try again tomorrow or remove the API key to publish via browser.';
    case '220011':
      return 'Binance Square OpenAPI rejected empty post body (220011).';
    default:
      return message
        ? `Binance Square OpenAPI error${code ? ` (${code})` : ''}: ${message}`
        : `Binance Square OpenAPI request failed (HTTP ${httpStatus}${code ? `, code ${code}` : ''}).`;
  }
}

async function publishDraftViaSquareOpenApi(params: {
  draft: { id: string; content: string; media_paths: string };
  accountId: string;
  accountLabel: string;
  apiKey: string;
  jobId: string;
}): Promise<void> {
  const { draft, accountId, accountLabel, apiKey, jobId } = params;
  let lastHttpStatus = 500;
  let lastApiCode = '';

  try {
    const bodyTextOnly = (draft.content || '').trim();
    if (!bodyTextOnly) {
      throw new Error('Article content cannot be empty when publishing via Binance Square Creator OpenAPI.');
    }

    appendJobLog(
      jobId,
      'Creator OpenAPI',
      `Using saved Binance Square Creator OpenAPI Key on ${accountLabel} — skipping browser login.`
    );

    const mediaPaths = JSON.parse(draft.media_paths || '[]') as string[];
    if (Array.isArray(mediaPaths) && mediaPaths.length > 0) {
      appendJobLog(
        jobId,
        'OpenAPI Note',
        `Draft includes ${mediaPaths.length} media path(s); Binance Square Creator OpenAPI content/add posts text-only content (bodyTextOnly).`
      );
    }

    throwIfJobAborted(jobId);
    appendJobLog(
      jobId,
      'API Request',
      `Dispatching article ${draft.id} (${bodyTextOnly.length} chars) to Binance Square Creator OpenAPI...`
    );

    let response: Response | null = null;
    let lastNetErr: unknown = null;
    for (let i = 0; i < BINANCE_SQUARE_OPENAPI_URLS.length; i++) {
      const endpoint = BINANCE_SQUARE_OPENAPI_URLS[i];
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'X-Square-OpenAPI-Key': apiKey,
            'Content-Type': 'application/json',
            clienttype: 'binanceSkill',
          },
          body: JSON.stringify({ bodyTextOnly }),
          signal: AbortSignal.timeout(25000),
        });
        break;
      } catch (netErr) {
        lastNetErr = netErr;
        if (i < BINANCE_SQUARE_OPENAPI_URLS.length - 1) {
          appendJobLog(
            jobId,
            'Endpoint Fallback',
            `OpenAPI request to ${new URL(endpoint).host} failed (${formatFetchErrorDetail(netErr)}); trying ${new URL(BINANCE_SQUARE_OPENAPI_URLS[i + 1]).host}...`
          );
        }
      }
    }

    if (!response) {
      throw new Error(formatFetchErrorDetail(lastNetErr));
    }

    lastHttpStatus = response.status;
    const rawBody = await response.text().catch(() => '');
    type SquareOpenApiResponse = {
      code?: string;
      message?: string | null;
      data?: { id?: string | number } | null;
    };
    let parsed: SquareOpenApiResponse | null = null;
    try {
      parsed = rawBody ? (JSON.parse(rawBody) as SquareOpenApiResponse) : null;
    } catch {
      parsed = null;
    }

    lastApiCode = parsed?.code ? String(parsed.code) : '';

    if (!response.ok || lastApiCode !== '000000') {
      throw new Error(mapSquareOpenApiError(lastApiCode || undefined, parsed?.message, lastHttpStatus));
    }

    const rawPostId = parsed?.data?.id !== undefined && parsed?.data?.id !== null ? String(parsed.data.id).trim() : '';
    const postId = rawPostId || `SQ-${Date.now()}`;
    const postUrl = rawPostId ? `https://www.binance.com/square/post/${rawPostId}` : '';
    const publishedAt = new Date().toISOString();

    db.prepare(`
      UPDATE drafts SET status = 'published', published_at = ?, binance_post_id = ? WHERE id = ?
    `).run(publishedAt, postId, draft.id);

    db.prepare(`
      INSERT INTO publish_log (draft_id, account_id, method, http_status, response_body, published_at)
      VALUES (?, ?, 'square_openapi', ?, ?, ?)
    `).run(
      draft.id,
      accountId,
      lastHttpStatus || 200,
      JSON.stringify({
        ok: true,
        jobId,
        code: lastApiCode,
        binance_post_id: postId,
        ...(postUrl ? { post_url: postUrl } : {}),
      }),
      publishedAt
    );

    appendJobLog(
      jobId,
      'Published',
      postUrl
        ? `Article ${draft.id} published via Binance Square Creator OpenAPI (Post ID: ${postId} · ${postUrl}).`
        : `Article ${draft.id} published via Binance Square Creator OpenAPI (Post ID: ${postId}).`
    );
    setJobStatus(jobId, 'completed');
  } catch (err) {
    if (!abortedJobIds.has(jobId)) {
      const msg = err instanceof Error ? err.message : 'Binance Square Creator OpenAPI publish failed';
      db.prepare(`UPDATE drafts SET status = 'failed' WHERE id = ?`).run(draft.id);
      db.prepare(`
        INSERT INTO publish_log (draft_id, account_id, method, http_status, response_body, published_at)
        VALUES (?, ?, 'square_openapi', ?, ?, ?)
      `).run(
        draft.id,
        accountId,
        lastHttpStatus || 500,
        JSON.stringify({
          ok: false,
          jobId,
          ...(lastApiCode ? { code: lastApiCode } : {}),
          error: msg,
        }),
        new Date().toISOString()
      );
      appendJobLog(jobId, 'Failed', msg);
      setJobStatus(jobId, 'failed', msg);
    }
  } finally {
    abortedJobIds.delete(jobId);
  }
}

export async function startPublishJob(
  draftId: string,
  overrideAccountId?: string
): Promise<{ jobId: string; method: 'square_openapi' | 'playwright_ui' }> {
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId) as {
    id: string;
    persona_id: string;
    title: string;
    content: string;
    media_paths: string;
    status: string;
  } | undefined;
  if (!draft) throw new Error(`Draft ${draftId} not found.`);

  let targetAccountId = (overrideAccountId || '').trim();
  if (!targetAccountId) {
    const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(draft.persona_id) as {
      id: string;
      account_id: string;
      display_name: string;
    } | undefined;
    if (!persona || !persona.account_id) {
      throw new Error(`Persona ${draft.persona_id} is not linked to a publishing account.`);
    }
    targetAccountId = persona.account_id;
  }

  const account = db
    .prepare('SELECT id, role, label, binance_square_api_key_enc FROM accounts WHERE id = ?')
    .get(targetAccountId) as
    | {
        id: string;
        role: string;
        label: string;
        binance_square_api_key_enc?: string;
      }
    | undefined;
  if (!account || account.role !== 'publisher') {
    throw new Error('Role isolation violation: Publishing requires a dedicated publisher account.');
  }

  const creatorApiKey = account.binance_square_api_key_enc
    ? decryptSecret(account.binance_square_api_key_enc).trim()
    : '';
  const method: 'square_openapi' | 'playwright_ui' = creatorApiKey ? 'square_openapi' : 'playwright_ui';

  const jobId = `JOB-PUB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO automation_jobs (id, job_type, account_id, draft_id, status, current_step, logs, created_at, updated_at)
    VALUES (?, 'publish', ?, ?, 'running', 'Initializing', '[]', ?, ?)
  `).run(jobId, account.id, draft.id, now, now);

  db.prepare(`UPDATE drafts SET status = 'publishing' WHERE id = ?`).run(draft.id);

  if (creatorApiKey) {
    void publishDraftViaSquareOpenApi({
      draft,
      accountId: account.id,
      accountLabel: account.label,
      apiKey: creatorApiKey,
      jobId,
    });
    return { jobId, method };
  }

  appendJobLog(
    jobId,
    'Browser Fallback',
    `No Binance Square Creator OpenAPI Key configured on ${account.label} — launching Playwright browser login & publish flow.`
  );

  void (async () => {
    let context: BrowserContext | null = null;
    try {
      const launched = await launchIsolatedContext(account.id, jobId);
      context = launched.context;
      let { page } = launched;
      const { profileId, hasSavedCookies } = launched;

      throwIfJobAborted(jobId);
      page = await ensureAuthenticatedOnSquare({
        page,
        context,
        accountId: account.id,
        profileId,
        jobId,
        hasSavedCookies,
        allowGuestFallback: false,
      });
      throwIfJobAborted(jobId);

      // Ensure login stays true throughout composing, clicking Post, and confirming publish
      let publishCompleted = false;
      const MAX_PUBLISH_ATTEMPTS = 2;

      for (let publishAttempt = 1; publishAttempt <= MAX_PUBLISH_ATTEMPTS; publishAttempt++) {
        throwIfJobAborted(jobId);

        // 1. Pre-composer login check: if logged out, log back in first
        const preComposeAuth = await checkSquareLoginState(page, { waitMs: 1800 });
        if (!preComposeAuth.loggedIn) {
          appendJobLog(
            jobId,
            'Session Logged Out',
            `Detected logged-out state before composing (${preComposeAuth.reason}) — logging back in before publishing.`
          );
          page = await ensureAuthenticatedOnSquare({
            page,
            context,
            accountId: account.id,
            profileId,
            jobId,
            hasSavedCookies: false,
            allowGuestFallback: false,
          });
          throwIfJobAborted(jobId);
        }

        // Feature 3: Locate Square composer box, human-type article content, click Post button and confirm publish
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        const composer = page
          .locator(
            '.short-editor-inner .tiptap.ProseMirror[contenteditable="true"], .short-editor-inner [contenteditable="true"][role="textbox"], .tiptap.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[placeholder*="Share"], textarea[placeholder*="thoughts"]'
          )
          .first();

        if (!(await waitForVisible(composer, 10000))) {
          const authOnMissingComposer = await checkSquareLoginState(page, { waitMs: 1500 });
          if (!authOnMissingComposer.loggedIn) {
            appendJobLog(
              jobId,
              'Session Logged Out',
              `Composer unavailable because account is logged out (${authOnMissingComposer.reason}) — logging back in.`
            );
            page = await ensureAuthenticatedOnSquare({
              page,
              context,
              accountId: account.id,
              profileId,
              jobId,
              hasSavedCookies: false,
              allowGuestFallback: false,
            });
            await composer.waitFor({ state: 'visible', timeout: 20000 });
          } else {
            await composer.waitFor({ state: 'visible', timeout: 15000 });
          }
        }

        await humanType(page, composer, draft.content, {
          minDelayMs: 14,
          maxDelayMs: 36,
          pauseEvery: 45,
          pauseMinMs: 90,
          pauseMaxMs: 210,
        });
        throwIfJobAborted(jobId);

        // Verify composer actually retained the typed article (fallback insertText if Tiptap missed initial focus)
        const expectedSnippet = draft.content.replace(/\s+/g, ' ').trim().slice(0, 24);
        const typedNow = (
          (await composer.inputValue().catch(() => '')) ||
          (await composer.innerText().catch(() => ''))
        )
          .replace(/\s+/g, ' ')
          .trim();
        if (!typedNow || (expectedSnippet && !typedNow.includes(expectedSnippet.slice(0, 12)))) {
          await composer.click({ delay: randomInt(40, 90) }).catch(() => {});
          await page.keyboard.insertText(draft.content).catch(() => {});
          await humanPause(page, 300, 600);
        }

        appendJobLog(jobId, 'Composer Filled', `Typed article ${draft.id} (${draft.content.length} chars) into Binance Square composer.`);

        // Attach images if configured
        const mediaPaths = JSON.parse(draft.media_paths || '[]') as string[];
        if (mediaPaths.length > 0) {
          const fileInput = page
            .locator('#shortPostEditorImageUploaderBox input[type="file"], .short-editor-inner input[type="file"], input[type="file"]')
            .first();
          if ((await fileInput.count()) > 0) {
            await fileInput.setInputFiles(mediaPaths.slice(0, 4)).catch(() => {});
            await page.waitForTimeout(1500);
            appendJobLog(jobId, 'Media Attached', `Attached ${Math.min(mediaPaths.length, 4)} media file(s).`);
          }
        }

        throwIfJobAborted(jobId);

        // 2. Pre-Post login check: ensure account was not logged out while typing
        const prePostAuth = await checkSquareLoginState(page, { waitMs: 1200 });
        if (!prePostAuth.loggedIn) {
          if (publishAttempt < MAX_PUBLISH_ATTEMPTS) {
            appendJobLog(
              jobId,
              'Session Logged Out',
              `Detected logged-out state before clicking Post (${prePostAuth.reason}) — logging back in and retrying publish.`
            );
            page = await ensureAuthenticatedOnSquare({
              page,
              context,
              accountId: account.id,
              profileId,
              jobId,
              hasSavedCookies: false,
              allowGuestFallback: false,
            });
            continue;
          }
          throw new Error(`Account logged out before clicking Post (${prePostAuth.reason}).`);
        }

        // Resolve the exact Post button inside the Square editor
        const postBtnSelectors = [
          '.short-editor-inner div.css-1f466lo button[data-bn-type="button"]',
          '.short-editor-inner button[data-bn-type="button"]:has(span[data-bn-type="text"]:text-is("Post"))',
          '.short-editor-inner button:has(span:text-is("Post"))',
          'div.css-1f466lo button[data-bn-type="button"]:has-text("Post")',
          'div.css-1f466lo button',
          'button[data-bn-type="button"]:has(span:text-is("Post"))',
          'button:text-is("Post")',
        ];
        let postBtn = page.locator(postBtnSelectors[0]).first();
        for (const sel of postBtnSelectors) {
          const candidate = page.locator(sel).first();
          if (await waitForVisible(candidate, sel === postBtnSelectors[0] ? 4000 : 1000)) {
            postBtn = candidate;
            break;
          }
        }

        await postBtn.waitFor({ state: 'visible', timeout: 10000 });
        await postBtn.scrollIntoViewIfNeeded().catch(() => {});

        // Wait briefly for Tiptap/React state to enable the Post button after typing
        for (let waitEnable = 0; waitEnable < 10; waitEnable++) {
          const disabledState = await postBtn
            .evaluate((el) => {
              const btn = el as HTMLButtonElement;
              const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
              const style = window.getComputedStyle(el);
              return Boolean(btn.disabled || ariaDisabled || style.pointerEvents === 'none');
            })
            .catch(() => false);
          if (!disabledState) break;
          await page.waitForTimeout(350);
        }

        const preSubmitError = (
          await page
            .locator('.short-editor-inner .short-post-editor-error-msg-panel, .short-post-editor-error-msg-panel')
            .first()
            .innerText()
            .catch(() => '')
        ).trim();
        if (preSubmitError) {
          const errShot = await capturePageBase64(page);
          appendJobLog(jobId, 'Editor Warning', `Binance Square editor error: ${preSubmitError}`, errShot);
          throw new Error(`Binance Square editor error: ${preSubmitError}`);
        }

        // Listen for Square publish POST API response as an extra confirmation signal
        let apiPublishSucceeded = false;
        let apiPublishError = '';
        let apiAuthExpired = false;
        const onPublishResponse = async (res: import('playwright').Response) => {
          try {
            const req = res.request();
            if (req.method() !== 'POST') return;
            const url = res.url();
            if (!/binance\.(com|bh)\/bapi\//i.test(url)) return;
            if (!/(post|short|content|article|publish|create|pgc)/i.test(url)) return;
            if (res.status() === 401 || res.status() === 403) {
              apiAuthExpired = true;
            }
            const bodyText = await res.text().catch(() => '');
            if (!bodyText) return;
            const parsed = JSON.parse(bodyText) as { success?: boolean; code?: string; message?: string };
            if (res.ok() && (parsed.success === true || parsed.code === '000000')) {
              apiPublishSucceeded = true;
            } else if (parsed.message && parsed.success === false) {
              apiPublishError = parsed.message;
              if (/log\s*in|sign\s*in|unauthoriz|session|expired|token/i.test(parsed.message)) {
                apiAuthExpired = true;
              }
            }
          } catch {
            // Ignore non-JSON responses
          }
        };
        page.on('response', onPublishResponse);

        let needsReloginRetry = false;
        let reloginReason = '';

        try {
          await humanPause(page, 400, 750);
          throwIfJobAborted(jobId);

          await postBtn.click({ delay: randomInt(50, 120) });
          appendJobLog(jobId, 'Publish Triggered', 'Clicked Square Post button.');

          // 3. Wait & verify submission took effect; check login continuously and retry clicking Post if needed
          let publishConfirmed = false;
          let clickAttempts = 1;
          const waitStart = Date.now();
          const maxWaitMs = 9500;

          while (Date.now() - waitStart < maxWaitMs) {
            throwIfJobAborted(jobId);
            await page.waitForTimeout(750);

            await handleCaptchaIfPresent(page, context, jobId, account.id);

            const duringSubmitAuth = await checkSquareLoginState(page, { waitMs: 0 });
            if (!duringSubmitAuth.loggedIn || apiAuthExpired) {
              needsReloginRetry = true;
              reloginReason = apiAuthExpired
                ? `Publish API auth error (${apiPublishError || 'HTTP 401/403'})`
                : duringSubmitAuth.reason;
              break;
            }

            const editorErr = (
              await page
                .locator('.short-editor-inner .short-post-editor-error-msg-panel, .short-post-editor-error-msg-panel')
                .first()
                .innerText()
                .catch(() => '')
            ).trim();
            if (editorErr) {
              if (/log\s*in|sign\s*in|unauthoriz|session|expired/i.test(editorErr)) {
                needsReloginRetry = true;
                reloginReason = editorErr;
                break;
              }
              const errShot = await capturePageBase64(page);
              appendJobLog(jobId, 'Publish Rejected', `Binance Square returned error: ${editorErr}`, errShot);
              throw new Error(`Binance Square rejected post: ${editorErr}`);
            }

            if (apiPublishError) {
              const errShot = await capturePageBase64(page);
              appendJobLog(jobId, 'Publish Rejected', `Binance Square API error: ${apiPublishError}`, errShot);
              throw new Error(`Binance Square rejected post: ${apiPublishError}`);
            }

            const currentText = (
              (await composer.inputValue().catch(() => '')) ||
              (await composer.innerText().catch(() => ''))
            )
              .replace(/\s+/g, ' ')
              .trim();
            const stillHasArticle = Boolean(expectedSnippet && currentText.includes(expectedSnippet.slice(0, 12)));
            const postBtnStillVisible = await postBtn.isVisible().catch(() => false);
            const composerCleared = !stillHasArticle;

            const successToastVisible = await page
              .locator('text=/Published|Post successful|Posted successfully|Submitted successfully/i')
              .first()
              .isVisible()
              .catch(() => false);

            if (
              (apiPublishSucceeded || successToastVisible || composerCleared || !postBtnStillVisible) &&
              duringSubmitAuth.loggedIn
            ) {
              publishConfirmed = true;
              break;
            }

            // If after ~2.2s the article is still sitting untouched and Post button is still clickable, retry clicking Post
            const elapsed = Date.now() - waitStart;
            if (stillHasArticle && postBtnStillVisible && elapsed >= 2200 * clickAttempts && clickAttempts < 3) {
              clickAttempts++;
              const postTextSpan = postBtn.locator('span[data-bn-type="text"], span:text-is("Post")').first();
              if (clickAttempts === 2 && (await postTextSpan.isVisible().catch(() => false))) {
                await postTextSpan.click({ force: true, delay: randomInt(45, 100) }).catch(() => {});
              } else {
                await postBtn.click({ force: true, delay: randomInt(45, 100) }).catch(async () => {
                  await postBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
                });
              }
              appendJobLog(
                jobId,
                'Publish Retry',
                `Post button still present with draft text in editor — re-clicked Post button (attempt ${clickAttempts}).`
              );
            }
          }

          if (!needsReloginRetry) {
            // 4. Wait a few extra seconds after publish confirmation/click so Binance finishes publishing and check login stays true
            appendJobLog(jobId, 'Waiting Confirm', 'Waiting a few seconds for Binance Square publish to complete...');
            await page.waitForTimeout(4500);

            const postWaitAuth = await checkSquareLoginState(page, { waitMs: 1200 });
            if (!postWaitAuth.loggedIn || apiAuthExpired) {
              needsReloginRetry = true;
              reloginReason = apiAuthExpired
                ? `Publish API auth error (${apiPublishError || 'HTTP 401/403'})`
                : postWaitAuth.reason;
            } else {
              const postWaitErr = (
                await page
                  .locator('.short-editor-inner .short-post-editor-error-msg-panel, .short-post-editor-error-msg-panel')
                  .first()
                  .innerText()
                  .catch(() => '')
              ).trim();
              if (postWaitErr) {
                if (/log\s*in|sign\s*in|unauthoriz|session|expired/i.test(postWaitErr)) {
                  needsReloginRetry = true;
                  reloginReason = postWaitErr;
                } else {
                  const errShot = await capturePageBase64(page);
                  appendJobLog(jobId, 'Publish Rejected', `Binance Square returned error: ${postWaitErr}`, errShot);
                  throw new Error(`Binance Square rejected post: ${postWaitErr}`);
                }
              }

              if (!needsReloginRetry && !publishConfirmed) {
                const finalEditorText = (
                  (await composer.inputValue().catch(() => '')) ||
                  (await composer.innerText().catch(() => ''))
                )
                  .replace(/\s+/g, ' ')
                  .trim();
                const finalPostBtnVisible = await postBtn.isVisible().catch(() => false);
                if (
                  expectedSnippet &&
                  finalEditorText.includes(expectedSnippet.slice(0, 12)) &&
                  finalPostBtnVisible &&
                  !apiPublishSucceeded
                ) {
                  const errShot = await capturePageBase64(page);
                  appendJobLog(
                    jobId,
                    'Publish Unconfirmed',
                    'Post button was clicked, but the article text remained unsubmitted inside the composer.',
                    errShot
                  );
                  throw new Error('Post button clicked, but Binance Square composer did not clear or confirm submission.');
                }
              }

              if (!needsReloginRetry) {
                appendJobLog(
                  jobId,
                  'Publish Confirmed',
                  apiPublishSucceeded
                    ? `Binance Square API confirmed article publish while authenticated as ${postWaitAuth.username}.`
                    : `Composer cleared and authenticated session (${postWaitAuth.username}) verified after post-publish wait.`
                );
                publishCompleted = true;
                break;
              }
            }
          }
        } finally {
          page.off('response', onPublishResponse);
        }

        if (needsReloginRetry) {
          if (publishAttempt < MAX_PUBLISH_ATTEMPTS) {
            appendJobLog(
              jobId,
              'Session Logged Out',
              `Account logged out during publish (${reloginReason}) — logging back in and retrying submission.`
            );
            page = await ensureAuthenticatedOnSquare({
              page,
              context,
              accountId: account.id,
              profileId,
              jobId,
              hasSavedCookies: false,
              allowGuestFallback: false,
            });
            continue;
          }
          const errShot = await capturePageBase64(page);
          appendJobLog(
            jobId,
            'Session Lost',
            `Account logged out during publish (${reloginReason}) after re-login retry.`,
            errShot
          );
          throw new Error(`Account logged out during publish (${reloginReason}).`);
        }
      }

      if (!publishCompleted) {
        throw new Error('Unable to complete Binance Square publish while maintaining an authenticated session.');
      }

      await persistProfileSession(context, profileId, account.id);

      const publishedAt = new Date().toISOString();
      const syntheticPostId = `SQ-${Date.now()}`;
      db.prepare(`
        UPDATE drafts SET status = 'published', published_at = ?, binance_post_id = ? WHERE id = ?
      `).run(publishedAt, syntheticPostId, draft.id);

      db.prepare(`
        INSERT INTO publish_log (draft_id, account_id, method, http_status, response_body, published_at)
        VALUES (?, ?, 'playwright_ui', 200, ?, ?)
      `).run(draft.id, account.id, JSON.stringify({ ok: true, jobId, binance_post_id: syntheticPostId }), publishedAt);

      const shot = await capturePageBase64(page);
      appendJobLog(jobId, 'Published', `Article ${draft.id} published via Playwright UI.`, shot);
      setJobStatus(jobId, 'completed');
    } catch (err) {
      if (!abortedJobIds.has(jobId)) {
        const msg = err instanceof Error ? err.message : 'Publish job failed';
        db.prepare(`UPDATE drafts SET status = 'failed' WHERE id = ?`).run(draft.id);
        db.prepare(`
          INSERT INTO publish_log (draft_id, account_id, method, http_status, response_body, published_at)
          VALUES (?, ?, 'playwright_ui', 500, ?, ?)
        `).run(draft.id, account.id, JSON.stringify({ ok: false, error: msg }), new Date().toISOString());

        appendJobLog(jobId, 'Failed', msg);
        setJobStatus(jobId, 'failed', msg);
      }
    } finally {
      abortedJobIds.delete(jobId);
      if (context) await context.close().catch(() => {});
    }
  })();

  return { jobId, method };
}

export async function startAuthSessionCheck(accountId: string): Promise<string> {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new Error('Account not found.');

  const jobId = `JOB-AUTH-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO automation_jobs (id, job_type, account_id, status, current_step, logs, created_at, updated_at)
    VALUES (?, 'auth_check', ?, 'running', 'Initializing', '[]', ?, ?)
  `).run(jobId, accountId, now, now);

  void (async () => {
    let context: BrowserContext | null = null;
    try {
      const launched = await launchIsolatedContext(accountId, jobId, { forceProxyCheck: true });
      context = launched.context;
      throwIfJobAborted(jobId);
      const activePage = await ensureAuthenticatedOnSquare({
        page: launched.page,
        context,
        accountId,
        profileId: launched.profileId,
        jobId,
        hasSavedCookies: launched.hasSavedCookies,
      });
      throwIfJobAborted(jobId);
      const shot = await capturePageBase64(activePage);
      appendJobLog(jobId, 'Authenticated', 'Session verified and cookies persisted.', shot);
      setJobStatus(jobId, 'completed');
    } catch (err) {
      if (!abortedJobIds.has(jobId)) {
        const msg = err instanceof Error ? err.message : 'Auth check failed';
        appendJobLog(jobId, 'Failed', msg);
        setJobStatus(jobId, 'failed', msg);
      }
    } finally {
      abortedJobIds.delete(jobId);
      if (context) await context.close().catch(() => {});
    }
  })();

  return jobId;
}
