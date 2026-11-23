import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Cookie,
  Download,
  FileText,
  Globe,
  ImagePlus,
  Loader2,
  Plus,
  PowerOff,
  RefreshCw,
  Save,
  Search,
  Send,
  Shield,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  UserCog,
  X,
} from 'lucide-react';
import { ApiError, api } from '../api';
import type {
  AIProvider,
  Account,
  AccountRole,
  AutomationJob,
  BrowserProfile,
  Draft,
  DraftStatus,
  GenerationLogEntry,
  Persona,
  ProviderId,
  SourcePost,
} from '../types';
import { DraftStatusLabel, HealthStatusLabel } from './StatusText';

interface AccountsProfilesViewProps {
  accounts: Account[];
  personas: Persona[];
  browserProfiles: BrowserProfile[];
  sourcePosts: SourcePost[];
  providers: AIProvider[];
  drafts: Draft[];
  jobs: AutomationJob[];
  activeBrowserAccountIds: string[];
  onRefresh: () => Promise<void>;
  onOpenGeneratorForPersona: (personaId: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function countSymbols(text: string): number {
  const matches = [...text.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => m[1].toUpperCase());
  return new Set(matches).size;
}

export function AccountsProfilesView({
  accounts,
  personas,
  browserProfiles,
  sourcePosts,
  providers,
  drafts,
  jobs,
  activeBrowserAccountIds,
  onRefresh,
  onOpenGeneratorForPersona,
  onNotify,
}: AccountsProfilesViewProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [busyId, setBusyId] = useState<string>('');

  // Per-Account Generate modal state
  const [generateAccount, setGenerateAccount] = useState<Account | null>(null);
  const [genPostIds, setGenPostIds] = useState<string[]>([]);
  const [genPostSearch, setGenPostSearch] = useState('');
  const [genProviderId, setGenProviderId] = useState<ProviderId>('gemini');
  const [genModel, setGenModel] = useState('');
  const [genFormat, setGenFormat] = useState<'short_post' | 'long_article'>('short_post');
  const [genCustomAngle, setGenCustomAngle] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genCreatedDraft, setGenCreatedDraft] = useState<Draft | null>(null);
  const [genLogs, setGenLogs] = useState<GenerationLogEntry[]>([]);

  // Per-Account Publish modal state
  const [publishAccount, setPublishAccount] = useState<Account | null>(null);
  const [publishScope, setPublishScope] = useState<'account' | 'all'>('account');
  const [publishSearch, setPublishSearch] = useState('');
  const [publishingDraftId, setPublishingDraftId] = useState('');

  // Inline Per-Account Editorial Review state (stays on the specific account modal)
  const [reviewingDraftId, setReviewingDraftId] = useState<string | null>(null);
  const [reviewOrigin, setReviewOrigin] = useState<'publish' | 'generate'>('publish');
  const [revTitle, setRevTitle] = useState('');
  const [revContent, setRevContent] = useState('');
  const [revMedia, setRevMedia] = useState<string[]>([]);
  const [newRevMediaUrl, setNewRevMediaUrl] = useState('');
  const [revSchedule, setRevSchedule] = useState('');
  const [revBusy, setRevBusy] = useState(false);

  // Create account form state
  const [newRole, setNewRole] = useState<AccountRole>('publisher');
  const [newLabel, setNewLabel] = useState('');
  const [newLoginId, setNewLoginId] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newApiKeyRef, setNewApiKeyRef] = useState('');
  const [newSquareApiKey, setNewSquareApiKey] = useState('');
  const [newProxyUrl, setNewProxyUrl] = useState('');
  const [newCountry, setNewCountry] = useState('');
  const [newTimezone, setNewTimezone] = useState('');
  const [newLocale, setNewLocale] = useState('');
  const [newPersonaName, setNewPersonaName] = useState('');
  const [newPersonaNiche, setNewPersonaNiche] = useState('DeFi, L2s');
  const [newPersonaTone, setNewPersonaTone] = useState('analytical, calm, data-driven');
  const [newPersonaHours, setNewPersonaHours] = useState('08:00, 13:00, 20:00');
  const [creating, setCreating] = useState(false);

