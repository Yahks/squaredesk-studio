import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Code2,
  Download,
  ExternalLink,
  Play,
  PowerOff,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { Account, AutomationJob, BrowserProfile, Persona, SourcePost } from '../types';
import { HealthStatusLabel } from './StatusText';

type ScrapeFeedOption = 'discover' | 'following' | 'news' | 'academy' | 'all';

interface ScrapedFeedViewProps {
  sourcePosts: SourcePost[];
  accounts: Account[];
  browserProfiles: BrowserProfile[];
  personas: Persona[];
  jobs: AutomationJob[];
  activeBrowserAccountIds: string[];
  scrapeTargetCount: number;
  onChangeScrapeTargetCount: (value: number) => void;
  scrapeTargetTab: ScrapeFeedOption;
  onChangeScrapeTargetTab: (value: ScrapeFeedOption) => void;
  scrapeIncludeComments: boolean;
  onChangeScrapeIncludeComments: (value: boolean) => void;
  onRefresh: () => Promise<void>;
  onSendToGenerator: (postId: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

const FEED_TABS = [
  { key: 'all', label: 'All Posts' },
  { key: 'discover', label: 'Discover' },
  { key: 'following', label: 'Following' },
  { key: 'news', label: 'News & Announcements' },
  { key: 'academy', label: 'Academy & Live' },
] as const;

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function getHeadline(post: SourcePost): string {
  const firstLine = post.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || `${post.author} (${post.feed_tab})`;
}

export function ScrapedFeedView({
  sourcePosts,
  accounts,
  browserProfiles,
  personas,
  jobs,
  activeBrowserAccountIds,
  scrapeTargetCount,
  onChangeScrapeTargetCount,
  scrapeTargetTab,
  onChangeScrapeTargetTab,
  scrapeIncludeComments,
  onChangeScrapeIncludeComments,
  onRefresh,
  onSendToGenerator,
  onNotify,
}: ScrapedFeedViewProps) {
  const scraperAccounts = accounts.filter((a) => a.role === 'scraper');
  const [selectedScraperId, setSelectedScraperId] = useState(scraperAccounts[0]?.id || '');
  const [feedFilter, setFeedFilter] = useState<string>('all');
  const [targetInput, setTargetInput] = useState<string>(String(scrapeTargetCount || 100));
  const [search, setSearch] = useState('');
  const [showHtmlImporter, setShowHtmlImporter] = useState(false);
  const [rawHtml, setRawHtml] = useState('');
  const [importTab, setImportTab] = useState<'discover' | 'following' | 'news' | 'academy'>('news');
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [killingBrowser, setKillingBrowser] = useState(false);

  const activeScraper = scraperAccounts.find((a) => a.id === selectedScraperId) || scraperAccounts[0];
  const activeScraperProfile = activeScraper
    ? browserProfiles.find((bp) => bp.account_id === activeScraper.id)
    : undefined;
  const isScraperBrowserRunning = Boolean(
    activeScraper &&
      (activeBrowserAccountIds.includes(activeScraper.id) ||
        jobs.some(
          (j) =>
            j.account_id === activeScraper.id &&
            (j.status === 'running' ||
              j.status === 'queued' ||
              j.status === 'awaiting_mfa' ||
              j.status === 'awaiting_captcha')
        ))
  );

  const filteredPosts = useMemo(() => {
    const filtered = sourcePosts.filter((sp) => {
      if (feedFilter !== 'all' && sp.feed_tab !== feedFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          sp.id.toLowerCase().includes(q) ||
          sp.author.toLowerCase().includes(q) ||
          sp.content.toLowerCase().includes(q) ||
          sp.cashtags.some((c) => c.toLowerCase().includes(q)) ||
          sp.hashtags.some((h) => h.toLowerCase().includes(q))
        );
      }
      return true;
    });
    return [...filtered].sort(
      (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime()
    );
  }, [sourcePosts, feedFilter, search]);

  const activePost = useMemo(() => {
    if (!selectedPostId) return null;
    return sourcePosts.find((sp) => sp.id === selectedPostId) || null;
  }, [sourcePosts, selectedPostId]);

  const commitTargetValue = (raw: string): number => {
    const parsed = Math.round(Number(raw));
    const safe = Number.isFinite(parsed) && parsed >= 1 ? Math.min(200, parsed) : 100;
    setTargetInput(String(safe));
    onChangeScrapeTargetCount(safe);
    return safe;
  };

  const handleRunScraper = async () => {
    if (!activeScraper) {
      onNotify('Create a dedicated Scraper account first in Accounts & Profiles.', 'error');
      return;
    }
    const safeTarget = commitTargetValue(targetInput);
    setBusy(true);
    try {
      const res = await api.runScraper(
        activeScraper.id,
        scrapeTargetTab,
        safeTarget,
        scrapeIncludeComments
      );
      await onRefresh();
      onNotify(
        `Scraper job ${res.jobId} launched on ${activeScraper.label} (${scrapeTargetTab}, target: ${safeTarget} ${
          scrapeIncludeComments ? 'unique posts + comments' : 'posts only'
        }).`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to start scrape job', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleKillScraperBrowser = async () => {
    if (!activeScraper) {
      onNotify('Select or create a dedicated Scraper account first.', 'error');
      return;
    }
    setKillingBrowser(true);
    try {
      const res = await api.killBrowser(activeScraper.id);
      await onRefresh();
      const closedAny = res.closedContexts > 0 || res.stoppedJobs > 0 || res.killedPids > 0;
      onNotify(
        closedAny
          ? `Stopped scraper browser for ${activeScraper.label}: closed ${res.closedContexts} context(s), stopped ${res.stoppedJobs} job(s), terminated ${res.killedPids} Chromium process(es).`
          : `No active scraper browser was running for ${activeScraper.label}; verified browser profile is closed.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to stop scraper browser', 'error');
    } finally {
      setKillingBrowser(false);
    }
  };

  const handleImportHtml = async () => {
    setBusy(true);
    try {
      const res = await api.importHtml(rawHtml, importTab);
      setRawHtml('');
      setShowHtmlImporter(false);
      await onRefresh();
      onNotify(`Extracted and persisted ${res.count} Binance Square post(s) into local DB.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to parse Square HTML', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePost = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await api.deletePost(id);
      if (selectedPostId === id) {
        setSelectedPostId(null);
      }
      await onRefresh();
      onNotify(`Removed source post ${id}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete post', 'error');
    }
  };

  // Full scraped post reader view when a row is clicked
  if (activePost) {
    const words = countWords(activePost.content);
    const symbolCount = activePost.cashtags.length;
    const scrapedComments = Array.isArray(activePost.comments) ? activePost.comments : [];
    const safeExternalUrl = /^https?:\/\//i.test(activePost.post_url || '') ? activePost.post_url : '';
    const bundlePathDisplay = activePost.bundle_file_path || `data/scraped_posts/${activePost.id}.json`;
    const usedPersonas = activePost.used_by_persona_ids.map(
      (pid) => personas.find((p) => p.id === pid)?.display_name || pid
    );

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <button
            type="button"
            onClick={() => setSelectedPostId(null)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Scraped Articles
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={api.getPostBundleUrl(activePost.id, true)}
              download={`post-${activePost.id}.json`}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download Post + Comments (.json)
            </a>
            {safeExternalUrl && (
              <a
                href={safeExternalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View on Square
              </a>
            )}
            <button
              type="button"
              onClick={(e) => handleDeletePost(e, activePost.id)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-rose-400 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
            <button
              type="button"
              onClick={() => onSendToGenerator(activePost.id)}
              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] whitespace-nowrap shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Rewrite with Persona
            </button>
          </div>
        </div>

        <article className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
              <span className="font-mono text-[#F0B90B]">#{activePost.id}</span>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-slate-200">{activePost.author}</span>
              <span>{activePost.author_handle}</span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{activePost.feed_tab}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(activePost.collected_at).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>{words} words</span>
              <span aria-hidden="true">·</span>
              <span>{symbolCount} symbols</span>
              <span aria-hidden="true">·</span>
              <span>{scrapedComments.length} scraped comments</span>
            </div>

            <h1 className="font-display text-xl font-semibold tracking-tight text-[#EAECEF]">
              {getHeadline(activePost)}
            </h1>
          </div>

          <div className="border-t border-white/10 pt-5">
            <div className="whitespace-pre-wrap text-[15px] leading-7 text-slate-200 max-w-[75ch]">
              {activePost.content}
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-2 text-xs text-slate-400 tabular-nums">
            <div className="flex flex-wrap items-center gap-3">
              <span>Views: {activePost.engagement_metrics.views || '0'}</span>
              <span aria-hidden="true">·</span>
              <span>Likes: {activePost.engagement_metrics.likes || '0'}</span>
              <span aria-hidden="true">·</span>
              <span>Quotes: {activePost.engagement_metrics.quotes || '0'}</span>
              <span aria-hidden="true">·</span>
              <span>Comments: {activePost.engagement_metrics.comments || String(scrapedComments.length)}</span>
              <span aria-hidden="true">·</span>
              <span>
                Saved File: <span className="font-mono text-slate-300">{bundlePathDisplay}</span>
              </span>
            </div>

            {(activePost.cashtags.length > 0 || activePost.hashtags.length > 0) && (
              <p>
                Tags:{' '}
                <span className="font-mono text-slate-200">
                  {[...activePost.cashtags, ...activePost.hashtags].join(' ')}
                </span>
              </p>
            )}

            {usedPersonas.length > 0 && (
              <p className="text-amber-400/90">
                Diversity Tracker — Already rewritten by: {usedPersonas.join(', ')}
              </p>
            )}
          </div>
        </article>

        <section className="border-t border-white/10 pt-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#EAECEF] tabular-nums">
              Scraped Comments ({scrapedComments.length})
            </h2>
            <a
              href={api.getPostBundleUrl(activePost.id, false)}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono text-slate-400 hover:text-slate-200"
            >
              View combined JSON
            </a>
          </div>

          {scrapedComments.length === 0 ? (
            <p className="text-xs text-slate-500">
              No comments were mounted or returned for this post when scraped.
            </p>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {scrapedComments.map((comment) => (
                <div key={comment.id} className="py-3 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
                    <span className="font-medium text-slate-200">{comment.author}</span>
                    <span>{comment.author_handle}</span>
                    {comment.user_label && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#F0B90B]">{comment.user_label}</span>
                      </>
                    )}
                    {comment.is_thread_reply && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-slate-400">Thread reply</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{comment.created_at_label}</span>
                    <span aria-hidden="true">·</span>
                    <span>{comment.likes} likes</span>
                    <span>·</span>
                    <span>{comment.views} views</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300 max-w-[75ch]">
                    {comment.content}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Independent Scraper Control Bar */}
      <div className="rounded-lg border border-white/10 bg-[#12161F] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[#EAECEF]">
                Independent Square Scraper (Read-Only Node)
              </h2>
              {activeScraperProfile && <HealthStatusLabel status={activeScraperProfile.health_status} />}
            </div>
            <p className="text-xs text-slate-400">
              Scraping runs exclusively on an isolated non-publishing account with dedicated fingerprint, proxy, and persisted cookies.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={activeScraper?.id || ''}
              onChange={(e) => setSelectedScraperId(e.target.value)}
              className="rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
            >
              {scraperAccounts.length === 0 && <option value="">No scraper account</option>}
              {scraperAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.label} ({acc.login_identifier || 'No email set'})
                </option>
              ))}
            </select>

            <select
              value={scrapeTargetTab}
              onChange={(e) => onChangeScrapeTargetTab(e.target.value as ScrapeFeedOption)}
              className="rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
            >
              <option value="discover">Feed: Discover</option>
              <option value="following">Feed: Following</option>
              <option value="news">Feed: News & Announcements</option>
              <option value="academy">Feed: Academy & Live</option>
              <option value="all">Feed: All Tabs</option>
            </select>

            <label className="flex items-center gap-2 rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs text-slate-400 whitespace-nowrap shrink-0">
              <span>Target</span>
              <input
                type="number"
                min={1}
                max={200}
                value={targetInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setTargetInput(val);
                  const num = Math.round(Number(val));
                  if (Number.isFinite(num) && num >= 1 && num <= 200) {
                    onChangeScrapeTargetCount(num);
                  }
                }}
                onBlur={() => commitTargetValue(targetInput)}
                aria-label="Target posts to scrape"
                className="w-14 bg-transparent text-right font-mono text-xs text-[#EAECEF] tabular-nums focus:outline-none"
              />
              <span className="text-slate-500">posts</span>
            </label>

            <label
              title="Comment scraping requires an active logged-in session; SquareDesk verifies login before and during scraping and re-authenticates if logged out."
              className="inline-flex items-center gap-2 rounded border border-white/15 bg-[#0B0E14] px-3 py-1.5 text-xs text-slate-200 hover:border-white/25 cursor-pointer whitespace-nowrap shrink-0 select-none"
            >
              <input
                type="checkbox"
                checked={scrapeIncludeComments}
                onChange={(e) => onChangeScrapeIncludeComments(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/25 bg-[#0B0E14] accent-[#F0B90B] cursor-pointer"
              />
              <span>Scrape comments</span>
              <span className="text-[11px] text-slate-400">
                {scrapeIncludeComments ? '(requires login)' : '(posts only)'}
              </span>
            </label>

            <button
              type="button"
              onClick={() => setShowHtmlImporter(!showHtmlImporter)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Code2 className="h-3.5 w-3.5" />
              Import DOM HTML
            </button>

            <button
              type="button"
              disabled={busy || !activeScraper}
              onClick={handleRunScraper}
              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              Run Playwright Scrape
            </button>

            <button
              type="button"
              disabled={killingBrowser || !activeScraper}
              onClick={handleKillScraperBrowser}
              title="Stop, quit, and close the selected scraper account's Chromium browser"
              className={`inline-flex items-center gap-1.5 rounded border px-3.5 py-2 text-xs font-semibold disabled:opacity-50 whitespace-nowrap shrink-0 ${
                isScraperBrowserRunning
                  ? 'border-rose-500/70 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                  : 'border-rose-500/35 bg-rose-500/[0.07] text-rose-300 hover:bg-rose-500/15 hover:border-rose-500/55'
              }`}
            >
              <PowerOff className="h-3.5 w-3.5" />
              {killingBrowser ? 'Stopping...' : 'Kill Browser'}
            </button>
          </div>
        </div>

        {activeScraperProfile && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-3 text-xs text-slate-400">
            <span>
              Browser:{' '}
              <span className={`font-mono ${isScraperBrowserRunning ? 'text-emerald-400' : 'text-slate-300'}`}>
                {isScraperBrowserRunning ? 'Running' : 'Idle'}
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Connection:{' '}
              <span className="font-mono text-slate-300">
                {activeScraperProfile.has_proxy
                  ? activeScraperProfile.proxy_display
                  : 'Direct (No Proxy)'}
              </span>
            </span>
            {activeScraperProfile.has_proxy && activeScraperProfile.proxy_country && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Proxy Geo:{' '}
                  <span className="font-mono text-slate-300">
                    {activeScraperProfile.proxy_country} · {activeScraperProfile.proxy_locale} ·{' '}
                    {activeScraperProfile.proxy_timezone}
                  </span>
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              Saved Cookies:{' '}
              <span className="font-mono text-slate-300 tabular-nums">
                {activeScraperProfile.cookie_count}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Optional Raw DOM HTML Importer */}
      {showHtmlImporter && (
        <div className="rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-[#EAECEF]">
                Paste Binance Square DOM Markup
              </h3>
              <p className="text-xs text-slate-400">
                Parses <span className="font-mono">FeedBuzzBaseViewRootBox</span> feed cards or a full post detail + <span className="font-mono">#comment</span> page and saves each post + comments as one file.
              </p>
            </div>
            <select
              value={importTab}
              onChange={(e) =>
                setImportTab(e.target.value as 'discover' | 'following' | 'news' | 'academy')
              }
              className="rounded border border-white/15 bg-[#0B0E14] px-3 py-1.5 text-xs text-[#EAECEF]"
            >
              <option value="discover">Discover</option>
              <option value="following">Following</option>
              <option value="news">News & Announcements</option>
              <option value="academy">Academy & Live</option>
            </select>
          </div>
          <textarea
            rows={5}
            value={rawHtml}
            onChange={(e) => setRawHtml(e.target.value)}
            placeholder='<div class="FeedBuzzBaseView_FeedBuzzBaseViewRootBox__6RYwd ..."><div data-id="...">...'
            className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 font-mono text-xs text-slate-300 focus:border-[#F0B90B] focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowHtmlImporter(false)}
              className="rounded border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !rawHtml.trim()}
              onClick={handleImportHtml}
              className="rounded bg-[#F0B90B] px-4 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50"
            >
              Parse &amp; Save Posts
            </button>
          </div>
        </div>
      )}

      {/* Feed Tabs + Search */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-white/10 bg-[#12161F] p-1">
          {FEED_TABS.map((tab) => {
            const count =
              tab.key === 'all'
                ? sourcePosts.length
                : sourcePosts.filter((p) => p.feed_tab === tab.key).length;
            return (
              <button
                key={tab.key}
                onClick={() => setFeedFilter(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  feedFilter === tab.key
                    ? 'bg-[#1D2330] text-[#EAECEF]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label} <span className="ml-1 font-mono text-slate-500 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by post ID, $cashtag, author..."
            className="w-full rounded border border-white/10 bg-[#12161F] py-2 pl-8 pr-3 text-xs text-[#EAECEF] placeholder:text-slate-500 focus:border-[#F0B90B] focus:outline-none"
          />
        </div>
      </div>

      {/* Scraped Articles List (Clean Newest-First Format) */}
      <div className="max-w-5xl pt-1">
        <div className="mb-4">
          <h3 className="font-display text-base font-semibold text-[#EAECEF]">
            Scraped Articles
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">Newest first</p>
        </div>

        {filteredPosts.length === 0 ? (
          <div className="border-t border-white/10 py-12 text-center">
            <p className="text-sm font-medium text-slate-300">No scraped articles in this view</p>
            <p className="mt-1 text-xs text-slate-500">
              Run Playwright Scrape with your Scraper Account or import Square DOM HTML above.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {filteredPosts.map((post) => {
              const words = countWords(post.content);
              const symbolCount = post.cashtags.length;
              const commentCount = Array.isArray(post.comments) ? post.comments.length : 0;
              const formattedDate = new Date(post.collected_at).toLocaleString();
              const headline = getHeadline(post);

              return (
                <div
                  key={post.id}
                  onClick={() => setSelectedPostId(post.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedPostId(post.id);
                    }
                  }}
                  className="group flex items-center justify-between gap-4 rounded-md px-3 py-3.5 cursor-pointer transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#F0B90B]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-normal text-[#EAECEF] truncate">
                      {headline}
                    </p>
                    <p className="text-xs text-slate-400 tabular-nums truncate">
                      {formattedDate} · {words} words · {symbolCount} symbols · {commentCount} comments
                    </p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <ArrowUpRight
                      className="h-3.5 w-3.5 text-slate-500 transition-colors group-hover:text-slate-200"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      onClick={(e) => handleDeletePost(e, post.id)}
                      className="rounded p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-rose-400"
                      title="Delete scraped article"
                      aria-label={`Delete ${headline}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
