import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Download,
  FileText,
  KeyRound,
  Monitor,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Upload,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type {
  AIProvider,
  Account,
  Draft,
  MasterPipeline,
  Persona,
  ProviderId,
  SourcePost,
} from '../types';

interface MasterPipelineViewProps {
  accounts: Account[];
  personas: Persona[];
  providers: AIProvider[];
  sourcePosts: SourcePost[];
  drafts: Draft[];
  pipelines: MasterPipeline[];
  onRefresh: () => Promise<void>;
  onOpenAccounts: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

function countWords(text: string): number {
  const cleaned = (text || '').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'Immediate';
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins}m`;
  const wholeH = Math.floor(mins / 60);
  const remM = mins % 60;
  return remM > 0 ? `${wholeH}h ${remM}m` : `${wholeH}h`;
}

function formatCountdown(iso: string | null, nowMs: number): string {
  if (!iso) return 'Waiting turn';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 'Waiting turn';
  const diffSec = Math.round((target - nowMs) / 1000);
  if (diffSec <= 0) return 'Due now';
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const secs = diffSec % 60;
  if (hrs > 0) return `in ${hrs}h ${mins}m`;
  if (mins > 0) return `in ${mins}m ${secs}s`;
  return `in ${secs}s`;
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function MasterPipelineView({
  accounts,
  personas,
  providers,
  sourcePosts,
  drafts,
  pipelines,
  onRefresh,
  onOpenAccounts,
  onNotify,
}: MasterPipelineViewProps) {
  const publisherAccounts = useMemo(
    () => accounts.filter((a) => a.role === 'publisher'),
    [accounts]
  );

  const defaultAccountId = useMemo(() => {
    const running = pipelines.find((p) => p.status === 'running');
    if (running && publisherAccounts.some((a) => a.id === running.account_id)) {
      return running.account_id;
    }
    const withKey = publisherAccounts.find((a) => a.has_square_api_key);
    return withKey?.id || publisherAccounts[0]?.id || '';
  }, [pipelines, publisherAccounts]);

  const [selectedAccountId, setSelectedAccountId] = useState<string>(defaultAccountId);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!selectedAccountId && defaultAccountId) {
      setSelectedAccountId(defaultAccountId);
    } else if (
      selectedAccountId &&
      publisherAccounts.length > 0 &&
      !publisherAccounts.some((a) => a.id === selectedAccountId)
    ) {
      setSelectedAccountId(defaultAccountId);
    }
  }, [selectedAccountId, defaultAccountId, publisherAccounts]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const selectedAccount = useMemo(
    () => publisherAccounts.find((a) => a.id === selectedAccountId),
    [publisherAccounts, selectedAccountId]
  );
  const selectedPersona = useMemo(
    () => personas.find((p) => p.account_id === selectedAccountId),
    [personas, selectedAccountId]
  );
  const activePipeline = useMemo(
    () => pipelines.find((p) => p.account_id === selectedAccountId),
    [pipelines, selectedAccountId]
  );

  const defaultProvider = useMemo(() => {
    const validated = providers.find((p) => p.validated);
    return validated || providers[0];
  }, [providers]);

  // Independent stage settings & schedules (Scraping -> Rewriting -> Publishing)
  const [headless, setHeadless] = useState<boolean>(true);
  const [feedTab, setFeedTab] = useState<'discover' | 'following' | 'news' | 'academy' | 'all'>(
    'discover'
  );
  const [scrapeTargetCount, setScrapeTargetCount] = useState<number>(20);
  const [scrapeIntervalHours, setScrapeIntervalHours] = useState<number>(5);
  const [nextScrapeInput, setNextScrapeInput] = useState<string>('');

  const [generateIntervalHours, setGenerateIntervalHours] = useState<number>(0.5);
  const [nextGenerateInput, setNextGenerateInput] = useState<string>('');
  const [minSourceWords, setMinSourceWords] = useState<number>(100);
  const [targetMinWords, setTargetMinWords] = useState<number>(870);
  const [targetMaxWords, setTargetMaxWords] = useState<number>(1340);
  const [providerId, setProviderId] = useState<ProviderId>(defaultProvider?.id || 'gemini');
  const [model, setModel] = useState<string>(defaultProvider?.selected_model || '');

  const [publishIntervalHours, setPublishIntervalHours] = useState<number>(1);
  const [nextPublishInput, setNextPublishInput] = useState<string>('');
  const [writingRulesDraft, setWritingRulesDraft] = useState<string>('');
  const [savingRules, setSavingRules] = useState<boolean>(false);

  useEffect(() => {
    setWritingRulesDraft(selectedPersona?.writing_rules || '');
  }, [selectedPersona?.id, selectedPersona?.writing_rules]);

  useEffect(() => {
    if (activePipeline) {
      setHeadless(activePipeline.headless ?? true);
      setFeedTab(activePipeline.feed_tab);
      setScrapeTargetCount(activePipeline.scrape_target_count);
      setScrapeIntervalHours(activePipeline.scrape_interval_hours);
      setNextScrapeInput(isoToLocalInput(activePipeline.next_scrape_at));

      setGenerateIntervalHours(activePipeline.generate_interval_hours ?? 0.5);
      setNextGenerateInput(isoToLocalInput(activePipeline.next_generate_at));

      setMinSourceWords(activePipeline.min_source_words);
      setTargetMinWords(activePipeline.target_min_words);
      setTargetMaxWords(activePipeline.target_max_words);
      setProviderId(activePipeline.provider_id);
      setModel(activePipeline.model || '');

      setPublishIntervalHours(activePipeline.publish_interval_hours ?? 1);
      setNextPublishInput(isoToLocalInput(activePipeline.next_publish_at));
    } else {
      setHeadless(true);
      setFeedTab('discover');
      setScrapeTargetCount(20);
      setScrapeIntervalHours(5);
      setNextScrapeInput('');

      setGenerateIntervalHours(0.5);
      setNextGenerateInput('');

      setMinSourceWords(100);
      setTargetMinWords(870);
      setTargetMaxWords(1340);
      if (defaultProvider) {
        setProviderId(defaultProvider.id);
        setModel(defaultProvider.selected_model || defaultProvider.available_models[0] || '');
      }
      setPublishIntervalHours(1);
      setNextPublishInput('');
    }
  }, [
    selectedAccountId,
    activePipeline?.id,
    activePipeline?.headless,
    activePipeline?.next_scrape_at,
    activePipeline?.next_generate_at,
    activePipeline?.next_publish_at,
    defaultProvider,
  ]);

  const currentProvider = useMemo(
    () => providers.find((p) => p.id === providerId) || defaultProvider,
    [providers, providerId, defaultProvider]
  );

  const availableModels = currentProvider?.available_models || [];

  const handleProviderChange = (nextProvider: ProviderId) => {
    setProviderId(nextProvider);
    const p = providers.find((item) => item.id === nextProvider);
    setModel(p?.selected_model || p?.available_models[0] || '');
  };

  // Readiness metrics for the selected persona
  const readiness = useMemo(() => {
    if (!selectedPersona) {
      return { unusedTotal: 0, qualifyingSources: 0, approvedQueue: 0, publishedCount: 0 };
    }
    let unusedTotal = 0;
    let qualifyingSources = 0;
    for (const sp of sourcePosts) {
      if (sp.used_by_persona_ids.includes(selectedPersona.id)) continue;
      unusedTotal++;
      if (countWords(sp.content) > minSourceWords) {
        qualifyingSources++;
      }
    }
    const personaDrafts = drafts.filter((d) => d.persona_id === selectedPersona.id);
    const approvedQueue = personaDrafts.filter((d) => d.status === 'approved').length;
    const publishedCount = personaDrafts.filter((d) => d.status === 'published').length;
    return { unusedTotal, qualifyingSources, approvedQueue, publishedCount };
  }, [selectedPersona, sourcePosts, drafts, minSourceWords]);

  const recentPersonaDrafts = useMemo(() => {
    if (!selectedPersona) return [];
    return drafts.filter((d) => d.persona_id === selectedPersona.id).slice(0, 6);
  }, [drafts, selectedPersona]);

  const configPayload = () => ({
    headless,
    feedTab,
    scrapeTargetCount: Math.min(200, Math.max(1, Math.round(scrapeTargetCount) || 20)),
    scrapeIntervalHours: Math.min(168, Math.max(0, Number.isFinite(scrapeIntervalHours) ? scrapeIntervalHours : 5)),
    generatePerCycle: 1,
    generateIntervalHours: Math.min(168, Math.max(0, Number.isFinite(generateIntervalHours) ? generateIntervalHours : 0.5)),
    minSourceWords: Math.min(500, Math.max(20, Math.round(minSourceWords) || 100)),
    targetMinWords: Math.min(2000, Math.max(300, Math.round(targetMinWords) || 870)),
    targetMaxWords: Math.min(
      2500,
      Math.max((Math.round(targetMinWords) || 870) + 100, Math.round(targetMaxWords) || 1340)
    ),
    providerId,
    model: model || currentProvider?.selected_model || '',
    publishIntervalHours: Math.min(168, Math.max(0, Number.isFinite(publishIntervalHours) ? publishIntervalHours : 1)),
    nextScrapeAt: localInputToIso(nextScrapeInput),
    nextGenerateAt: localInputToIso(nextGenerateInput),
    nextPublishAt: localInputToIso(nextPublishInput),
  });

  const handleSaveConfig = async () => {
    if (!selectedAccountId) return;
    setBusyAction('save');
    try {
      await api.savePipeline(selectedAccountId, configPayload());
      await onRefresh();
      onNotify(
        `Saved independent Scrape, Rewrite, Publish schedules and browser mode for ${
          selectedAccount?.label || selectedAccountId
        }.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save pipeline configuration', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleStartAutomate = async () => {
    if (!selectedAccountId) return;
    if (!selectedAccount?.has_square_api_key) {
      onNotify(
        `Add a Binance Square Creator OpenAPI Key on "${
          selectedAccount?.label || 'this account'
        }" in Accounts & Proxies before automating.`,
        'error'
      );
      return;
    }
    setBusyAction('start');
    try {
      await api.startPipeline({
        accountId: selectedAccountId,
        ...configPayload(),
      });
      await onRefresh();
      onNotify(`Master Automated Pipeline started on ${selectedAccount.label}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to start pipeline', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleKillPipeline = async () => {
    if (!selectedAccountId) return;
    setBusyAction('stop');
    try {
      await api.stopPipeline(selectedAccountId);
      await onRefresh();
      onNotify(`Master Pipeline stopped on ${selectedAccount?.label || selectedAccountId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to stop pipeline', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePausePipeline = async () => {
    if (!selectedAccountId) return;
    setBusyAction('pause');
    try {
      await api.pausePipeline(selectedAccountId);
      await onRefresh();
      onNotify(`Master Pipeline paused on ${selectedAccount?.label || selectedAccountId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to pause pipeline', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleResumePipeline = async () => {
    if (!selectedAccountId) return;
    setBusyAction('resume');
    try {
      await api.savePipeline(selectedAccountId, configPayload());
      await api.resumePipeline(selectedAccountId);
      await onRefresh();
      onNotify(`Master Pipeline resumed on ${selectedAccount?.label || selectedAccountId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to resume pipeline', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleTriggerNow = async () => {
    if (!selectedAccountId) return;
    setBusyAction('trigger');
    try {
      await api.savePipeline(selectedAccountId, configPayload());
      await api.triggerPipelineCycle(selectedAccountId);
      await onRefresh();
      onNotify(`Triggered immediate step in active phase on ${selectedAccount?.label}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to trigger cycle', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveWritingRules = async () => {
    if (!selectedPersona) return;
    setSavingRules(true);
    try {
      await api.updatePersona(selectedPersona.id, {
        writing_rules: writingRulesDraft,
      });
      await onRefresh();
      onNotify(
        `Saved writing rules file (${
          selectedPersona.writing_rules_file || `data/persona_rules/${selectedPersona.id}.md`
        }) for ${selectedPersona.display_name}.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save writing rules', 'error');
    } finally {
      setSavingRules(false);
    }
  };

  const status = activePipeline?.status || 'idle';
  const stage = activePipeline?.current_stage || 'idle';
  const cyclePhase = activePipeline?.cycle_phase || 'scrape';
  const logsNewestFirst = useMemo(
    () => [...(activePipeline?.logs || [])].reverse(),
    [activePipeline?.logs]
  );

  const stageLabel =
    status === 'stopped'
      ? 'Stopped'
      : status === 'paused'
      ? `Paused · Holding Phase: ${cyclePhase.toUpperCase()}`
      : status === 'error'
      ? 'Error'
      : stage === 'scraping'
      ? 'Phase 1 ACTIVE · Scraping Unique Posts'
      : stage === 'generating'
      ? 'Phase 2 ACTIVE · Rewriting 1 Article'
      : stage === 'publishing'
      ? 'Phase 3 ACTIVE · Publishing 1 Article'
      : stage === 'waiting'
      ? `Running · Active Phase: ${
          cyclePhase === 'scrape'
            ? 'Scrape (waiting window)'
            : cyclePhase === 'generate'
            ? 'Rewrite (next article countdown)'
            : 'Publish (next article countdown)'
        }`
      : 'Idle · Ready to Start';

  const scrapePhaseState =
    status !== 'running'
      ? status === 'paused' && cyclePhase === 'scrape'
        ? 'Paused'
        : 'Idle'
      : cyclePhase === 'scrape'
      ? stage === 'scraping'
        ? 'ACTIVE NOW'
        : 'ACTIVE · Waiting window'
      : 'Paused (waiting cycle)';

  const rewritePhaseState =
    status !== 'running'
      ? status === 'paused' && cyclePhase === 'generate'
        ? 'Paused'
        : 'Idle'
      : cyclePhase === 'generate'
      ? stage === 'generating'
        ? 'ACTIVE NOW'
        : 'ACTIVE · Next 1-article timer'
      : cyclePhase === 'scrape'
      ? 'Paused (waiting scrape)'
      : 'Paused (all scraped rewritten)';

  const publishPhaseState =
    status !== 'running'
      ? status === 'paused' && cyclePhase === 'publish'
        ? 'Paused'
        : 'Idle'
      : cyclePhase === 'publish'
      ? stage === 'publishing'
        ? 'ACTIVE NOW'
        : 'ACTIVE · Next 1-article timer'
      : 'Paused (waiting rewrite)';

  return (
    <div className="space-y-6">
      {/* Master Account & Workflow Control Bar */}
      <section className="rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-base font-semibold text-[#EAECEF]">
                Master Automated Pipeline
              </h2>
              <span
                className={`text-xs font-mono font-medium ${
                  status === 'running'
                    ? 'text-emerald-400'
                    : status === 'error'
                    ? 'text-rose-400'
                    : status === 'paused' || status === 'stopped'
                    ? 'text-amber-300'
                    : 'text-slate-400'
                }`}
              >
                {stageLabel}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Sequential cycle: Scrape {scrapeTargetCount} posts (pauses) → Rewrite 1 article every {formatDurationHours(generateIntervalHours)} until all scraped are done (pauses) → Publish 1 article every {formatDurationHours(publishIntervalHours)} until all are published → Resume Scrape.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={!selectedAccountId || busyAction !== null || status === 'running'}
              onClick={handleStartAutomate}
              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              Start Pipeline
            </button>

            <button
              type="button"
              disabled={!selectedAccountId || busyAction !== null || status !== 'running'}
              onClick={handlePausePipeline}
              className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-400/15 px-3.5 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-400/25 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause Pipeline
            </button>

            <button
              type="button"
              disabled={
                !selectedAccountId ||
                busyAction !== null ||
                !activePipeline ||
                (status !== 'paused' && status !== 'stopped' && status !== 'error')
              }
              onClick={handleResumePipeline}
              className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Resume Pipeline
            </button>

            <button
              type="button"
              disabled={
                !selectedAccountId ||
                busyAction !== null ||
                (status !== 'running' && status !== 'paused')
              }
              onClick={handleKillPipeline}
              className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <OctagonX className="h-3.5 w-3.5" />
              Stop Pipeline
            </button>

            <button
              type="button"
              disabled={!selectedAccountId || busyAction !== null || status !== 'running'}
              onClick={handleTriggerNow}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-medium text-[#EAECEF] hover:bg-white/[0.08] disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Run Step Now
            </button>

            <button
              type="button"
              disabled={!selectedAccountId || busyAction !== null}
              onClick={handleSaveConfig}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/[0.08] disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Save className="h-3.5 w-3.5" />
              Save Schedules
            </button>
          </div>
        </div>

        {/* Account Selection, Headless Check & Readiness Warnings */}
        <div className="border-t border-white/10 pt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
          <div className="lg:col-span-4">
            <label className="block text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
              Master Coordinating Account
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
            >
              {publisherAccounts.length === 0 && (
                <option value="">No publisher accounts available</option>
              )}
              {publisherAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.label}{' '}
                  {acc.has_square_api_key ? '· Creator Key Configured' : '· Missing Creator Key'}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3">
            <label className="block text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">
              Browser Execution Mode
            </label>
            <label className="flex items-center gap-2.5 rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-xs text-[#EAECEF] cursor-pointer hover:border-white/30">
              <input
                type="checkbox"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/20 bg-[#0B0E14] accent-[#F0B90B]"
              />
              <Monitor className="h-3.5 w-3.5 text-[#F0B90B] shrink-0" />
              <span className="truncate">
                {headless ? 'Headless Browser (Background)' : 'Visible Browser (Non-Headless)'}
              </span>
            </label>
          </div>

          <div className="lg:col-span-5 flex flex-wrap items-center justify-between gap-3 text-xs">
            {selectedAccount ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-slate-300">
                  <span className="text-slate-400">Persona:</span>
                  <span className="font-medium text-[#EAECEF]">
                    {selectedPersona?.display_name || 'Unlinked'}
                  </span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-400">OpenAPI Key:</span>
                  {selectedAccount.has_square_api_key ? (
                    <span className="inline-flex items-center gap-1 font-mono text-emerald-400">
                      <KeyRound className="h-3 w-3" />
                      {selectedAccount.square_api_key_masked || 'Configured'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Required for Master Pipeline
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400">
                  Scraper uses guest mode (no comments / no login) · Publisher dispatches via Creator OpenAPI.
                </p>
              </div>
            ) : (
              <p className="text-slate-400">
                Create a Publisher account with a Binance Square Creator OpenAPI Key to operate the Master Pipeline.
              </p>
            )}

            {(!selectedAccount || !selectedAccount.has_square_api_key) && (
              <button
                type="button"
                onClick={onOpenAccounts}
                className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-400/20 whitespace-nowrap shrink-0"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Configure Key in Accounts
              </button>
            )}
          </div>
        </div>

        {/* Last Error Banner if any */}
        {activePipeline?.last_error && (
          <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-200 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{activePipeline.last_error}</span>
            </div>
            <span className="font-mono text-[11px] text-rose-300 shrink-0">
              {formatDateTime(activePipeline.updated_at)}
            </span>
          </div>
        )}

        {/* 3-Stage Sequential Handshake Status Strip */}
        <div className="border-t border-white/10 pt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            className={`rounded border px-4 py-3 flex items-center justify-between gap-3 ${
              status === 'running' && cyclePhase === 'scrape'
                ? 'border-[#F0B90B]/70 bg-[#F0B90B]/[0.07]'
                : 'border-white/10 bg-[#0B0E14]/60'
            }`}
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1 text-[#F0B90B]">
                  <Database className="h-3.5 w-3.5" />
                  01 · SCRAPE
                </span>
                <span className="text-slate-600">·</span>
                <span
                  className={
                    status === 'running' && cyclePhase === 'scrape'
                      ? 'text-emerald-400 font-semibold'
                      : 'text-slate-400'
                  }
                >
                  {scrapePhaseState}
                </span>
              </div>
              <p className="text-xs font-medium text-[#EAECEF] truncate">
                {scrapeTargetCount} unique posts · Resume wait {formatDurationHours(scrapeIntervalHours)}
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                Next: {formatDateTime(localInputToIso(nextScrapeInput))} ({formatCountdown(localInputToIso(nextScrapeInput), nowMs)})
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                Last: {formatDateTime(activePipeline?.last_scrape_at || null)} · {headless ? 'Headless' : 'Visible'}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-600 hidden md:block shrink-0" />
          </div>

          <div
            className={`rounded border px-4 py-3 flex items-center justify-between gap-3 ${
              status === 'running' && cyclePhase === 'generate'
                ? 'border-[#F0B90B]/70 bg-[#F0B90B]/[0.07]'
                : 'border-white/10 bg-[#0B0E14]/60'
            }`}
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1 text-[#F0B90B]">
                  <Cpu className="h-3.5 w-3.5" />
                  02 · REWRITE
                </span>
                <span className="text-slate-600">·</span>
                <span
                  className={
                    status === 'running' && cyclePhase === 'generate'
                      ? 'text-emerald-400 font-semibold'
                      : 'text-slate-400'
                  }
                >
                  {rewritePhaseState}
                </span>
              </div>
              <p className="text-xs font-medium text-[#EAECEF] truncate">
                1 article / {formatDurationHours(generateIntervalHours)} · &gt;{minSourceWords}w → {targetMinWords}–{targetMaxWords}w
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                Next: {formatDateTime(localInputToIso(nextGenerateInput))} ({formatCountdown(localInputToIso(nextGenerateInput), nowMs)})
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                {readiness.qualifyingSources} scraped remaining · Last: {formatDateTime(activePipeline?.last_generate_at || null)}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-600 hidden md:block shrink-0" />
          </div>

          <div
            className={`rounded border px-4 py-3 flex items-center justify-between gap-3 ${
              status === 'running' && cyclePhase === 'publish'
                ? 'border-[#F0B90B]/70 bg-[#F0B90B]/[0.07]'
                : 'border-white/10 bg-[#0B0E14]/60'
            }`}
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1 text-[#F0B90B]">
                  <Send className="h-3.5 w-3.5" />
                  03 · PUBLISH
                </span>
                <span className="text-slate-600">·</span>
                <span
                  className={
                    status === 'running' && cyclePhase === 'publish'
                      ? 'text-emerald-400 font-semibold'
                      : 'text-slate-400'
                  }
                >
                  {publishPhaseState}
                </span>
              </div>
              <p className="text-xs font-medium text-[#EAECEF] truncate">
                1 article / {formatDurationHours(publishIntervalHours)} · Creator OpenAPI
              </p>
              <p className="text-[11px] text-slate-400 font-mono tabular-nums truncate">
                Next: {formatDateTime(localInputToIso(nextPublishInput))} ({formatCountdown(localInputToIso(nextPublishInput), nowMs)})
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                {readiness.approvedQueue} queued to publish · Last: {formatDateTime(activePipeline?.last_publish_at || null)}
              </p>
            </div>
            <CheckCircle2
              className={`h-4 w-4 shrink-0 ${
                readiness.publishedCount > 0 ? 'text-emerald-400' : 'text-slate-600'
              }`}
            />
          </div>
        </div>
      </section>

      {/* Pipeline Telemetry Strip */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Scraped &gt;{minSourceWords}w Left</p>
          <p className="text-lg font-mono font-semibold text-[#EAECEF] tabular-nums mt-0.5">
            {readiness.qualifyingSources}
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Publish Queue Left</p>
          <p className="text-lg font-mono font-semibold text-[#F0B90B] tabular-nums mt-0.5">
            {readiness.approvedQueue}
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Total Scraped</p>
          <p className="text-lg font-mono font-semibold text-[#EAECEF] tabular-nums mt-0.5">
            {activePipeline?.total_scraped ?? 0}
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Total Rewritten</p>
          <p className="text-lg font-mono font-semibold text-[#EAECEF] tabular-nums mt-0.5">
            {activePipeline?.total_generated ?? 0}
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Total Published</p>
          <p className="text-lg font-mono font-semibold text-emerald-400 tabular-nums mt-0.5">
            {activePipeline?.total_published ?? 0}
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-[#12161F] px-4 py-3">
          <p className="text-[11px] text-slate-400">Active Cycle Phase</p>
          <p className="text-sm font-mono font-semibold text-[#EAECEF] uppercase tabular-nums mt-1 truncate">
            {cyclePhase} ({headless ? 'Headless' : 'Headed'})
          </p>
        </div>
      </section>

      {/* Main Split: Configuration Left (6 cols) | Live Logs & Output Right (6 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Editable Per-Stage Schedules & Parameters */}
        <section className="lg:col-span-6 rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-[#EAECEF]">
              Stage Timings, Headless Mode & Parameters
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Each stage runs sequentially: Scrape target count → Rewrite 1 article per interval until done → Publish 1 article per interval until done → Resume Scrape.
            </p>
          </div>

          {/* Stage 1 Config & Schedule */}
          <div className="border-t border-white/10 pt-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-mono uppercase tracking-wider text-[#F0B90B]">
                Stage 1 · Scraping (Guest Mode · Pauses When Target Done)
              </p>
              <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                Last: {formatDateTime(activePipeline?.last_scrape_at || null)}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Feed Tab</label>
                <select
                  value={feedTab}
                  onChange={(e) =>
                    setFeedTab(
                      e.target.value as 'discover' | 'following' | 'news' | 'academy' | 'all'
                    )
                  }
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                >
                  <option value="discover">Discover</option>
                  <option value="news">News</option>
                  <option value="academy">Academy</option>
                  <option value="all">All Feeds</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Posts Before Pause
                </label>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={scrapeTargetCount}
                  onChange={(e) => setScrapeTargetCount(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Resume Wait (hours)
                </label>
                <input
                  type="number"
                  min={0}
                  max={168}
                  step={0.25}
                  value={scrapeIntervalHours}
                  onChange={(e) => setScrapeIntervalHours(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
              <div className="sm:col-span-9">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <Clock className="h-3 w-3 text-[#F0B90B]" />
                  Next Scrape Time (blank = immediate when scrape phase starts)
                </label>
                <input
                  type="datetime-local"
                  value={nextScrapeInput}
                  onChange={(e) => setNextScrapeInput(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="button"
                  onClick={() => setNextScrapeInput('')}
                  className="w-full rounded border border-white/15 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.08] whitespace-nowrap"
                >
                  Run Now / Clear
                </button>
              </div>
            </div>
          </div>

          {/* Stage 2 Config & Schedule */}
          <div className="border-t border-white/10 pt-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-mono uppercase tracking-wider text-[#F0B90B]">
                Stage 2 · Rewriting (1 Article / Interval Until All Done)
              </p>
              <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                Last: {formatDateTime(activePipeline?.last_generate_at || null)}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Time / 1 Rewrite (hrs)
                </label>
                <input
                  type="number"
                  min={0}
                  max={168}
                  step={0.05}
                  value={generateIntervalHours}
                  onChange={(e) => setGenerateIntervalHours(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  Source &gt; Words
                </label>
                <input
                  type="number"
                  min={20}
                  max={500}
                  value={minSourceWords}
                  onChange={(e) => setMinSourceWords(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Min Words</label>
                <input
                  type="number"
                  min={300}
                  max={2000}
                  value={targetMinWords}
                  onChange={(e) => setTargetMinWords(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Max Words</label>
                <input
                  type="number"
                  min={400}
                  max={2500}
                  value={targetMaxWords}
                  onChange={(e) => setTargetMaxWords(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
              <div className="sm:col-span-9">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <Clock className="h-3 w-3 text-[#F0B90B]" />
                  Next 1-Article Rewrite Time ({formatDurationHours(generateIntervalHours)} spacing)
                </label>
                <input
                  type="datetime-local"
                  value={nextGenerateInput}
                  onChange={(e) => setNextGenerateInput(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="button"
                  onClick={() => setNextGenerateInput('')}
                  className="w-full rounded border border-white/15 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.08] whitespace-nowrap"
                >
                  Run Now / Clear
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">AI Provider</label>
                <select
                  value={providerId}
                  onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.provider_name} {p.validated ? '· Ready' : '· Unverified'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Model</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                >
                  {availableModels.length === 0 ? (
                    <option value={model}>{model || 'Provider default'}</option>
                  ) : (
                    availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>
          </div>

          {/* Stage 3 Config & Schedule */}
          <div className="border-t border-white/10 pt-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-mono uppercase tracking-wider text-[#F0B90B]">
                Stage 3 · Publishing (1 Article / Interval Until All Done)
              </p>
              <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                Last: {formatDateTime(activePipeline?.last_publish_at || null)}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
              <div className="sm:col-span-4">
                <label className="block text-[11px] text-slate-400 mb-1">
                  Time / 1 Publish (hrs)
                </label>
                <input
                  type="number"
                  min={0}
                  max={168}
                  step={0.05}
                  value={publishIntervalHours}
                  onChange={(e) => setPublishIntervalHours(Number(e.target.value))}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-8 grid grid-cols-3 gap-2">
                {[1, 2, 5].map((hrs) => {
                  const selected = Number(publishIntervalHours) === hrs;
                  return (
                    <button
                      key={hrs}
                      type="button"
                      onClick={() => setPublishIntervalHours(hrs)}
                      className={`rounded border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                        selected
                          ? 'border-[#F0B90B] bg-[#F0B90B]/15 text-[#F0B90B]'
                          : 'border-white/15 bg-[#0B0E14] text-slate-300 hover:border-white/30'
                      }`}
                    >
                      Every {hrs}h
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
              <div className="sm:col-span-9">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <Clock className="h-3 w-3 text-[#F0B90B]" />
                  Next 1-Article Publish Time ({formatDurationHours(publishIntervalHours)} spacing)
                </label>
                <input
                  type="datetime-local"
                  value={nextPublishInput}
                  onChange={(e) => setNextPublishInput(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-2.5 py-1.5 text-xs font-mono text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="button"
                  onClick={() => setNextPublishInput('')}
                  className="w-full rounded border border-white/15 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.08] whitespace-nowrap"
                >
                  Run Now / Clear
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Execution Logs & Queue Preview */}
        <section className="lg:col-span-6 rounded-lg border border-white/10 bg-[#12161F] p-5 flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[#EAECEF]">
                Live Master Pipeline Execution Log
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Sequential handoff log: Scrape ({scrapeTargetCount} posts) → Rewrite (1/{formatDurationHours(generateIntervalHours)}) → Publish (1/{formatDurationHours(publishIntervalHours)}) → Resume Scrape.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-400 shrink-0 tabular-nums">
              <Zap className="h-3.5 w-3.5 text-[#F0B90B]" />
              {logsNewestFirst.length} entries
            </span>
          </div>

          <div className="rounded border border-white/10 bg-[#0B0E14] p-3 h-[360px] overflow-y-auto space-y-2 font-mono text-xs">
            {logsNewestFirst.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-xs font-sans">
                No pipeline runs recorded for this account yet. Configure stage times, choose Headless or Visible Browser, and click Start Pipeline.
              </div>
            ) : (
              logsNewestFirst.map((entry, idx) => (
                <div
                  key={`${entry.ts}-${idx}`}
                  className="border-b border-white/[0.06] pb-2 last:border-b-0 last:pb-0 flex items-start gap-2.5"
                >
                  <span className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                    {new Date(entry.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span
                    className={`text-[11px] font-semibold shrink-0 w-24 truncate ${
                      entry.level === 'error'
                        ? 'text-rose-400'
                        : entry.level === 'success'
                        ? 'text-emerald-400'
                        : 'text-[#F0B90B]'
                    }`}
                  >
                    [{entry.stage}]
                  </span>
                  <span
                    className={`leading-relaxed break-words ${
                      entry.level === 'error'
                        ? 'text-rose-200'
                        : entry.level === 'success'
                        ? 'text-emerald-100'
                        : 'text-slate-300'
                    }`}
                  >
                    {entry.message}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Persona Output Preview */}
          <div className="border-t border-white/10 pt-4 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#EAECEF] flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-[#F0B90B]" />
                Recent Articles for {selectedPersona?.display_name || 'Selected Persona'}
              </span>
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {readiness.approvedQueue} queued · {readiness.publishedCount} published
              </span>
            </div>

            {recentPersonaDrafts.length === 0 ? (
              <p className="text-xs text-slate-500">
                No articles generated for this persona yet.
              </p>
            ) : (
              <div className="divide-y divide-white/10 border border-white/10 rounded bg-[#0B0E14]/60">
                {recentPersonaDrafts.map((d) => (
                  <div
                    key={d.id}
                    className="px-3 py-2 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-[#EAECEF] truncate">{d.title}</p>
                      <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                        {d.id} · {countWords(d.content)} words · {d.llm_model} ·{' '}
                        {formatDateTime(d.generated_at)}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] font-mono shrink-0 capitalize ${
                        d.status === 'published'
                          ? 'text-emerald-400'
                          : d.status === 'failed'
                          ? 'text-rose-400'
                          : d.status === 'approved'
                          ? 'text-[#F0B90B]'
                          : 'text-slate-400'
                      }`}
                    >
                      {d.status.replace('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Selected Persona Writing & Article Shape Rules File */}
      {selectedPersona && (
        <section className="rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-[#EAECEF]">
                  Persona Model Writing Rules File · {selectedPersona.display_name}
                </h3>
                <span className="font-mono text-[11px] text-[#F0B90B]">
                  {selectedPersona.writing_rules_file || `data/persona_rules/${selectedPersona.id}.md`}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Injected automatically into every rewrite for this persona (pipeline &amp; manual generation) to guide article structure, opening hook, subheadings, formatting, and tone.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <label className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] cursor-pointer whitespace-nowrap">
                <Upload className="h-3.5 w-3.5" />
                Load .md / .txt
                <input
                  type="file"
                  accept=".md,.txt,text/markdown,text/plain"
                  className="hidden"
                  onChange={async (ev) => {
                    const file = ev.target.files?.[0];
                    if (!file) return;
                    const text = await file.text();
                    setWritingRulesDraft(text);
                    ev.target.value = '';
                  }}
                />
              </label>

              <a
                href={api.getPersonaRulesFileUrl(selectedPersona.id, true)}
                className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                Download .md
              </a>

              <button
                type="button"
                disabled={savingRules}
                onClick={handleSaveWritingRules}
                className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-40 whitespace-nowrap"
              >
                <Save className="h-3.5 w-3.5" />
                {savingRules ? 'Saving...' : 'Save Rules File'}
              </button>
            </div>
          </div>

          <textarea
            rows={7}
            value={writingRulesDraft}
            onChange={(e) => setWritingRulesDraft(e.target.value)}
            placeholder="Add persona-specific article shape rules, formatting instructions, hook style, section requirements, and closing style..."
            className="w-full rounded border border-white/15 bg-[#0B0E14] p-3 font-mono text-xs text-[#EAECEF] leading-relaxed focus:border-[#F0B90B] focus:outline-none"
          />
        </section>
      )}
    </div>
  );
}