  // Edit account/profile state
  const [editLabel, setEditLabel] = useState('');
  const [editLoginId, setEditLoginId] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editApiKeyRef, setEditApiKeyRef] = useState('');
  const [editSquareApiKey, setEditSquareApiKey] = useState('');
  const [editHasSquareApiKey, setEditHasSquareApiKey] = useState(false);
  const [clearSquareApiKey, setClearSquareApiKey] = useState(false);
  const [editProxyUrl, setEditProxyUrl] = useState('');
  const [editHasProxy, setEditHasProxy] = useState(false);
  const [clearProxy, setClearProxy] = useState(false);
  const [editCountry, setEditCountry] = useState('');
  const [editTimezone, setEditTimezone] = useState('');
  const [editLocale, setEditLocale] = useState('');
  const [editWidth, setEditWidth] = useState(1440);
  const [editHeight, setEditHeight] = useState(900);

  // Edit persona state
  const [perDisplayName, setPerDisplayName] = useState('');
  const [perBio, setPerBio] = useState('');
  const [perNiche, setPerNiche] = useState('');
  const [perTone, setPerTone] = useState('');
  const [perFrequency, setPerFrequency] = useState('');
  const [perHours, setPerHours] = useState('');
  const [perBanned, setPerBanned] = useState('');
  const [perExamples, setPerExamples] = useState('');
  const [perWritingRules, setPerWritingRules] = useState('');

  const scraperAccounts = accounts.filter((a) => a.role === 'scraper');
  const publisherAccounts = accounts.filter((a) => a.role === 'publisher');

  const openEditAccount = (acc: Account, profile?: BrowserProfile) => {
    setEditingAccount(acc);
    setEditLabel(acc.label);
    setEditLoginId(acc.login_identifier);
    setEditPassword('');
    setEditApiKeyRef(acc.binance_square_api_key_ref);
    setEditSquareApiKey('');
    setEditHasSquareApiKey(Boolean(acc.has_square_api_key));
    setClearSquareApiKey(false);
    setEditProxyUrl('');
    setEditHasProxy(Boolean(profile?.has_proxy));
    setClearProxy(false);
    setEditCountry(profile?.proxy_country || '');
    setEditTimezone(profile?.proxy_timezone || '');
    setEditLocale(profile?.proxy_locale || '');
    setEditWidth(profile?.viewport_width || 1440);
    setEditHeight(profile?.viewport_height || 900);
  };

  const openEditPersona = (per: Persona) => {
    setEditingPersona(per);
    setPerDisplayName(per.display_name);
    setPerBio(per.bio);
    setPerNiche(per.niche.join(', '));
    setPerTone(per.tone);
    setPerFrequency(per.posting_frequency);
    setPerHours(per.active_hours.join(', '));
    setPerBanned(per.banned_topics.join(', '));
    setPerExamples(per.style_examples.join('\n'));
    setPerWritingRules(per.writing_rules || '');
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const trimmedProxy = newProxyUrl.trim();
      const created = await api.createAccount({
        role: newRole,
        label: newLabel,
        login_identifier: newLoginId,
        login_password: newPassword,
        binance_square_api_key_ref: newApiKeyRef,
        binance_square_api_key: newRole === 'publisher' ? newSquareApiKey.trim() : '',
        proxy_url: trimmedProxy,
        proxy_country: trimmedProxy ? newCountry : '',
        proxy_timezone: trimmedProxy ? newTimezone : '',
        proxy_locale: trimmedProxy ? newLocale : '',
        persona:
          newRole === 'publisher'
            ? {
                display_name: newPersonaName || newLabel,
                niche: newPersonaNiche
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                tone: newPersonaTone,
                active_hours: newPersonaHours
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : undefined,
      });

      let msg = `Created isolated ${newRole} account & dechromium browser profile.`;
      if (trimmedProxy) {
        try {
          const geo = await api.checkProxy(created.accountId);
          msg = `Created ${newRole} account · Proxy verified (${geo.country} · ${geo.timezone} · ${geo.locale}).`;
        } catch (proxyErr) {
          msg = `Account created, but proxy check failed: ${
            proxyErr instanceof Error ? proxyErr.message : 'Unable to connect'
          }`;
        }
      }

      setShowCreateModal(false);
      setNewLabel('');
      setNewLoginId('');
      setNewPassword('');
      setNewApiKeyRef('');
      setNewSquareApiKey('');
      setNewProxyUrl('');
      setNewCountry('');
      setNewTimezone('');
      setNewLocale('');
      setNewPersonaName('');
      await onRefresh();
      onNotify(msg);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create account', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAccount) return;
    setBusyId(editingAccount.id);
    try {
      const willHaveProxy = !clearProxy && (editHasProxy || Boolean(editProxyUrl.trim()));
      await api.updateAccount(editingAccount.id, {
        label: editLabel,
        login_identifier: editLoginId,
        login_password: editPassword || undefined,
        binance_square_api_key_ref: editApiKeyRef,
        binance_square_api_key:
          editingAccount.role === 'publisher' && !clearSquareApiKey
            ? editSquareApiKey.trim() || undefined
            : undefined,
        clear_square_api_key: editingAccount.role === 'publisher' ? clearSquareApiKey : false,
        proxy_url: editProxyUrl.trim() || undefined,
        clear_proxy: clearProxy,
        proxy_country: willHaveProxy ? editCountry : '',
        proxy_timezone: willHaveProxy ? editTimezone : '',
        proxy_locale: willHaveProxy ? editLocale : '',
        viewport_width: Number(editWidth) || 1440,
        viewport_height: Number(editHeight) || 900,
      });

      let msg = `Updated credentials & browser profile for ${editLabel}.`;
      if (willHaveProxy && editProxyUrl.trim()) {
        try {
          const geo = await api.checkProxy(editingAccount.id);
          msg = `Saved & verified proxy (${geo.country} · ${geo.timezone} · ${geo.locale}).`;
        } catch (proxyErr) {
          msg = `Saved proxy URL, but geo check failed: ${
            proxyErr instanceof Error ? proxyErr.message : 'Unable to connect'
          }`;
        }
      }

      setEditingAccount(null);
      await onRefresh();
      onNotify(msg);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update account', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleCheckProxy = async (accountId: string, label: string) => {
    setBusyId(accountId);
    try {
      const geo = await api.checkProxy(accountId);
      if (editingAccount?.id === accountId) {
        setEditCountry(geo.country);
        setEditTimezone(geo.timezone);
        setEditLocale(geo.locale);
      }
      await onRefresh();
      onNotify(
        `Proxy verified for ${label}: ${geo.ip || 'connected'} (${geo.country} · ${geo.timezone} · ${geo.locale}).`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Proxy check failed', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleSavePersona = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPersona) return;
    setBusyId(editingPersona.id);
    try {
      await api.updatePersona(editingPersona.id, {
        display_name: perDisplayName,
        bio: perBio,
        niche: perNiche
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        tone: perTone,
        posting_frequency: perFrequency,
        active_hours: perHours
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        banned_topics: perBanned
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        style_examples: perExamples
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        writing_rules: perWritingRules,
      });
      setEditingPersona(null);
      await onRefresh();
      onNotify(`Updated persona voice & writing rules file for ${perDisplayName}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update persona', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleAuthCheck = async (account: Account) => {
    setBusyId(account.id);
    try {
      const res = await api.authCheck(account.id);
      await onRefresh();
      onNotify(`Session verification job ${res.jobId} started for ${account.label}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to start session verification', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleClearCookies = async (account: Account) => {
    setBusyId(account.id);
    try {
      await api.clearCookies(account.id);
      await onRefresh();
      onNotify(`Cleared persisted cookies for ${account.label}. Next run will auto-relogin.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to clear cookies', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleKillBrowser = async (account: Account) => {
    setBusyId(account.id);
    try {
      const res = await api.killBrowser(account.id);
      await onRefresh();
      const closedAny = res.closedContexts > 0 || res.stoppedJobs > 0 || res.killedPids > 0;
      onNotify(
        closedAny
          ? `Stopped browser for ${account.label}: closed ${res.closedContexts} context(s), stopped ${res.stoppedJobs} job(s), terminated ${res.killedPids} Chromium process(es).`
          : `No active browser was running for ${account.label}; verified browser profile is closed.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to stop browser', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleDeleteAccount = async (account: Account) => {
    setBusyId(account.id);
    try {
      await api.deleteAccount(account.id);
      await onRefresh();
      onNotify(`Removed account ${account.label}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete account', 'error');
    } finally {
      setBusyId('');
    }
  };

  const openGenerateForAccount = (acc: Account, persona?: Persona) => {
    setGenerateAccount(acc);
    setGenCreatedDraft(null);
    setGenLogs([]);
    setReviewingDraftId(null);
    setGenPostSearch('');
    setGenCustomAngle('');
    setGenFormat('short_post');

    const sortedSources = [...sourcePosts].sort(
      (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime()
    );
    const preferredSource =
      (persona
        ? sortedSources.find((sp) => !sp.used_by_persona_ids.includes(persona.id))
        : undefined) || sortedSources[0];
    setGenPostIds(preferredSource ? [preferredSource.id] : []);

    const defaultProvider =
      providers.find((p) => p.validated) || providers[0];
    if (defaultProvider) {
      setGenProviderId(defaultProvider.id);
      setGenModel(defaultProvider.selected_model || defaultProvider.available_models[0] || '');
    }
  };

  const openPublishForAccount = (acc: Account, persona?: Persona) => {
    setPublishAccount(acc);
    setReviewingDraftId(null);
    setPublishSearch('');
    const hasAccountQueue = drafts.some(
      (d) => d.persona_id === persona?.id && d.status !== 'published' && d.status !== 'rejected'
    );
    setPublishScope(hasAccountQueue ? 'account' : 'all');
  };

  const openInlineReview = (draft: Draft, origin: 'publish' | 'generate') => {
    setReviewOrigin(origin);
    setReviewingDraftId(draft.id);
    setRevTitle(draft.title || '');
    setRevContent(draft.content || '');
    setRevMedia(draft.media_paths || []);
    setNewRevMediaUrl('');
    setRevSchedule(draft.scheduled_for ? draft.scheduled_for.slice(0, 16) : '');
  };

  const reviewingDraft = useMemo(() => {
    if (!reviewingDraftId) return null;
    return (
      drafts.find((d) => d.id === reviewingDraftId) ||
      (genCreatedDraft && genCreatedDraft.id === reviewingDraftId ? genCreatedDraft : null)
    );
  }, [drafts, genCreatedDraft, reviewingDraftId]);

  const applyInlineHourSlot = (hhmm: string) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    const target = new Date();
    target.setHours(hh || 8, mm || 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    const localIso = new Date(target.getTime() - target.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setRevSchedule(localIso);
  };

  const addInlineMediaPath = () => {
    const clean = newRevMediaUrl.trim();
    if (!clean || revMedia.length >= 4) return;
    setRevMedia((prev) => [...prev, clean]);
    setNewRevMediaUrl('');
  };

  const handleAccountGenerate = async () => {
    if (!generateAccount) return;
    const persona = personas.find((p) => p.account_id === generateAccount.id);
    if (!persona) {
      onNotify(
        `No 1:1 persona found for ${generateAccount.label}. Refresh the page or edit persona settings.`,
        'error'
      );
      return;
    }
    if (genPostIds.length === 0) {
      onNotify('Select at least one scraped source post to rewrite.', 'error');
      return;
    }

    setGenBusy(true);
    setGenLogs([
      {
        ts: new Date().toISOString(),
        step: 'Client',
        level: 'info',
        message: `Dispatching generation for ${generateAccount.label} via ${genProviderId}/${genModel || 'default'} (${genPostIds.length} source post(s))...`,
      },
    ]);
    try {
      const res = await api.generateArticle({
        sourcePostIds: genPostIds,
        personaId: persona.id,
        providerId: genProviderId,
        model: genModel || undefined,
        postFormat: genFormat,
        customAngle: genCustomAngle.trim() || undefined,
      });
      const created = res.draft as Draft;
      if (res.logs && res.logs.length > 0) {
        setGenLogs(res.logs);
      }
      await onRefresh();
      setGenCreatedDraft(created || null);
      onNotify(
        `Generated article ${created?.id || ''} for ${generateAccount.label} (${persona.display_name}).`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Article generation failed';
      if (err instanceof ApiError && err.logs && err.logs.length > 0) {
        setGenLogs(err.logs);
      } else {
        setGenLogs((prev) => [
          ...prev,
          { ts: new Date().toISOString(), step: 'Error', level: 'error', message: msg },
        ]);
      }
      onNotify(msg, 'error');
    } finally {
      setGenBusy(false);
    }
  };

  const handleAccountPublishDraft = async (draftId: string, account: Account) => {
    setPublishingDraftId(draftId);
    try {
      const res = await api.publishDraft(draftId, account.id);
      await onRefresh();
      setPublishAccount(null);
      setGenerateAccount(null);
      setGenCreatedDraft(null);
      setReviewingDraftId(null);
      const viaLabel =
        res.method === 'square_openapi'
          ? 'Binance Square Creator OpenAPI'
          : 'Playwright browser login';
      onNotify(
        `Publish job ${res.jobId} (${viaLabel}) started on ${account.label} for article ${draftId}.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to start publish job', 'error');
    } finally {
      setPublishingDraftId('');
    }
  };

  const handleInlineSaveReview = async (nextStatus?: DraftStatus) => {
    if (!reviewingDraft) return;
    setRevBusy(true);
    try {
      const scheduledIso = revSchedule ? new Date(revSchedule).toISOString() : null;
      await api.updateDraft(reviewingDraft.id, {
        title: revTitle,
        content: revContent,
        media_paths: revMedia,
        status: nextStatus || reviewingDraft.status,
        scheduled_for: scheduledIso,
      });
      if (genCreatedDraft && genCreatedDraft.id === reviewingDraft.id) {
        setGenCreatedDraft({
          ...genCreatedDraft,
          title: revTitle,
          content: revContent,
          media_paths: revMedia,
          status: nextStatus || genCreatedDraft.status,
          scheduled_for: scheduledIso,
        });
      }
      await onRefresh();
      if (nextStatus === 'rejected') {
        setReviewingDraftId(null);
      }
      onNotify(
        nextStatus
          ? `Article ${reviewingDraft.id} marked as ${nextStatus.replace('_', ' ')}.`
          : `Saved edits to ${reviewingDraft.id}.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update article', 'error');
    } finally {
      setRevBusy(false);
    }
  };

  const handleInlineDeleteReview = async () => {
    if (!reviewingDraft) return;
    const deletedId = reviewingDraft.id;
    setRevBusy(true);
    try {
      await api.deleteDraft(deletedId);
      setReviewingDraftId(null);
      if (genCreatedDraft && genCreatedDraft.id === deletedId) {
        setGenCreatedDraft(null);
      }
      await onRefresh();
      onNotify(`Deleted article ${deletedId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete article', 'error');
    } finally {
      setRevBusy(false);
    }
  };

  const handleInlinePublishFromReview = async (targetAccount: Account) => {
    if (!reviewingDraft) return;
    setRevBusy(true);
    try {
      await api.updateDraft(reviewingDraft.id, {
        title: revTitle,
        content: revContent,
        media_paths: revMedia,
      });
      await handleAccountPublishDraft(reviewingDraft.id, targetAccount);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to save and publish article', 'error');
    } finally {
      setRevBusy(false);
    }
  };

  const filteredGenerateSources = useMemo(() => {
    const sorted = [...sourcePosts].sort(
      (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime()
    );
    if (!genPostSearch.trim()) return sorted;
    const q = genPostSearch.toLowerCase();
    return sorted.filter(
      (sp) =>
        sp.id.toLowerCase().includes(q) ||
        sp.author.toLowerCase().includes(q) ||
        sp.content.toLowerCase().includes(q) ||
        sp.cashtags.some((c) => c.toLowerCase().includes(q))
    );
  }, [sourcePosts, genPostSearch]);

  const publishableDrafts = useMemo(() => {
    if (!publishAccount) return [];
    const accountPersona = personas.find((p) => p.account_id === publishAccount.id);
    const base = drafts.filter((d) => {
      if (d.status === 'published' || d.status === 'rejected') return false;
      if (publishScope === 'account' && accountPersona) {
        return d.persona_id === accountPersona.id;
      }
      return true;
    });
    const searched = publishSearch.trim()
      ? base.filter((d) => {
          const q = publishSearch.toLowerCase();
          return (
            d.id.toLowerCase().includes(q) ||
            d.title.toLowerCase().includes(q) ||
            d.content.toLowerCase().includes(q)
          );
        })
      : base;
    return [...searched].sort(
      (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
    );
  }, [drafts, personas, publishAccount, publishScope, publishSearch]);

  const renderAccountCard = (acc: Account) => {
    const profile = browserProfiles.find((bp) => bp.account_id === acc.id);
    const persona = personas.find((p) => p.account_id === acc.id);
    const isBusy = busyId === acc.id;
    const isBrowserRunning =
      activeBrowserAccountIds.includes(acc.id) ||
      jobs.some(
        (j) =>
          j.account_id === acc.id &&
          (j.status === 'running' ||
            j.status === 'queued' ||
            j.status === 'awaiting_mfa' ||
            j.status === 'awaiting_captcha')
      );
    const accountDrafts = persona ? drafts.filter((d) => d.persona_id === persona.id) : [];
    const readyDraftCount = accountDrafts.filter(
      (d) => d.status !== 'published' && d.status !== 'rejected'
    ).length;
    const publishedCount = accountDrafts.filter((d) => d.status === 'published').length;

    return (
      <div
        key={acc.id}
        className="rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-[#EAECEF]">{acc.label}</h3>
              <span className="font-mono text-[11px] uppercase text-slate-400">
                {acc.role === 'scraper' ? 'Read-Only Scraper' : 'Publisher'}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="font-mono text-[11px] text-slate-500">{acc.id}</span>
              {isBrowserRunning && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="font-mono text-[11px] font-medium text-emerald-400">
                    Browser Running
                  </span>
                </>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Login: <span className="text-slate-200">{acc.login_identifier || 'Not configured'}</span>
              <span aria-hidden="true" className="mx-2 text-slate-600">·</span>
              Password: <span className="text-slate-300">{acc.has_password ? 'Encrypted in vault' : 'Missing'}</span>
              {acc.role === 'publisher' && (
                <>
                  <span aria-hidden="true" className="mx-2 text-slate-600">·</span>
                  Publish Mode:{' '}
                  {acc.has_square_api_key ? (
                    <span className="font-mono text-emerald-400">
                      Creator OpenAPI ({acc.square_api_key_masked || 'Configured'})
                    </span>
                  ) : (
                    <span className="text-slate-300">Browser Login Fallback</span>
                  )}
                </>
              )}
            </p>
          </div>
          {profile && <HealthStatusLabel status={profile.health_status} />}
        </div>

        {/* Isolated Browser Profile Grid */}
        {profile && (
          <div
            className={`grid grid-cols-1 ${
              profile.has_proxy ? 'sm:grid-cols-3' : 'sm:grid-cols-2'
            } gap-3 rounded border border-white/[0.08] bg-[#0E121A] p-3.5 text-xs`}
          >
            <div>
              <span className="block text-[11px] text-slate-500">Connection</span>
              <span className="mt-0.5 block font-mono text-slate-200">
                {profile.has_proxy ? profile.proxy_display : 'Direct (No Proxy)'}
              </span>
            </div>
            {profile.has_proxy && (
              <div>
                <span className="block text-[11px] text-slate-500">
                  Detected Country / Timezone / Locale
                </span>
                <span className="mt-0.5 block font-mono text-slate-200">
                  {profile.proxy_country && profile.proxy_timezone
                    ? `${profile.proxy_country} · ${profile.proxy_timezone} · ${profile.proxy_locale}`
                    : 'Auto-detected on proxy/auth check'}
                </span>
              </div>
            )}
            <div>
              <span className="block text-[11px] text-slate-500">Dechromium Profile &amp; Cookies</span>
              <span className="mt-0.5 block font-mono text-slate-200 tabular-nums">
                {profile.cookie_count} cookies · {profile.viewport_width}×{profile.viewport_height}
              </span>
            </div>
          </div>
        )}

        {/* 1-to-1 Persona summary if Publisher */}
        {acc.role === 'publisher' && (
          <div className="rounded border border-white/[0.08] bg-[#0E121A] p-3.5 space-y-1.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[#F0B90B]">
                Persona: {persona?.display_name || acc.label}
              </span>
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {persona ? `${persona.posting_frequency} · Hours: ${persona.active_hours.join(', ')} · ` : ''}
                Ready: {readyDraftCount} · Published: {publishedCount}
              </span>
            </div>
            {persona?.bio && <p className="text-slate-300">{persona.bio}</p>}
            {persona && (
              <p className="text-slate-400">
                Niche: {persona.niche.join(', ')} · Tone: {persona.tone}
              </p>
            )}
            {persona && (
              <p className="text-[11px] font-mono text-slate-400 flex items-center gap-1.5">
                <FileText className="h-3 w-3 text-[#F0B90B] shrink-0" />
                <span>
                  Model Writing Rules File: {persona.writing_rules_file || `data/persona_rules/${persona.id}.md`} ·{' '}
                  {(persona.writing_rules || '').trim().length} chars
                </span>
              </p>
            )}
          </div>
        )}

        {/* Action Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            {acc.role === 'publisher' && (
              <>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => openGenerateForAccount(acc, persona)}
                  className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => openPublishForAccount(acc, persona)}
                  className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                  Publish
                </button>
              </>
            )}

            <button
              type="button"
              disabled={isBusy}
              onClick={() => openEditAccount(acc, profile)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Globe className="h-3.5 w-3.5" />
              Edit Credentials & Proxy
            </button>

            {acc.role === 'publisher' && persona && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => openEditPersona(persona)}
                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <UserCog className="h-3.5 w-3.5" />
                Edit Persona Voice
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {profile?.has_proxy && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => handleCheckProxy(acc.id, acc.label)}
                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
              >
                <Globe className="h-3.5 w-3.5" />
                Check Proxy
              </button>
            )}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleClearCookies(acc)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Cookie className="h-3.5 w-3.5" />
              Reset Cookies
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleAuthCheck(acc)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] px-3.5 py-1.5 text-xs font-semibold text-slate-100 hover:bg-white/10 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Verify / Auto-Login
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleKillBrowser(acc)}
              title="Stop, quit, and close this account's isolated Chromium browser"
              className={`inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 whitespace-nowrap shrink-0 ${
                isBrowserRunning
                  ? 'border-rose-500/70 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                  : 'border-rose-500/35 bg-rose-500/[0.07] text-rose-300 hover:bg-rose-500/15 hover:border-rose-500/55'
              }`}
            >
              <PowerOff className="h-3.5 w-3.5" />
              Kill Browser
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => handleDeleteAccount(acc)}
              className="rounded border border-white/10 p-1.5 text-slate-400 hover:text-rose-400"
              title="Delete account"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div>
          <h2 className="text-base font-semibold text-[#EAECEF]">
            Isolated Accounts, Proxies & 1-to-1 Personas
          </h2>
          <p className="text-xs text-slate-400">
            Strictly separates the read-only Scraper account from Publishing accounts. Each profile isolates cookies, timezone, locale, and optional <span className="font-mono">socks5h://</span> residential proxies.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] whitespace-nowrap shrink-0"
        >
          <Plus className="h-4 w-4" />
          Add Isolated Account
        </button>
      </div>

      {/* Independent Scraper Section */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <Shield className="h-4 w-4 text-[#F0B90B]" />
          <span>Independent Scraper Node (Read-Only · Never Publishes)</span>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {scraperAccounts.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-[#12161F] p-6 text-xs text-slate-400">
              No dedicated scraper account configured. Add one with role "Read-Only Scraper".
            </div>
          ) : (
            scraperAccounts.map(renderAccountCard)
          )}
        </div>
      </section>

      {/* Publisher Accounts Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
          <span>Publisher Accounts & 1-to-1 Personas ({publisherAccounts.length})</span>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {publisherAccounts.map(renderAccountCard)}
        </div>
      </section>

      {/* Create Account Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-lg border border-white/10 bg-[#12161F] shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <h3 className="text-base font-semibold text-[#EAECEF]">Add Isolated Binance Account</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateAccount} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Account Role</label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as AccountRole)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  >
                    <option value="publisher">Publisher (1:1 Persona)</option>
                    <option value="scraper">Read-Only Scraper</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Account Label</label>
                  <input
                    required
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. Alpha Macro Publisher"
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">
                    Binance Email / Phone
                  </label>
                  <input
                    value={newLoginId}
                    onChange={(e) => setNewLoginId(e.target.value)}
                    placeholder="account@domain.com"
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Binance Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Encrypted locally"
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">
                  Proxy URL (Optional — leave blank to run directly without proxy)
                </label>
                <input
                  value={newProxyUrl}
                  onChange={(e) => setNewProxyUrl(e.target.value)}
                  placeholder="socks5h://user:pass@host:port (or http://, https://, socks5://)"
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                />
                {newProxyUrl.trim() && (
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    Country, timezone, and locale are checked and filled automatically from the proxy exit IP when created.
                  </p>
                )}
              </div>

              {newProxyUrl.trim() && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">Country ISO (Auto)</label>
                    <input
                      value={newCountry}
                      onChange={(e) => setNewCountry(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">IANA Timezone (Auto)</label>
                    <input
                      value={newTimezone}
                      onChange={(e) => setNewTimezone(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">Locale (Auto)</label>
                    <input
                      value={newLocale}
                      onChange={(e) => setNewLocale(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                </div>
              )}

              {newRole === 'publisher' && (
                <div className="space-y-3 border-t border-white/10 pt-3">
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">
                      Binance Square Creator OpenAPI Key (Optional)
                    </label>
                    <input
                      type="password"
                      value={newSquareApiKey}
                      onChange={(e) => setNewSquareApiKey(e.target.value)}
                      placeholder="Paste X-Square-OpenAPI-Key (encrypted locally; leave blank to login & publish via browser)"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      When configured, publishing posts directly via Binance Square Creator OpenAPI without browser login. Leave blank to auto-login via Playwright.
                    </p>
                  </div>

                  <p className="font-semibold text-[#F0B90B]">1-to-1 Persona Setup</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block font-medium text-slate-300">Persona Display Name</label>
                      <input
                        value={newPersonaName}
                        onChange={(e) => setNewPersonaName(e.target.value)}
                        placeholder="The DeFi Desk"
                        className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-slate-300">API Key Vault Ref</label>
                      <input
                        value={newApiKeyRef}
                        onChange={(e) => setNewApiKeyRef(e.target.value)}
                        placeholder="vault://binance/key_04"
                        className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block font-medium text-slate-300">Niche Tags (comma-separated)</label>
                      <input
                        value={newPersonaNiche}
                        onChange={(e) => setNewPersonaNiche(e.target.value)}
                        className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-medium text-slate-300">Active Hours (comma-separated)</label>
                      <input
                        value={newPersonaHours}
                        onChange={(e) => setNewPersonaHours(e.target.value)}
                        className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">Voice & Tone</label>
                    <input
                      value={newPersonaTone}
                      onChange={(e) => setNewPersonaTone(e.target.value)}
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded border border-white/15 px-4 py-2 text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-5 py-2 font-semibold text-[#0B0E14] hover:bg-[#FCD535]"
                >
                  <Check className="h-3.5 w-3.5" />
                  Create Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Account & Proxy Modal */}
      {editingAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-lg border border-white/10 bg-[#12161F] shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <h3 className="text-base font-semibold text-[#EAECEF]">
                Configure {editingAccount.label}
              </h3>
              <button
                onClick={() => setEditingAccount(null)}
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSaveAccount} className="p-6 space-y-4 text-xs">
              <div>
                <label className="mb-1 block font-medium text-slate-300">Account Label</label>
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Binance Email / Phone</label>
                  <input
                    value={editLoginId}
                    onChange={(e) => setEditLoginId(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">
                    New Password (leave blank to keep current)
                  </label>
                  <input
                    type="password"
                    value={editPassword}
                    onChange={(e) => setEditPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">
                  Proxy URL (Optional — <span className="font-mono">socks5h://</span> recommended; leave blank to skip proxy)
                </label>
                <input
                  value={editProxyUrl}
                  onChange={(e) => setEditProxyUrl(e.target.value)}
                  disabled={clearProxy}
                  placeholder={editHasProxy ? 'Leave blank to keep existing proxy, or enter new proxy URL' : 'socks5h://user:pass@host:port'}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF] disabled:opacity-40"
                />
                {editHasProxy && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-slate-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={clearProxy}
                        onChange={(e) => setClearProxy(e.target.checked)}
                        className="accent-[#F0B90B]"
                      />
                      Remove proxy and run direct connection (skip proxy)
                    </label>
                    {!clearProxy && (
                      <button
                        type="button"
                        disabled={busyId === editingAccount.id}
                        onClick={() => handleCheckProxy(editingAccount.id, editingAccount.label)}
                        className="inline-flex items-center gap-1 rounded border border-white/15 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-white/5"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Check &amp; Auto-Fill Proxy Geo
                      </button>
                    )}
                  </div>
                )}
              </div>

              {!clearProxy && (editHasProxy || Boolean(editProxyUrl.trim())) && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">Country ISO</label>
                    <input
                      value={editCountry}
                      onChange={(e) => setEditCountry(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">IANA Timezone</label>
                    <input
                      value={editTimezone}
                      onChange={(e) => setEditTimezone(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-medium text-slate-300">Locale</label>
                    <input
                      value={editLocale}
                      onChange={(e) => setEditLocale(e.target.value)}
                      placeholder="Auto-detect"
                      className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                    />
                  </div>
                </div>
              )}

              {editingAccount.role === 'publisher' && (
                <div className="rounded border border-white/10 bg-[#0E121A] p-3.5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="font-medium text-slate-200">
                      Binance Square Creator OpenAPI Key
                    </label>
                    <span className="font-mono text-[11px] text-slate-400">
                      {editHasSquareApiKey && !clearSquareApiKey
                        ? `Saved: ${editingAccount.square_api_key_masked || 'Encrypted'}`
                        : 'Not set (uses browser login)'}
                    </span>
                  </div>
                  <input
                    type="password"
                    value={editSquareApiKey}
                    onChange={(e) => setEditSquareApiKey(e.target.value)}
                    disabled={clearSquareApiKey}
                    placeholder={
                      editHasSquareApiKey
                        ? 'Leave blank to keep existing Creator OpenAPI key, or paste a new key'
                        : 'Paste X-Square-OpenAPI-Key (encrypted locally)'
                    }
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF] disabled:opacity-40"
                  />
                  <p className="text-[11px] text-slate-500">
                    If set, publishing sends directly via Binance Square Creator OpenAPI. If unset, publishing automatically logs in and posts via browser.
                  </p>
                  {editHasSquareApiKey && (
                    <label className="inline-flex items-center gap-2 text-slate-400 cursor-pointer pt-0.5">
                      <input
                        type="checkbox"
                        checked={clearSquareApiKey}
                        onChange={(e) => setClearSquareApiKey(e.target.checked)}
                        className="accent-[#F0B90B]"
                      />
                      Remove Creator OpenAPI Key (fall back to Playwright browser login &amp; publish)
                    </label>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Viewport Width</label>
                  <input
                    type="number"
                    value={editWidth}
                    onChange={(e) => setEditWidth(Number(e.target.value))}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Viewport Height</label>
                  <input
                    type="number"
                    value={editHeight}
                    onChange={(e) => setEditHeight(Number(e.target.value))}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Vault Key Ref</label>
                  <input
                    value={editApiKeyRef}
                    onChange={(e) => setEditApiKeyRef(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingAccount(null)}
                  className="rounded border border-white/15 px-4 py-2 text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-[#F0B90B] px-5 py-2 font-semibold text-[#0B0E14] hover:bg-[#FCD535]"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Persona Modal */}
      {editingPersona && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-lg border border-white/10 bg-[#12161F] shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <h3 className="text-base font-semibold text-[#EAECEF]">
                Edit Persona: {editingPersona.display_name}
              </h3>
              <button
                onClick={() => setEditingPersona(null)}
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSavePersona} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Display Name</label>
                  <input
                    value={perDisplayName}
                    onChange={(e) => setPerDisplayName(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Posting Frequency</label>
                  <input
                    value={perFrequency}
                    onChange={(e) => setPerFrequency(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">Bio / Editorial Identity</label>
                <input
                  value={perBio}
                  onChange={(e) => setPerBio(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Niche (comma-separated)</label>
                  <input
                    value={perNiche}
                    onChange={(e) => setPerNiche(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                  />
                </div>
                <div>
                  <label className="mb-1 block font-medium text-slate-300">Staggered Active Hours</label>
                  <input
                    value={perHours}
                    onChange={(e) => setPerHours(e.target.value)}
                    className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">Voice & Tone</label>
                <input
                  value={perTone}
                  onChange={(e) => setPerTone(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">Banned Topics (comma-separated)</label>
                <input
                  value={perBanned}
                  onChange={(e) => setPerBanned(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-300">
                  Style Examples (one example per line)
                </label>
                <textarea
                  rows={3}
                  value={perExamples}
                  onChange={(e) => setPerExamples(e.target.value)}
                  className="w-full rounded border border-white/15 bg-[#0B0E14] p-3 text-[#EAECEF]"
                />
              </div>

              <div className="border-t border-white/10 pt-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <label className="block font-medium text-[#F0B90B]">
                      Model Writing &amp; Article Shape Rules File
                    </label>
                    <p className="text-[11px] font-mono text-slate-400">
                      {editingPersona.writing_rules_file || `data/persona_rules/${editingPersona.id}.md`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/[0.08] cursor-pointer">
                      <Upload className="h-3 w-3" />
                      Load .md / .txt
                      <input
                        type="file"
                        accept=".md,.txt,text/markdown,text/plain"
                        className="hidden"
                        onChange={async (ev) => {
                          const file = ev.target.files?.[0];
                          if (!file) return;
                          const text = await file.text();
                          setPerWritingRules(text);
                          ev.target.value = '';
                        }}
                      />
                    </label>
                    <a
                      href={api.getPersonaRulesFileUrl(editingPersona.id, true)}
                      className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/[0.08]"
                    >
                      <Download className="h-3 w-3" />
                      Download .md
                    </a>
                  </div>
                </div>
                <textarea
                  rows={7}
                  value={perWritingRules}
                  onChange={(e) => setPerWritingRules(e.target.value)}
                  placeholder="Define exact opening hook rules, section structure, paragraph pacing, formatting rules, and sign-off conventions for the AI model..."
                  className="w-full rounded border border-white/15 bg-[#0B0E14] p-3 font-mono text-xs text-[#EAECEF] leading-relaxed"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPersona(null)}
                  className="rounded border border-white/15 px-4 py-2 text-slate-300 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-[#F0B90B] px-5 py-2 font-semibold text-[#0B0E14] hover:bg-[#FCD535]"
                >
                  Save Persona
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Per-Account Generate Modal */}
      {generateAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div
            className={`w-full rounded-lg border border-white/10 bg-[#12161F] shadow-2xl max-h-[90vh] overflow-y-auto ${
              reviewingDraft && reviewOrigin === 'generate' ? 'max-w-3xl' : 'max-w-2xl'
            }`}
          >
            {(() => {
              const targetPersona = personas.find((p) => p.account_id === generateAccount.id);
              const selectedProvider = providers.find((p) => p.id === genProviderId);
              const showInlineReview = Boolean(reviewingDraft && reviewOrigin === 'generate');

              return (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-white/10 px-6 py-4">
                    <div className="min-w-0">
                      {showInlineReview && reviewingDraft ? (
                        <div className="space-y-1">
                          <button
                            type="button"
                            onClick={() => setReviewingDraftId(null)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#F0B90B] hover:text-[#FCD535] whitespace-nowrap shrink-0"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" />
                            Back to {generateAccount.label} Preview
                          </button>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className="font-mono text-[#EAECEF]">{reviewingDraft.id}</span>
                            <span aria-hidden="true">·</span>
                            <span>{targetPersona?.display_name || generateAccount.label}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {reviewingDraft.llm_provider}/{reviewingDraft.llm_model}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h3 className="text-base font-semibold text-[#EAECEF]">
                            Generate Article · {generateAccount.label}
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            Persona: {targetPersona?.display_name || generateAccount.label}
                            {targetPersona ? ` · ${targetPersona.tone}` : ''}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {showInlineReview && reviewingDraft ? (
                        <DraftStatusLabel status={reviewingDraft.status} />
                      ) : (
                        targetPersona && (
                          <button
                            type="button"
                            onClick={() => {
                              setGenerateAccount(null);
                              setReviewingDraftId(null);
                              onOpenGeneratorForPersona(targetPersona.id);
                            }}
                            className="inline-flex items-center gap-1 rounded border border-white/15 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
                          >
                            Standalone Lab
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </button>
                        )
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setGenerateAccount(null);
                          setGenCreatedDraft(null);
                          setReviewingDraftId(null);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {showInlineReview && reviewingDraft ? (
                    <div className="divide-y divide-white/10">
                      <div className="p-6 space-y-4">
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-300">
                            Article Headline / Internal Title
                          </label>
                            <input
                              type="text"
                              value={revTitle}
                              onChange={(e) => setRevTitle(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-2 text-sm text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>

                          <div>
                            <div className="mb-1.5 flex items-center justify-between">
                              <label className="text-xs font-medium text-slate-300">
                                Binance Square Post Content
                              </label>
                              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                {revContent.length} chars · {countWords(revContent)} words ·{' '}
                                {countSymbols(revContent)} symbols
                              </span>
                            </div>
                            <textarea
                              rows={9}
                              value={revContent}
                              onChange={(e) => setRevContent(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 text-sm leading-relaxed text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="block text-xs font-medium text-slate-300">
                              Media Paths / Cover Images (Max 4)
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newRevMediaUrl}
                                onChange={(e) => setNewRevMediaUrl(e.target.value)}
                                placeholder="/path/to/chart.png or image path..."
                                className="flex-1 rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={addInlineMediaPath}
                                disabled={revMedia.length >= 4}
                                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                              >
                                <ImagePlus className="h-3.5 w-3.5" />
                                Attach
                              </button>
                            </div>
                            {revMedia.length > 0 && (
                              <div className="space-y-1">
                                {revMedia.map((m, idx) => (
                                  <div
                                    key={`${m}-${idx}`}
                                    className="flex items-center justify-between rounded bg-[#0B0E14] px-2.5 py-1.5 text-xs text-slate-300"
                                  >
                                    <span className="truncate font-mono">{m}</span>
                                    <button
                                      type="button"
                                      onClick={() => setRevMedia(revMedia.filter((_, i) => i !== idx))}
                                      className="ml-2 text-slate-500 hover:text-rose-400"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="space-y-2 pt-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <label className="text-xs font-medium text-slate-300">
                                Staggered Publish Time
                              </label>
                              {targetPersona && targetPersona.active_hours.length > 0 && (
                                <div className="flex items-center gap-1.5 text-xs">
                                  <span className="text-slate-500">Active slots:</span>
                                  {targetPersona.active_hours.map((slot) => (
                                    <button
                                      key={slot}
                                      type="button"
                                      onClick={() => applyInlineHourSlot(slot)}
                                      className="rounded border border-white/10 px-2 py-0.5 font-mono text-[11px] text-slate-300 hover:border-[#F0B90B] hover:text-[#F0B90B]"
                                    >
                                      {slot}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <input
                              type="datetime-local"
                              value={revSchedule}
                              onChange={(e) => setRevSchedule(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 font-mono text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>
                        </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 bg-[#0E121A]">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview()}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Save className="h-3.5 w-3.5" />
                            Save Edits
                          </button>
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview('rejected')}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <X className="h-3.5 w-3.5" />
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={handleInlineDeleteReview}
                            className="inline-flex items-center gap-1.5 rounded px-2.5 py-2 text-xs font-medium text-slate-400 hover:text-rose-400 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview('approved')}
                            className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={revBusy || !revSchedule}
                            onClick={() => handleInlineSaveReview('scheduled')}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            Schedule
                          </button>
                          <button
                            type="button"
                            disabled={
                              revBusy ||
                              publishingDraftId === reviewingDraft.id ||
                              reviewingDraft.status === 'publishing'
                            }
                            onClick={() => handleInlinePublishFromReview(generateAccount)}
                            className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            {revBusy || publishingDraftId === reviewingDraft.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Publish Now on {generateAccount.label}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : genCreatedDraft ? (
                    <div className="p-6 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 tabular-nums">
                        <span className="font-mono text-[#F0B90B]">{genCreatedDraft.id}</span>
                        <span>
                          {countWords(genCreatedDraft.content)} words ·{' '}
                          {countSymbols(genCreatedDraft.content)} symbols
                        </span>
                      </div>
                      <h4 className="font-display text-lg font-semibold text-[#EAECEF]">
                        {genCreatedDraft.title}
                      </h4>
                      <div className="max-h-64 overflow-y-auto rounded border border-white/10 bg-[#0B0E14] p-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
                        {genCreatedDraft.content}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                        <button
                          type="button"
                          onClick={() => setGenCreatedDraft(null)}
                          className="rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-white/5"
                        >
                          Generate Another
                        </button>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openInlineReview(genCreatedDraft, 'generate')}
                            className="rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
                          >
                            Review &amp; Edit
                          </button>
                          <button
                            type="button"
                            disabled={publishingDraftId === genCreatedDraft.id}
                            onClick={() =>
                              handleAccountPublishDraft(genCreatedDraft.id, generateAccount)
                            }
                            className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Send className="h-3.5 w-3.5" />
                            Publish Now on {generateAccount.label}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-6 space-y-4 text-xs">
                      {/* Source Post Picker */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="font-semibold text-slate-300">
                            Scraped Source Posts ({genPostIds.length} selected)
                          </label>
                          <div className="relative w-56">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                            <input
                              type="text"
                              value={genPostSearch}
                              onChange={(e) => setGenPostSearch(e.target.value)}
                              placeholder="Filter scraped posts..."
                              className="w-full rounded border border-white/10 bg-[#0B0E14] py-1.5 pl-8 pr-2.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>
                        </div>

                        {filteredGenerateSources.length === 0 ? (
                          <div className="rounded border border-white/10 bg-[#0B0E14] p-4 text-center text-slate-500">
                            No scraped source posts available. Run the Scraper first.
                          </div>
                        ) : (
                          <div className="max-h-48 overflow-y-auto divide-y divide-white/[0.06] rounded border border-white/10 bg-[#0B0E14]">
                            {filteredGenerateSources.map((sp) => {
                              const checked = genPostIds.includes(sp.id);
                              const alreadyUsed = targetPersona
                                ? sp.used_by_persona_ids.includes(targetPersona.id)
                                : false;
                              return (
                                <label
                                  key={sp.id}
                                  className={`flex items-start gap-3 p-3 cursor-pointer transition-colors ${
                                    checked ? 'bg-[#1A202C]' : 'hover:bg-white/[0.03]'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      setGenPostIds((prev) =>
                                        prev.includes(sp.id)
                                          ? prev.filter((id) => id !== sp.id)
                                          : [...prev, sp.id]
                                      )
                                    }
                                    className="mt-0.5 h-4 w-4 accent-[#F0B90B]"
                                  />
                                  <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="flex flex-wrap items-center gap-2 text-slate-400">
                                      <span className="font-medium text-slate-200">{sp.author}</span>
                                      <span aria-hidden="true">·</span>
                                      <span className="capitalize">{sp.feed_tab}</span>
                                      {alreadyUsed && (
                                        <>
                                          <span aria-hidden="true">·</span>
                                          <span className="text-amber-400">Already covered</span>
                                        </>
                                      )}
                                    </div>
                                    <p className="text-slate-300 line-clamp-2">{sp.content}</p>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="mb-1 block font-medium text-slate-400">AI Provider</label>
                          <select
                            value={genProviderId}
                            onChange={(e) => {
                              const nextId = e.target.value as ProviderId;
                              setGenProviderId(nextId);
                              const prov = providers.find((p) => p.id === nextId);
                              setGenModel(
                                prov?.selected_model || prov?.available_models[0] || ''
                              );
                            }}
                            className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                          >
                            {providers.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.provider_name} {p.validated ? '(Validated)' : '(Unverified)'}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-1 block font-medium text-slate-400">Model</label>
                          <select
                            value={genModel}
                            onChange={(e) => setGenModel(e.target.value)}
                            className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 font-mono text-[#EAECEF]"
                          >
                            {(selectedProvider?.available_models || []).map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="mb-1 block font-medium text-slate-400">Post Format</label>
                          <select
                            value={genFormat}
                            onChange={(e) =>
                              setGenFormat(e.target.value as 'short_post' | 'long_article')
                            }
                            className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF]"
                          >
                            <option value="short_post">Short Post (90–180w)</option>
                            <option value="long_article">Long Article (350–550w)</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="mb-1 block font-medium text-slate-400">
                          Optional Custom Angle / Directive
                        </label>
                        <input
                          type="text"
                          value={genCustomAngle}
                          onChange={(e) => setGenCustomAngle(e.target.value)}
                          placeholder="e.g. Focus on ETF flow divergence and spot liquidity..."
                          className="w-full rounded border border-white/15 bg-[#0B0E14] px-3 py-2 text-[#EAECEF] placeholder:text-slate-600 focus:border-[#F0B90B] focus:outline-none"
                        />
                      </div>

                      <div className="flex justify-end gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setGenerateAccount(null)}
                          className="rounded border border-white/15 px-4 py-2 text-slate-300 hover:bg-white/5"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={genBusy || genPostIds.length === 0}
                          onClick={handleAccountGenerate}
                          className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-5 py-2 font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                        >
                          {genBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                          {genBusy ? 'Generating...' : `Generate for ${generateAccount.label}`}
                        </button>
                      </div>

                      {genLogs.length > 0 && (
                        <div className="space-y-1.5 border-t border-white/10 pt-3">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                            <Terminal className="h-3.5 w-3.5 text-[#F0B90B]" />
                            <span>Generation Pipe Log</span>
                          </div>
                          <div className="rounded border border-white/10 bg-[#0B0E14] p-3 font-mono text-[11px] space-y-1 max-h-40 overflow-y-auto">
                            {genLogs.map((entry, idx) => (
                              <div key={`${entry.ts}-${idx}`} className="flex items-start gap-2 leading-relaxed">
                                <span className="text-slate-600 shrink-0 tabular-nums">
                                  {new Date(entry.ts).toLocaleTimeString()}
                                </span>
                                <span
                                  className={`shrink-0 font-semibold ${
                                    entry.level === 'error'
                                      ? 'text-rose-400'
                                      : entry.level === 'success'
                                      ? 'text-emerald-400'
                                      : 'text-[#F0B90B]'
                                  }`}
                                >
                                  [{entry.step}]
                                </span>
                                <span
                                  className={`break-words ${
                                    entry.level === 'error'
                                      ? 'text-rose-300'
                                      : entry.level === 'success'
                                      ? 'text-emerald-200'
                                      : 'text-slate-300'
                                  }`}
                                >
                                  {entry.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Per-Account Publish & Inline Review Modal */}
      {publishAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div
            className={`w-full rounded-lg border border-white/10 bg-[#12161F] shadow-2xl max-h-[90vh] overflow-y-auto ${
              reviewingDraft && reviewOrigin === 'publish' ? 'max-w-3xl' : 'max-w-2xl'
            }`}
          >
            {(() => {
              const targetPersona = personas.find((p) => p.account_id === publishAccount.id);
              const accountQueueCount = targetPersona
                ? drafts.filter(
                    (d) =>
                      d.persona_id === targetPersona.id &&
                      d.status !== 'published' &&
                      d.status !== 'rejected'
                  ).length
                : 0;
              const allUnpublishedCount = drafts.filter(
                (d) => d.status !== 'published' && d.status !== 'rejected'
              ).length;
              const showInlineReview = Boolean(reviewingDraft && reviewOrigin === 'publish');
              const reviewIdx = reviewingDraft
                ? publishableDrafts.findIndex((d) => d.id === reviewingDraft.id)
                : -1;
              const prevReviewDraft =
                reviewIdx > 0 ? publishableDrafts[reviewIdx - 1] : null;
              const nextReviewDraft =
                reviewIdx >= 0 && reviewIdx < publishableDrafts.length - 1
                  ? publishableDrafts[reviewIdx + 1]
                  : null;
              const reviewPersona = reviewingDraft
                ? personas.find((p) => p.id === reviewingDraft.persona_id)
                : undefined;
              const activeHours =
                targetPersona?.active_hours?.length
                  ? targetPersona.active_hours
                  : reviewPersona?.active_hours || [];

              return (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-white/10 px-6 py-4">
                    <div className="min-w-0">
                      {showInlineReview && reviewingDraft ? (
                        <div className="space-y-1">
                          <button
                            type="button"
                            onClick={() => setReviewingDraftId(null)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#F0B90B] hover:text-[#FCD535] whitespace-nowrap shrink-0"
                          >
                            <ArrowLeft className="h-3.5 w-3.5" />
                            Back to {publishAccount.label} Articles
                          </button>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className="font-mono text-[#EAECEF]">{reviewingDraft.id}</span>
                            <span aria-hidden="true">·</span>
                            <span>{reviewPersona?.display_name || reviewingDraft.persona_id}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {reviewingDraft.llm_provider}/{reviewingDraft.llm_model}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h3 className="text-base font-semibold text-[#EAECEF]">
                            Publish via {publishAccount.label}
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-400">
                            {publishAccount.has_square_api_key
                              ? `Review articles inline on ${publishAccount.label} or dispatch directly via saved Binance Square Creator OpenAPI key (${publishAccount.square_api_key_masked || 'Encrypted'}).`
                              : `Review articles inline on ${publishAccount.label} or dispatch via its isolated Chromium browser login, cookies, and proxy (no Creator API key set).`}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {showInlineReview && reviewingDraft && (
                        <>
                          {publishableDrafts.length > 1 && reviewIdx >= 0 && (
                            <div className="flex items-center gap-1 rounded border border-white/10 bg-[#0B0E14] px-1.5 py-1 text-xs">
                              <button
                                type="button"
                                disabled={!prevReviewDraft}
                                onClick={() =>
                                  prevReviewDraft && openInlineReview(prevReviewDraft, 'publish')
                                }
                                title="Previous article"
                                className="rounded p-0.5 text-slate-300 hover:bg-white/10 disabled:opacity-30"
                              >
                                <ChevronLeft className="h-3.5 w-3.5" />
                              </button>
                              <span className="px-1.5 font-mono text-[11px] text-slate-400 tabular-nums">
                                {reviewIdx + 1}/{publishableDrafts.length}
                              </span>
                              <button
                                type="button"
                                disabled={!nextReviewDraft}
                                onClick={() =>
                                  nextReviewDraft && openInlineReview(nextReviewDraft, 'publish')
                                }
                                title="Next article"
                                className="rounded p-0.5 text-slate-300 hover:bg-white/10 disabled:opacity-30"
                              >
                                <ChevronRight className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          <DraftStatusLabel status={reviewingDraft.status} />
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setPublishAccount(null);
                          setReviewingDraftId(null);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-white"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {showInlineReview && reviewingDraft ? (
                    <div className="divide-y divide-white/10">
                      <div className="p-6 space-y-4">
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-slate-300">
                            Article Headline / Internal Title
                          </label>
                            <input
                              type="text"
                              value={revTitle}
                              onChange={(e) => setRevTitle(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-2 text-sm text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>

                          <div>
                            <div className="mb-1.5 flex items-center justify-between">
                              <label className="text-xs font-medium text-slate-300">
                                Binance Square Post Content
                              </label>
                              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                {revContent.length} chars · {countWords(revContent)} words ·{' '}
                                {countSymbols(revContent)} symbols
                              </span>
                            </div>
                            <textarea
                              rows={9}
                              value={revContent}
                              onChange={(e) => setRevContent(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 text-sm leading-relaxed text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="block text-xs font-medium text-slate-300">
                              Media Paths / Cover Images (Max 4)
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={newRevMediaUrl}
                                onChange={(e) => setNewRevMediaUrl(e.target.value)}
                                placeholder="/path/to/chart.png or image path..."
                                className="flex-1 rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={addInlineMediaPath}
                                disabled={revMedia.length >= 4}
                                className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                              >
                                <ImagePlus className="h-3.5 w-3.5" />
                                Attach
                              </button>
                            </div>
                            {revMedia.length > 0 && (
                              <div className="space-y-1">
                                {revMedia.map((m, idx) => (
                                  <div
                                    key={`${m}-${idx}`}
                                    className="flex items-center justify-between rounded bg-[#0B0E14] px-2.5 py-1.5 text-xs text-slate-300"
                                  >
                                    <span className="truncate font-mono">{m}</span>
                                    <button
                                      type="button"
                                      onClick={() => setRevMedia(revMedia.filter((_, i) => i !== idx))}
                                      className="ml-2 text-slate-500 hover:text-rose-400"
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="space-y-2 pt-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <label className="text-xs font-medium text-slate-300">
                                Staggered Publish Time
                              </label>
                              {activeHours.length > 0 && (
                                <div className="flex items-center gap-1.5 text-xs">
                                  <span className="text-slate-500">Active slots:</span>
                                  {activeHours.map((slot) => (
                                    <button
                                      key={slot}
                                      type="button"
                                      onClick={() => applyInlineHourSlot(slot)}
                                      className="rounded border border-white/10 px-2 py-0.5 font-mono text-[11px] text-slate-300 hover:border-[#F0B90B] hover:text-[#F0B90B]"
                                    >
                                      {slot}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <input
                              type="datetime-local"
                              value={revSchedule}
                              onChange={(e) => setRevSchedule(e.target.value)}
                              className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 font-mono text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                            />
                          </div>
                        </div>

                      {/* Inline Review Action Bar */}
                      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 bg-[#0E121A]">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview()}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Save className="h-3.5 w-3.5" />
                            Save Edits
                          </button>
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview('rejected')}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <X className="h-3.5 w-3.5" />
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={handleInlineDeleteReview}
                            className="inline-flex items-center gap-1.5 rounded px-2.5 py-2 text-xs font-medium text-slate-400 hover:text-rose-400 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={revBusy}
                            onClick={() => handleInlineSaveReview('approved')}
                            className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-500/10 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={revBusy || !revSchedule}
                            onClick={() => handleInlineSaveReview('scheduled')}
                            className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            Schedule
                          </button>
                          <button
                            type="button"
                            disabled={
                              revBusy ||
                              publishingDraftId === reviewingDraft.id ||
                              reviewingDraft.status === 'publishing'
                            }
                            onClick={() => handleInlinePublishFromReview(publishAccount)}
                            className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            {revBusy || publishingDraftId === reviewingDraft.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Publish Now via {publishAccount.label}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-6 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#0B0E14] p-1 text-xs">
                          <button
                            type="button"
                            onClick={() => setPublishScope('account')}
                            className={`rounded px-3 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                              publishScope === 'account'
                                ? 'bg-[#1D2330] text-[#EAECEF]'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            This Account ({accountQueueCount})
                          </button>
                          <button
                            type="button"
                            onClick={() => setPublishScope('all')}
                            className={`rounded px-3 py-1.5 font-medium transition-colors whitespace-nowrap shrink-0 ${
                              publishScope === 'all'
                                ? 'bg-[#1D2330] text-[#EAECEF]'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            All Unpublished ({allUnpublishedCount})
                          </button>
                        </div>

                        <div className="relative w-60">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                          <input
                            type="text"
                            value={publishSearch}
                            onChange={(e) => setPublishSearch(e.target.value)}
                            placeholder="Search ready articles..."
                            className="w-full rounded border border-white/10 bg-[#0B0E14] py-1.5 pl-8 pr-2.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                          />
                        </div>
                      </div>

                      {publishableDrafts.length === 0 ? (
                        <div className="rounded border border-white/10 bg-[#0B0E14] p-8 text-center space-y-3">
                          <p className="text-sm font-medium text-slate-300">
                            {publishScope === 'account'
                              ? `No unpublished articles queued yet for ${publishAccount.label}`
                              : 'No unpublished articles available'}
                          </p>
                          <div className="flex items-center justify-center gap-2">
                            {publishScope === 'account' && allUnpublishedCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setPublishScope('all')}
                                className="rounded border border-white/15 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5"
                              >
                                Show All Unpublished ({allUnpublishedCount})
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setPublishAccount(null);
                                setReviewingDraftId(null);
                                openGenerateForAccount(publishAccount, targetPersona);
                              }}
                              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535]"
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              Generate Article for {publishAccount.label}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="max-h-96 overflow-y-auto divide-y divide-white/[0.06] rounded border border-white/10 bg-[#0B0E14]">
                          {publishableDrafts.map((article) => {
                            const words = countWords(article.content);
                            const symbols = countSymbols(article.content);
                            const articlePersona = personas.find((p) => p.id === article.persona_id);
                            const isPublishing =
                              publishingDraftId === article.id || article.status === 'publishing';

                            return (
                              <div
                                key={article.id}
                                className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-white/[0.03]"
                              >
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex flex-wrap items-center gap-2 text-xs">
                                    <span className="font-mono text-[#F0B90B]">{article.id}</span>
                                    <span aria-hidden="true" className="text-slate-600">·</span>
                                    <DraftStatusLabel status={article.status} />
                                    {articlePersona && (
                                      <>
                                        <span aria-hidden="true" className="text-slate-600">·</span>
                                        <span className="text-slate-400">{articlePersona.display_name}</span>
                                      </>
                                    )}
                                  </div>
                                  <p className="text-sm text-[#EAECEF] truncate">
                                    {article.title || 'Untitled Article'}
                                  </p>
                                  <p className="text-xs text-slate-400 tabular-nums">
                                    {new Date(article.generated_at).toLocaleString()} · {words} words ·{' '}
                                    {symbols} symbols
                                  </p>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => openInlineReview(article, 'publish')}
                                    className="rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
                                  >
                                    Review
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isPublishing}
                                    onClick={() => handleAccountPublishDraft(article.id, publishAccount)}
                                    className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                                  >
                                    {isPublishing ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Send className="h-3.5 w-3.5" />
                                    )}
                                    Publish Now
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
