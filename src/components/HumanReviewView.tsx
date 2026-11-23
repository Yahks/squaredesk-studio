import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  ExternalLink,
  ImagePlus,
  Save,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { Account, Draft, DraftStatus, Persona, SourcePost } from '../types';
import { DraftStatusLabel } from './StatusText';

interface HumanReviewViewProps {
  drafts: Draft[];
  personas: Persona[];
  accounts: Account[];
  sourcePosts: SourcePost[];
  initialDraftId?: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

const FILTER_TABS: Array<{ key: 'all' | DraftStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'published', label: 'Published' },
  { key: 'failed', label: 'Failed' },
];

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function countSymbols(text: string): number {
  const matches = [...text.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => m[1].toUpperCase());
  return new Set(matches).size;
}

export function HumanReviewView({
  drafts,
  personas,
  accounts,
  sourcePosts,
  initialDraftId,
  onRefresh,
  onNotify,
}: HumanReviewViewProps) {
  const [filter, setFilter] = useState<'all' | DraftStatus>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialDraftId || null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editSchedule, setEditSchedule] = useState('');
  const [newMediaUrl, setNewMediaUrl] = useState('');
  const [editMedia, setEditMedia] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialDraftId) {
      setFilter('all');
      setSelectedId(initialDraftId);
    }
  }, [initialDraftId]);

  const filteredDrafts = useMemo(() => {
    const filtered = drafts.filter((d) => {
      if (filter !== 'all' && d.status !== filter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        const personaName = personas.find((p) => p.id === d.persona_id)?.display_name.toLowerCase() || '';
        return (
          d.id.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          d.content.toLowerCase().includes(q) ||
          personaName.includes(q)
        );
      }
      return true;
    });
    return [...filtered].sort(
      (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
    );
  }, [drafts, filter, search, personas]);

  const selectedDraft = useMemo(
    () => (selectedId ? drafts.find((d) => d.id === selectedId) || null : null),
    [drafts, selectedId]
  );

  useEffect(() => {
    if (selectedDraft) {
      setEditTitle(selectedDraft.title);
      setEditContent(selectedDraft.content);
      setEditMedia(selectedDraft.media_paths || []);
      setEditSchedule(
        selectedDraft.scheduled_for ? selectedDraft.scheduled_for.slice(0, 16) : ''
      );
    }
  }, [selectedDraft?.id]);

  const selectedPersona = selectedDraft
    ? personas.find((p) => p.id === selectedDraft.persona_id)
    : undefined;
  const linkedAccount = selectedPersona?.account_id
    ? accounts.find((a) => a.id === selectedPersona.account_id)
    : undefined;

  const linkedSources = useMemo(() => {
    if (!selectedDraft) return [];
    return selectedDraft.source_post_ids
      .map((sid) => sourcePosts.find((sp) => sp.id === sid))
      .filter((x): x is SourcePost => Boolean(x));
  }, [selectedDraft, sourcePosts]);

  const handleSave = async (nextStatus?: DraftStatus, overrideSchedule?: string) => {
    if (!selectedDraft) return;
    setBusy(true);
    try {
      const schedValue = overrideSchedule !== undefined ? overrideSchedule : editSchedule;
      await api.updateDraft(selectedDraft.id, {
        title: editTitle,
        content: editContent,
        media_paths: editMedia,
        status: nextStatus || selectedDraft.status,
        scheduled_for: schedValue ? new Date(schedValue).toISOString() : null,
      });
      await onRefresh();
      onNotify(
        nextStatus
          ? `Article ${selectedDraft.id} marked as ${nextStatus.replace('_', ' ')}.`
          : `Saved edits to ${selectedDraft.id}.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update draft', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePublishNow = async () => {
    if (!selectedDraft) return;
    setBusy(true);
    try {
      await api.updateDraft(selectedDraft.id, {
        title: editTitle,
        content: editContent,
        media_paths: editMedia,
      });
      const res = await api.publishDraft(selectedDraft.id);
      await onRefresh();
      const viaLabel =
        res.method === 'square_openapi' ? 'Binance Creator OpenAPI' : 'Playwright';
      onNotify(`Publish job ${res.jobId} (${viaLabel}) started for ${selectedDraft.id}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to launch publish job', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (draftId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBusy(true);
    try {
      await api.deleteDraft(draftId);
      if (selectedId === draftId) {
        setSelectedId(null);
      }
      await onRefresh();
      onNotify(`Deleted article ${draftId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete draft', 'error');
    } finally {
      setBusy(false);
    }
  };

  const applyActiveHourSlot = (hhmm: string) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    const target = new Date();
    target.setHours(hh || 8, mm || 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    const localIso = new Date(target.getTime() - target.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setEditSchedule(localIso);
  };

  const addMediaPath = () => {
    const clean = newMediaUrl.trim();
    if (!clean || editMedia.length >= 4) return;
    setEditMedia([...editMedia, clean]);
    setNewMediaUrl('');
  };

  // Editorial Comparison & Approval Workbench when an article row is opened
  if (selectedDraft) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Articles in Review
          </button>
          <DraftStatusLabel status={selectedDraft.status} />
        </div>

        <div className="rounded-lg border border-white/10 bg-[#12161F]">
          <div className="divide-y divide-white/10">
            {/* Header metadata */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono text-[#F0B90B]">{selectedDraft.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{selectedPersona?.display_name || selectedDraft.persona_id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{linkedAccount?.label || 'Unassigned publisher'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">
                    {selectedDraft.llm_provider}/{selectedDraft.llm_model}
                  </span>
                </div>
                <h2 className="mt-1 text-base font-semibold text-[#EAECEF]">
                  Editorial Comparison &amp; Approval
                </h2>
              </div>
              <DraftStatusLabel status={selectedDraft.status} />
            </div>

            {/* Side-by-side Source vs Rewritten Content */}
            <div className="grid grid-cols-1 xl:grid-cols-12 divide-y xl:divide-y-0 xl:divide-x divide-white/10">
              {/* Original Source Material */}
              <div className="xl:col-span-5 p-5 space-y-4 bg-[#0E121A]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">
                    Original Scraped Source ({linkedSources.length})
                  </span>
                  <span className="text-[11px] text-slate-500">Fact Reference</span>
                </div>

                {linkedSources.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Original source post IDs ({selectedDraft.source_post_ids.join(', ')}) were removed from local archive.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {linkedSources.map((src) => (
                      <div
                        key={src.id}
                        className="space-y-2 border-b border-white/[0.06] pb-4 last:border-b-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                          <span className="font-medium text-slate-200">{src.author}</span>
                          <a
                            href={src.post_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-400 hover:text-[#F0B90B]"
                          >
                            #{src.id.slice(-6)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                          {src.content}
                        </p>
                        {(src.cashtags.length > 0 || src.hashtags.length > 0) && (
                          <div className="text-[11px] text-slate-500">
                            {[...src.cashtags, ...src.hashtags].join(' · ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {selectedDraft.uniqueness_notes && (
                  <div className="pt-2 border-t border-white/10">
                    <p className="text-[11px] font-medium text-slate-400">
                      Uniqueness &amp; Diversity Note
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">
                      {selectedDraft.uniqueness_notes}
                    </p>
                  </div>
                )}
              </div>

              {/* Editable Rewritten Article */}
              <div className="xl:col-span-7 p-5 space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Article Headline / Internal Title
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-2 text-sm text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                  />
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-300">
                      Binance Square Post Content
                    </label>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {editContent.length} chars ·{' '}
                      {selectedDraft.post_format === 'long_article' ? 'Long Article' : 'Short Post'}
                    </span>
                  </div>
                  <textarea
                    rows={10}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 text-sm leading-relaxed text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                  />
                </div>

                {/* Image attachments (up to 4) */}
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-300">
                    Media Paths / Cover Images (Max 4)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newMediaUrl}
                      onChange={(e) => setNewMediaUrl(e.target.value)}
                      placeholder="/path/to/chart.png or image path..."
                      className="flex-1 rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={addMediaPath}
                      disabled={editMedia.length >= 4}
                      className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      Attach
                    </button>
                  </div>
                  {editMedia.length > 0 && (
                    <div className="space-y-1">
                      {editMedia.map((m, idx) => (
                        <div
                          key={`${m}-${idx}`}
                          className="flex items-center justify-between rounded bg-[#0B0E14] px-2.5 py-1.5 text-xs text-slate-300"
                        >
                          <span className="truncate font-mono">{m}</span>
                          <button
                            onClick={() => setEditMedia(editMedia.filter((_, i) => i !== idx))}
                            className="ml-2 text-slate-500 hover:text-rose-400"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Staggered Schedule Picker */}
                <div className="space-y-2 pt-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-medium text-slate-300">
                      Staggered Publish Time
                    </label>
                    {selectedPersona && selectedPersona.active_hours.length > 0 && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-slate-500">Active slots:</span>
                        {selectedPersona.active_hours.map((slot) => (
                          <button
                            key={slot}
                            type="button"
                            onClick={() => applyActiveHourSlot(slot)}
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
                    value={editSchedule}
                    onChange={(e) => setEditSchedule(e.target.value)}
                    className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 font-mono text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 bg-[#0E121A]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleSave()}
                  className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Save className="h-3.5 w-3.5" />
                  Save Edits
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleSave('rejected')}
                  className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDelete(selectedDraft.id)}
                  className="inline-flex items-center gap-1.5 rounded px-2.5 py-2 text-xs font-medium text-slate-400 hover:text-rose-400 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleSave('approved')}
                  className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-500/10 px-4 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy || !editSchedule}
                  onClick={() => handleSave('scheduled')}
                  className="inline-flex items-center gap-1.5 rounded border border-white/15 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  Schedule
                </button>
                <button
                  type="button"
                  disabled={busy || selectedDraft.status === 'publishing'}
                  onClick={handlePublishNow}
                  className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-4 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                  {linkedAccount?.has_square_api_key
                    ? 'Publish Now (Creator API)'
                    : 'Publish Now (Browser Login)'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Clean Newest-First Article Review List Format
  return (
    <div className="space-y-5">
      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="flex flex-wrap items-center gap-1 rounded-md bg-[#12161F] p-1 border border-white/10">
          {FILTER_TABS.map((tab) => {
            const count =
              tab.key === 'all'
                ? drafts.length
                : drafts.filter((d) => d.status === tab.key).length;
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  active
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
            placeholder="Search article ID, title, persona..."
            className="w-full rounded border border-white/10 bg-[#12161F] py-2 pl-8 pr-3 text-xs text-[#EAECEF] placeholder:text-slate-500 focus:border-[#F0B90B] focus:outline-none"
          />
        </div>
      </div>

      {/* Articles in Review List */}
      <div className="max-w-5xl pt-1">
        <div className="mb-4">
          <h2 className="font-display text-base font-semibold text-[#EAECEF]">
            Articles in Review
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">Newest first</p>
        </div>

        {filteredDrafts.length === 0 ? (
          <div className="border-t border-white/10 py-12 text-center">
            <p className="text-sm font-medium text-slate-300">No articles match this filter</p>
            <p className="mt-1 text-xs text-slate-500">
              Generate rewritten articles in AI &amp; Generator or switch status tabs.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {filteredDrafts.map((article) => {
              const words = countWords(article.content);
              const symbolCount = countSymbols(article.content);
              const formattedDate = new Date(article.generated_at).toLocaleString();

              return (
                <div
                  key={article.id}
                  onClick={() => setSelectedId(article.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(article.id);
                    }
                  }}
                  className="group flex items-center justify-between gap-4 rounded-md px-3 py-3.5 cursor-pointer transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#F0B90B]"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-normal text-[#EAECEF] truncate">
                      {article.title || 'Untitled Article'}
                    </p>
                    <p className="text-xs text-slate-400 tabular-nums truncate">
                      {formattedDate} · {words} words · {symbolCount} symbols
                    </p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <ArrowUpRight
                      className="h-3.5 w-3.5 text-slate-500 transition-colors group-hover:text-slate-200"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => handleDelete(article.id, e)}
                      className="rounded p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-rose-400 disabled:opacity-40"
                      title="Delete article"
                      aria-label={`Delete ${article.title || article.id}`}
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
