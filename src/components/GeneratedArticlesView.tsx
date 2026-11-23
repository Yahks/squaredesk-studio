import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ClipboardCheck,
  Copy,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { Draft, Persona } from '../types';
import { DraftStatusLabel } from './StatusText';

interface GeneratedArticlesViewProps {
  drafts: Draft[];
  personas: Persona[];
  onRefresh: () => Promise<void>;
  onOpenInReview: (draftId: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function extractSymbols(text: string): string[] {
  const matches = [...text.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => `$${m[1].toUpperCase()}`);
  return Array.from(new Set(matches));
}

export function GeneratedArticlesView({
  drafts,
  personas,
  onRefresh,
  onOpenInReview,
  onNotify,
}: GeneratedArticlesViewProps) {
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const sortedArticles = useMemo(() => {
    return [...drafts].sort(
      (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
    );
  }, [drafts]);

  const activeArticle = useMemo(() => {
    if (!selectedArticleId) return null;
    return sortedArticles.find((d) => d.id === selectedArticleId) || null;
  }, [sortedArticles, selectedArticleId]);

  const handleDelete = async (e: React.MouseEvent, draftId: string) => {
    e.stopPropagation();
    setDeletingId(draftId);
    try {
      await api.deleteDraft(draftId);
      if (selectedArticleId === draftId) {
        setSelectedArticleId(null);
      }
      await onRefresh();
      onNotify(`Deleted generated article ${draftId}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete article', 'error');
    } finally {
      setDeletingId('');
    }
  };

  const handleCopyArticle = async (article: Draft) => {
    try {
      await navigator.clipboard.writeText(`${article.title}\n\n${article.content}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onNotify('Unable to access clipboard in this browser context.', 'error');
    }
  };

  // Single-article reader view when clicking a row
  if (activeArticle) {
    const persona = personas.find((p) => p.id === activeArticle.persona_id);
    const words = countWords(activeArticle.content);
    const symbols = extractSymbols(activeArticle.content);

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <button
            type="button"
            onClick={() => setSelectedArticleId(null)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-white whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Generated Articles
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleCopyArticle(activeArticle)}
              className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => onOpenInReview(activeArticle.id)}
              className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-1.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] whitespace-nowrap shrink-0"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Open in Human Review
            </button>
          </div>
        </div>

        <article className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
              <span className="font-mono text-[#F0B90B]">{activeArticle.id}</span>
              <span aria-hidden="true">·</span>
              <span>{new Date(activeArticle.generated_at).toLocaleString()}</span>
              <span aria-hidden="true">·</span>
              <span>{words} words</span>
              <span aria-hidden="true">·</span>
              <span>{symbols.length} symbols</span>
              {persona && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{persona.display_name}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <DraftStatusLabel status={activeArticle.status} />
            </div>

            <h1 className="font-display text-2xl font-semibold tracking-tight text-[#EAECEF]">
              {activeArticle.title || 'Untitled Article'}
            </h1>
          </div>

          <div className="border-t border-white/10 pt-5">
            <div className="whitespace-pre-wrap text-[15px] leading-7 text-slate-200 max-w-[75ch]">
              {activeArticle.content}
            </div>
          </div>

          {symbols.length > 0 && (
            <div className="border-t border-white/10 pt-4 text-xs text-slate-400">
              Symbols referenced: <span className="font-mono text-slate-200">{symbols.join(', ')}</span>
            </div>
          )}
        </article>
      </div>
    );
  }

  // Clean minimal list format matching the reference layout
  return (
    <div className="max-w-5xl mx-auto px-2 py-2">
      <div className="mb-4">
        <h2 className="font-display text-base font-semibold text-[#EAECEF]">
          Generated Articles
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">Newest first</p>
      </div>

      {sortedArticles.length === 0 ? (
        <div className="border-t border-white/10 py-12 text-center">
          <p className="text-sm text-slate-300">No generated articles yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Generate an article in AI &amp; Generator and it will appear here newest first.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {sortedArticles.map((article) => {
            const words = countWords(article.content);
            const symbolCount = extractSymbols(article.content).length;
            const formattedDate = new Date(article.generated_at).toLocaleString();
            const isDeleting = deletingId === article.id;

            return (
              <div
                key={article.id}
                onClick={() => setSelectedArticleId(article.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedArticleId(article.id);
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
                    disabled={isDeleting}
                    onClick={(e) => handleDelete(e, article.id)}
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
  );
}
