import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ClipboardCheck,
  Cpu,
  Database,
  FileText,
  Play,
  ShieldAlert,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { api } from './api';
import { AccountsProfilesView } from './components/AccountsProfilesView';
import { AutomationPublishView } from './components/AutomationPublishView';
import { ChallengeModal } from './components/ChallengeModal';
import { GeneratedArticlesView } from './components/GeneratedArticlesView';
import { GeneratorProvidersView } from './components/GeneratorProvidersView';
import { HumanReviewView } from './components/HumanReviewView';
import { MasterPipelineView } from './components/MasterPipelineView';
import { ScrapedFeedView } from './components/ScrapedFeedView';
import type { BootstrapData } from './types';

type NavTab = 'pipeline' | 'review' | 'articles' | 'feed' | 'generator' | 'accounts' | 'automation';

const NAV_ITEMS: Array<{ key: NavTab; label: string; icon: typeof ClipboardCheck }> = [
  { key: 'pipeline', label: 'Master Pipeline', icon: Workflow },
  { key: 'review', label: 'Human Review', icon: ClipboardCheck },
  { key: 'articles', label: 'Generated Articles', icon: FileText },
  { key: 'feed', label: 'Scraped Feed', icon: Database },
  { key: 'generator', label: 'AI & Generator', icon: Cpu },
  { key: 'accounts', label: 'Accounts & Proxies', icon: Users },
  { key: 'automation', label: 'Scheduler & Logs', icon: Activity },
];

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<NavTab>('review');
  const [generatorPostId, setGeneratorPostId] = useState<string | undefined>(undefined);
  const [reviewDraftId, setReviewDraftId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<{ msg: string; tone: 'info' | 'error' } | null>(null);
  const [activeChallengeJobId, setActiveChallengeJobId] = useState<string | null>(null);
  const [dismissedChallengeIds, setDismissedChallengeIds] = useState<string[]>([]);
  const [quickScrapeBusy, setQuickScrapeBusy] = useState(false);
  const [scrapeTargetCount, setScrapeTargetCount] = useState<number>(100);
  const [scrapeTargetTab, setScrapeTargetTab] = useState<
    'discover' | 'following' | 'news' | 'academy' | 'all'
  >('discover');
  const [scrapeIncludeComments, setScrapeIncludeComments] = useState<boolean>(true);

  const notify = useCallback((msg: string, tone: 'info' | 'error' = 'info') => {
    setNotice({ msg, tone });
  }, []);

  const refresh = useCallback(async () => {
    const res = await api.bootstrap();
    setData(res);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed to load workspace data', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, notify]);

  // Auto-poll whenever an automation job or master pipeline is active or awaiting user MFA/CAPTCHA
  const hasActiveJobs = useMemo(() => {
    if (!data) return false;
    if ((data.activeBrowserAccountIds?.length || 0) > 0) return true;
    if (data.pipelines?.some((p) => p.status === 'running')) return true;
    return data.jobs.some(
      (j) =>
        j.status === 'running' ||
        j.status === 'queued' ||
        j.status === 'awaiting_mfa' ||
        j.status === 'awaiting_captcha'
    );
  }, [data]);

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 3500);
    return () => clearInterval(timer);
  }, [hasActiveJobs, refresh]);

  // Auto-open interactive challenge modal when a job enters awaiting_mfa or awaiting_captcha
  const pendingChallengeJobs = useMemo(() => {
    if (!data) return [];
    return data.jobs.filter(
      (j) => j.status === 'awaiting_mfa' || j.status === 'awaiting_captcha'
    );
  }, [data]);

  useEffect(() => {
    const activeChallengeSet = new Set(pendingChallengeJobs.map((j) => j.id));
    setDismissedChallengeIds((prev) => {
      const next = prev.filter((id) => activeChallengeSet.has(id));
      return next.length === prev.length ? prev : next;
    });

    const firstUnseen = pendingChallengeJobs.find(
      (j) => !dismissedChallengeIds.includes(j.id)
    );
    if (firstUnseen && !activeChallengeJobId) {
      setActiveChallengeJobId(firstUnseen.id);
    }
  }, [pendingChallengeJobs, dismissedChallengeIds, activeChallengeJobId]);

  const activeChallengeJob = useMemo(() => {
    if (!data || !activeChallengeJobId) return null;
    const found = data.jobs.find((j) => j.id === activeChallengeJobId);
    if (!found || (found.status !== 'awaiting_mfa' && found.status !== 'awaiting_captcha')) {
      return null;
    }
    return found;
  }, [data, activeChallengeJobId]);

  const handleQuickScrape = async () => {
    if (!data) return;
    const scraper = data.accounts.find((a) => a.role === 'scraper');
    if (!scraper) {
      setActiveTab('accounts');
      notify('Configure a dedicated Read-Only Scraper account first.', 'error');
      return;
    }
    const safeTarget = Math.min(200, Math.max(1, Math.round(Number(scrapeTargetCount) || 100)));
    setQuickScrapeBusy(true);
    try {
      const res = await api.runScraper(
        scraper.id,
        scrapeTargetTab,
        safeTarget,
        scrapeIncludeComments
      );
      await refresh();
      setActiveTab('automation');
      notify(
        `Independent scraper job ${res.jobId} started on ${scraper.label} (${scrapeTargetTab}, target: ${safeTarget} posts, ${
          scrapeIncludeComments ? 'with comments' : 'posts only'
        }).`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to start scraper', 'error');
    } finally {
      setQuickScrapeBusy(false);
    }
  };

  const handleSendToGenerator = (postId: string) => {
    setGeneratorPostId(postId);
    setActiveTab('generator');
  };

  const activeNavMeta = NAV_ITEMS.find((item) => item.key === activeTab) || NAV_ITEMS[0];

  const pendingReviewCount = data
    ? data.drafts.filter((d) => d.status === 'pending_review').length
    : 0;

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#EAECEF] flex">
      {/* Left Navigation Sidebar (248px) */}
      <aside className="hidden md:flex w-[248px] shrink-0 flex-col border-r border-white/10 bg-[#0E121A]">
        <div className="h-14 flex items-center gap-2.5 border-b border-white/10 px-5">
          <div className="h-7 w-7 rounded bg-[#F0B90B] flex items-center justify-center text-[#0B0E14] font-display font-bold text-sm">
            SD
          </div>
          <div>
            <p className="font-display text-sm font-semibold tracking-tight text-[#EAECEF]">
              SquareDesk Studio
            </p>
            <p className="text-[11px] text-slate-400">Binance Square Ops</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            const count =
              item.key === 'pipeline'
                ? data?.pipelines?.filter((p) => p.status === 'running').length || undefined
                : item.key === 'review'
                ? pendingReviewCount
                : item.key === 'articles'
                ? data?.drafts.length || 0
                : item.key === 'feed'
                ? data?.sourcePosts.length || 0
                : item.key === 'accounts'
                ? data?.accounts.length || 0
                : undefined;

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`w-full flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-[#1A202C] text-[#EAECEF]'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className={`h-4 w-4 ${active ? 'text-[#F0B90B]' : 'text-slate-400'}`} />
                  {item.label}
                </span>
                {count !== undefined && (
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Compact Workspace Summary */}
        {data && (
          <div className="border-t border-white/10 p-4 space-y-2 text-xs">
            <div className="flex items-center justify-between text-slate-400">
              <span>Validated AI Keys</span>
              <span className="font-mono text-slate-200 tabular-nums">
                {data.providers.filter((p) => p.validated).length}/{data.providers.length}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Scheduled Queue</span>
              <span className="font-mono text-slate-200 tabular-nums">
                {data.drafts.filter((d) => d.status === 'scheduled').length}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Published Total</span>
              <span className="font-mono text-emerald-400 tabular-nums">
                {data.drafts.filter((d) => d.status === 'published').length}
              </span>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* 56px Top Bar (3-zone contract: Breadcrumb left, Challenge/Primary CTA right) */}
        <header className="h-14 shrink-0 border-b border-white/10 bg-[#0E121A] px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-xs text-slate-500 hidden sm:inline">SquareDesk</span>
            <span className="text-slate-600 hidden sm:inline">/</span>
            <h1 className="text-sm font-semibold text-[#EAECEF] truncate">
              {activeNavMeta.label}
            </h1>
          </div>

          <div className="flex items-center gap-2.5">
            {pendingChallengeJobs.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveChallengeJobId(pendingChallengeJobs[0].id)}
                className="inline-flex items-center gap-1.5 rounded border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-400/20 whitespace-nowrap shrink-0"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                {pendingChallengeJobs.length} Challenge Pending
              </button>
            )}

            <button
              type="button"
              disabled={quickScrapeBusy || !data}
              onClick={handleQuickScrape}
              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              Run Scraper
            </button>
          </div>
        </header>

        {/* Mobile Tab Switcher */}
        <div className="flex md:hidden overflow-x-auto border-b border-white/10 bg-[#0E121A] px-3 py-2 gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={`px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap shrink-0 ${
                activeTab === item.key
                  ? 'bg-[#1A202C] text-[#EAECEF]'
                  : 'text-slate-400'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Inline Feedback Banner */}
        {notice && (
          <div
            className={`mx-6 mt-4 flex items-center justify-between gap-3 rounded border px-4 py-2.5 text-xs ${
              notice.tone === 'error'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{notice.msg}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-slate-400 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Active View Surface */}
        <main className="flex-1 p-6 max-w-[1480px] w-full mx-auto">
          {loading || !data ? (
            <div className="rounded-lg border border-white/10 bg-[#12161F] p-12 text-center text-sm text-slate-400">
              Loading SquareDesk workspace...
            </div>
          ) : (
            <>
              {activeTab === 'pipeline' && (
                <MasterPipelineView
                  accounts={data.accounts}
                  personas={data.personas}
                  providers={data.providers}
                  sourcePosts={data.sourcePosts}
                  drafts={data.drafts}
                  pipelines={data.pipelines || []}
                  onRefresh={refresh}
                  onOpenAccounts={() => setActiveTab('accounts')}
                  onNotify={notify}
                />
              )}

              {activeTab === 'review' && (
                <HumanReviewView
                  drafts={data.drafts}
                  personas={data.personas}
                  accounts={data.accounts}
                  sourcePosts={data.sourcePosts}
                  initialDraftId={reviewDraftId}
                  onRefresh={refresh}
                  onNotify={notify}
                />
              )}

              {activeTab === 'articles' && (
                <GeneratedArticlesView
                  drafts={data.drafts}
                  personas={data.personas}
                  onRefresh={refresh}
                  onOpenInReview={(draftId) => {
                    setReviewDraftId(draftId);
                    setActiveTab('review');
                  }}
                  onNotify={notify}
                />
              )}

              {activeTab === 'feed' && (
                <ScrapedFeedView
                  sourcePosts={data.sourcePosts}
                  accounts={data.accounts}
                  browserProfiles={data.browserProfiles}
                  personas={data.personas}
                  jobs={data.jobs}
                  activeBrowserAccountIds={data.activeBrowserAccountIds || []}
                  scrapeTargetCount={scrapeTargetCount}
                  onChangeScrapeTargetCount={setScrapeTargetCount}
                  scrapeTargetTab={scrapeTargetTab}
                  onChangeScrapeTargetTab={setScrapeTargetTab}
                  scrapeIncludeComments={scrapeIncludeComments}
                  onChangeScrapeIncludeComments={setScrapeIncludeComments}
                  onRefresh={refresh}
                  onSendToGenerator={handleSendToGenerator}
                  onNotify={notify}
                />
              )}

              {activeTab === 'generator' && (
                <GeneratorProvidersView
                  providers={data.providers}
                  sourcePosts={data.sourcePosts}
                  standaloneGenerations={data.standaloneGenerations || []}
                  initialSourcePostId={generatorPostId}
                  onRefresh={refresh}
                  onNotify={notify}
                />
              )}

              {activeTab === 'accounts' && (
                <AccountsProfilesView
                  accounts={data.accounts}
                  personas={data.personas}
                  browserProfiles={data.browserProfiles}
                  sourcePosts={data.sourcePosts}
                  providers={data.providers}
                  drafts={data.drafts}
                  jobs={data.jobs}
                  activeBrowserAccountIds={data.activeBrowserAccountIds || []}
                  onRefresh={refresh}
                  onOpenGeneratorForPersona={() => {
                    setActiveTab('generator');
                  }}
                  onNotify={notify}
                />
              )}

              {activeTab === 'automation' && (
                <AutomationPublishView
                  drafts={data.drafts}
                  personas={data.personas}
                  accounts={data.accounts}
                  jobs={data.jobs}
                  publishLogs={data.publishLogs}
                  onRefresh={refresh}
                  onOpenChallenge={(jobId) => setActiveChallengeJobId(jobId)}
                  onNotify={notify}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Interactive Human-in-the-Loop Challenge Modal (Email 6-Digit MFA / CAPTCHA) */}
      {activeChallengeJob && data && (
        <ChallengeModal
          job={activeChallengeJob}
          account={data.accounts.find((a) => a.id === activeChallengeJob.account_id)}
          onResolved={() => {
            setActiveChallengeJobId(null);
            void refresh();
          }}
          onDismiss={() => {
            setDismissedChallengeIds((prev) => [...prev, activeChallengeJob.id]);
            setActiveChallengeJobId(null);
          }}
        />
      )}
    </div>
  );
}
