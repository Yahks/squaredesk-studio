import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { ApiError, api } from '../api';
import type {
  AIProvider,
  GenerationLogEntry,
  ProviderId,
  SourcePost,
  StandaloneGeneration,
} from '../types';

interface GeneratorProvidersViewProps {
  providers: AIProvider[];
  sourcePosts: SourcePost[];
  standaloneGenerations: StandaloneGeneration[];
  initialSourcePostId?: string;
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

const STANDALONE_PROMPT_STORAGE_KEY = 'squaredesk_standalone_prompt_v1';

const DEFAULT_STANDALONE_PROMPT = `You are an independent crypto & market analyst writing an original Binance Square post.

Guidelines:
1. Rewrite completely from scratch with a strong opening hook and clear structure. Do not copy phrasing verbatim.
2. Preserve every core fact, number, dollar figure, percentage, date, and $cashtag accurately.
3. Keep the tone sharp, objective, and practical — avoid hype, price guarantees, or financial advice.
4. Format as a clean, scannable Binance Square post (120-240 words) with relevant $cashtags and #hashtags.`;

function countWords(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

function countSymbols(text: string): number {
  const matches = [...text.matchAll(/\$([A-Za-z]{2,10})\b/g)].map((m) => m[1].toUpperCase());
  return new Set(matches).size;
}

export function GeneratorProvidersView({
  providers,
  sourcePosts,
  standaloneGenerations,
  initialSourcePostId,
  onRefresh,
  onNotify,
}: GeneratorProvidersViewProps) {
  // Provider form state keyed by provider ID
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [validatingId, setValidatingId] = useState<string>('');
  const [savingModelId, setSavingModelId] = useState<string>('');

  // Standalone Generation & Model Test Lab state (no account/persona coupling)
  const [selectedPostIds, setSelectedPostIds] = useState<string[]>([]);
  const [sourceSearch, setSourceSearch] = useState<string>('');
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>('gemini');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(STANDALONE_PROMPT_STORAGE_KEY);
      return saved && saved.trim() ? saved : DEFAULT_STANDALONE_PROMPT;
    } catch {
      return DEFAULT_STANDALONE_PROMPT;
    }
  });
  const [customInput, setCustomInput] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [livePipeLogs, setLivePipeLogs] = useState<GenerationLogEntry[]>([]);
  const [activeGenId, setActiveGenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string>('');

  // Sync baseUrls from providers
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const p of providers) {
      next[p.id] = p.base_url;
    }
    setBaseUrls((prev) => ({ ...next, ...prev }));
  }, [providers]);

  // Persist user's standalone prompt locally across sessions & model tests
  useEffect(() => {
    try {
      window.localStorage.setItem(STANDALONE_PROMPT_STORAGE_KEY, customPrompt);
    } catch {
      // ignore storage quota errors
    }
  }, [customPrompt]);

  // Pre-select source post when sent from ScrapedFeedView
  useEffect(() => {
    if (initialSourcePostId) {
      setSelectedPostIds((prev) =>
        prev.includes(initialSourcePostId) ? prev : [initialSourcePostId, ...prev]
      );
    }
  }, [initialSourcePostId]);

  // Default to a validated provider if available on initial load
  useEffect(() => {
    const current = providers.find((p) => p.id === selectedProviderId);
    if (current && !current.validated) {
      const firstValidated = providers.find((p) => p.validated);
      if (firstValidated) {
        setSelectedProviderId(firstValidated.id);
      }
    }
  }, [providers.length]);

  // Keep selectedModel synced when switching AI provider
  useEffect(() => {
    const activeProvider = providers.find((p) => p.id === selectedProviderId);
    if (activeProvider) {
      setSelectedModel(activeProvider.selected_model || activeProvider.available_models[0] || '');
    }
  }, [selectedProviderId, providers]);

  // Auto-select latest standalone result when list updates
  useEffect(() => {
    if (!activeGenId && standaloneGenerations.length > 0) {
      setActiveGenId(standaloneGenerations[0].id);
    } else if (
      activeGenId &&
      standaloneGenerations.length > 0 &&
      !standaloneGenerations.some((g) => g.id === activeGenId)
    ) {
      setActiveGenId(standaloneGenerations[0].id);
    }
  }, [standaloneGenerations, activeGenId]);

  const activeProvider = providers.find((p) => p.id === selectedProviderId);

  const filteredSources = useMemo(() => {
    const sorted = [...sourcePosts].sort(
      (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime()
    );
    if (!sourceSearch.trim()) return sorted;
    const q = sourceSearch.toLowerCase();
    return sorted.filter(
      (sp) =>
        sp.id.toLowerCase().includes(q) ||
        sp.author.toLowerCase().includes(q) ||
        sp.content.toLowerCase().includes(q) ||
        sp.cashtags.some((c) => c.toLowerCase().includes(q))
    );
  }, [sourcePosts, sourceSearch]);

  const activeGeneration = useMemo(() => {
    if (!activeGenId) return standaloneGenerations[0] || null;
    return standaloneGenerations.find((g) => g.id === activeGenId) || standaloneGenerations[0] || null;
  }, [standaloneGenerations, activeGenId]);

  const displayedPipeLogs = useMemo(() => {
    if (generating || livePipeLogs.length > 0) {
      return livePipeLogs;
    }
    return activeGeneration?.logs || [];
  }, [generating, livePipeLogs, activeGeneration]);

  const handleValidateProvider = async (provider: AIProvider) => {
    setValidatingId(provider.id);
    try {
      const enteredKey = (apiKeys[provider.id] || '').trim();
      const res = await api.validateProvider(provider.id, {
        apiKey: enteredKey,
        baseUrl: baseUrls[provider.id] ?? provider.base_url,
        selectedModel: provider.selected_model,
      });
      setApiKeys((prev) => ({ ...prev, [provider.id]: '' }));
      await onRefresh();
      onNotify(
        `${provider.provider_name} validated (${res.models.length} models loaded, active: ${res.selectedModel}).`
      );
    } catch (err) {
      await onRefresh();
      onNotify(
        err instanceof Error ? err.message : `${provider.provider_name} key validation failed`,
        'error'
      );
    } finally {
      setValidatingId('');
    }
  };

  const handleModelChange = async (providerId: ProviderId, model: string) => {
    setSavingModelId(providerId);
    try {
      await api.updateProviderModel(providerId, {
        selectedModel: model,
        baseUrl: baseUrls[providerId],
      });
      await onRefresh();
      if (providerId === selectedProviderId) {
        setSelectedModel(model);
      }
      onNotify(`Default model updated to ${model}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update provider model', 'error');
    } finally {
      setSavingModelId('');
    }
  };

  const togglePostSelection = (postId: string) => {
    setSelectedPostIds((prev) =>
      prev.includes(postId) ? prev.filter((id) => id !== postId) : [...prev, postId]
    );
  };

  const handleRunStandaloneGeneration = async () => {
    if (!customPrompt.trim()) {
      const msg = 'Generation prompt cannot be empty.';
      setLivePipeLogs([
        { ts: new Date().toISOString(), step: 'Init', level: 'error', message: msg },
      ]);
      onNotify(msg, 'error');
      return;
    }

    const targetModelLabel = selectedModel || activeProvider?.selected_model || 'default';
    setGenerating(true);
    setLivePipeLogs([
      {
        ts: new Date().toISOString(),
        step: 'Client',
        level: 'info',
        message: `Dispatching generation request to ${selectedProviderId}/${targetModelLabel} (${selectedPostIds.length} source(s))...`,
      },
    ]);

    try {
      const res = await api.generateStandalone({
        sourcePostIds: selectedPostIds,
        providerId: selectedProviderId,
        model: selectedModel || undefined,
        prompt: customPrompt,
        customInput: customInput.trim() || undefined,
      });
      setLivePipeLogs(res.generation?.logs || []);
      await onRefresh();
      if (res.generation?.id) {
        setActiveGenId(res.generation.id);
      }
      onNotify(
        `Generated standalone test (${res.generation.llm_provider}/${res.generation.llm_model} · ${res.generation.latency_ms} ms).`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Standalone generation failed';
      if (err instanceof ApiError) {
        if (err.logs && err.logs.length > 0) {
          setLivePipeLogs(err.logs);
        } else {
          setLivePipeLogs((prev) => [
            ...prev,
            { ts: new Date().toISOString(), step: 'Error', level: 'error', message: errMsg },
          ]);
        }
        await onRefresh().catch(() => {});
        if (err.generation?.id) {
          setActiveGenId(err.generation.id);
        }
      } else {
        setLivePipeLogs((prev) => [
          ...prev,
          { ts: new Date().toISOString(), step: 'Error', level: 'error', message: errMsg },
        ]);
      }
      onNotify(errMsg, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteGeneration = async (id: string) => {
    try {
      await api.deleteStandaloneGeneration(id);
      if (activeGenId === id) {
        setActiveGenId(null);
        setLivePipeLogs([]);
      }
      await onRefresh();
      onNotify(`Removed standalone generation ${id}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to delete generation', 'error');
    }
  };

  const handleCopy = async (gen: StandaloneGeneration) => {
    try {
      await navigator.clipboard.writeText(gen.content);
      setCopiedId(gen.id);
      setTimeout(() => setCopiedId(''), 1800);
    } catch {
      onNotify('Unable to access clipboard in this browser context.', 'error');
    }
  };

  const renderLogLines = (logs: GenerationLogEntry[]) => (
    <div className="rounded border border-white/10 bg-[#0B0E14] p-3 font-mono text-[11px] space-y-1.5 max-h-56 overflow-y-auto">
      {logs.map((entry, idx) => (
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
  );

  return (
    <div className="space-y-6">
      {/* Section 1: Multi-Provider API Key Validation & Model Discovery */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-[#EAECEF]">
              AI Provider Connections (Live Endpoint Validation)
            </h2>
            <p className="text-xs text-slate-400">
              API keys are verified directly against each provider endpoint before saving encrypted credentials and populating available models.
            </p>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            {providers.filter((p) => p.validated).length} / {providers.length} validated
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((provider) => {
            const isValidating = validatingId === provider.id;
            const isSavingModel = savingModelId === provider.id;
            return (
              <div
                key={provider.id}
                className="rounded-lg border border-white/10 bg-[#12161F] p-5 space-y-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#EAECEF]">
                        {provider.provider_name}
                      </h3>
                      <span className="font-mono text-[11px] text-slate-500 uppercase">
                        {provider.id}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {provider.key_masked
                        ? `Stored Key: ${provider.key_masked}`
                        : provider.id === 'gemini'
                        ? 'No custom key stored (can test server GEMINI_API_KEY or paste key)'
                        : 'No API key stored yet'}
                    </p>
                  </div>

                  {provider.validated ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Validated
                    </span>
                  ) : provider.validation_error ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
                      <XCircle className="h-3.5 w-3.5" />
                      Invalid Key
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 whitespace-nowrap shrink-0">
                      <KeyRound className="h-3.5 w-3.5" />
                      Unverified
                    </span>
                  )}
                </div>

                {provider.validation_error && (
                  <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {provider.validation_error}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">
                      API Key (write-only · tested live before saving)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={apiKeys[provider.id] || ''}
                        onChange={(e) =>
                          setApiKeys((prev) => ({ ...prev, [provider.id]: e.target.value }))
                        }
                        placeholder={
                          provider.key_masked
                            ? `Leave blank to re-verify ${provider.key_masked} or paste new key`
                            : `Enter ${provider.provider_name} API key...`
                        }
                        className="flex-1 rounded border border-white/10 bg-[#0B0E14] px-3 py-2 font-mono text-xs text-[#EAECEF] placeholder:text-slate-600 focus:border-[#F0B90B] focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={isValidating}
                        onClick={() => handleValidateProvider(provider)}
                        className="inline-flex items-center gap-1.5 rounded bg-[#F0B90B] px-3.5 py-2 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        {isValidating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Test & Save Key
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">
                        Base Endpoint URL
                      </label>
                      <input
                        type="text"
                        value={baseUrls[provider.id] ?? provider.base_url}
                        onChange={(e) =>
                          setBaseUrls((prev) => ({ ...prev, [provider.id]: e.target.value }))
                        }
                        disabled={provider.id === 'gemini'}
                        className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 font-mono text-xs text-slate-300 disabled:opacity-50 focus:border-[#F0B90B] focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-400">
                        Active Model ({provider.available_models.length})
                      </label>
                      <select
                        value={provider.selected_model}
                        disabled={isSavingModel}
                        onChange={(e) => handleModelChange(provider.id, e.target.value)}
                        className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-1.5 font-mono text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                      >
                        {provider.available_models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {provider.last_validated_at && (
                  <p className="text-[11px] font-mono text-slate-500">
                    Last verified: {new Date(provider.last_validated_at).toLocaleString()}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Standalone Prompt & Model Generation Lab (Unattached to Any Account) */}
      <section className="rounded-lg border border-white/10 bg-[#12161F] overflow-hidden">
        <div className="border-b border-white/10 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#EAECEF]">
              Standalone Prompt &amp; Model Generation Lab
            </h2>
            <p className="text-xs text-slate-400">
              Test generation per AI provider and model using your own editable prompt. Runs independently — not attached to any publishing account.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-400 tabular-nums">
            {selectedPostIds.length} source(s) selected
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/10">
          {/* Left: Optional Source Material + Custom Test Input */}
          <div className="lg:col-span-5 p-5 space-y-4">
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-300">
                  1. Source Material (Optional · Scraped DB)
                </span>
                {selectedPostIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedPostIds([])}
                    className="text-xs text-slate-400 hover:text-white"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={sourceSearch}
                  onChange={(e) => setSourceSearch(e.target.value)}
                  placeholder="Filter scraped posts by author, text, or $cashtag..."
                  className="w-full rounded border border-white/10 bg-[#0B0E14] py-1.5 pl-8 pr-2.5 text-xs text-[#EAECEF] placeholder:text-slate-600 focus:border-[#F0B90B] focus:outline-none"
                />
              </div>

              {filteredSources.length === 0 ? (
                <div className="rounded border border-white/10 bg-[#0E121A] p-5 text-center text-xs text-slate-500">
                  {sourcePosts.length === 0
                    ? 'No scraped posts yet. You can still test your prompt directly or add custom input below.'
                    : 'No scraped posts match your filter.'}
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y divide-white/[0.07] rounded border border-white/10 bg-[#0E121A]">
                  {filteredSources.map((post) => {
                    const checked = selectedPostIds.includes(post.id);
                    return (
                      <label
                        key={post.id}
                        className={`flex items-start gap-3 p-3 cursor-pointer transition-colors ${
                          checked ? 'bg-[#1A202C]' : 'hover:bg-white/[0.02]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePostSelection(post.id)}
                          className="mt-1 h-4 w-4 rounded border-white/20 bg-[#0B0E14] accent-[#F0B90B]"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className="font-medium text-[#EAECEF]">{post.author}</span>
                            <span aria-hidden="true">·</span>
                            <span className="capitalize">{post.feed_tab}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono text-[11px] text-slate-500">#{post.id.slice(-6)}</span>
                          </div>
                          <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                            {post.content}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-400">
                Optional Custom Source / Context Text
              </label>
              <textarea
                rows={4}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="Paste raw article text, notes, or extra data to feed into your prompt..."
                className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 text-xs leading-relaxed text-[#EAECEF] placeholder:text-slate-600 focus:border-[#F0B90B] focus:outline-none"
              />
            </div>
          </div>

          {/* Right: AI Provider, Model & Editable Standalone Prompt */}
          <div className="lg:col-span-7 p-5 space-y-4">
            <span className="block text-xs font-semibold text-slate-300">
              2. Provider, Model &amp; Standalone Prompt
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  AI Provider
                </label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => setSelectedProviderId(e.target.value as ProviderId)}
                  className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-2 text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.provider_name} {p.validated ? '(Validated)' : '(Unverified)'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">
                  Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full rounded border border-white/10 bg-[#0B0E14] px-3 py-2 font-mono text-xs text-[#EAECEF] focus:border-[#F0B90B] focus:outline-none"
                >
                  {(activeProvider?.available_models || []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-300">
                  Generation Prompt (Editable / Replaceable)
                </label>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                    {customPrompt.length} chars · {countWords(customPrompt)} words
                  </span>
                  <button
                    type="button"
                    onClick={() => setCustomPrompt(DEFAULT_STANDALONE_PROMPT)}
                    className="inline-flex items-center gap-1 text-slate-400 hover:text-[#F0B90B]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset Default
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomPrompt('')}
                    className="text-slate-400 hover:text-rose-400"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <textarea
                rows={10}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Write or paste the exact prompt instructions you want to test with the selected API and model..."
                className="w-full rounded border border-white/10 bg-[#0B0E14] p-3 font-mono text-xs leading-relaxed text-[#EAECEF] placeholder:text-slate-600 focus:border-[#F0B90B] focus:outline-none"
              />
            </div>

            <div className="pt-1 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500 font-mono">
                Target: {activeProvider?.provider_name || selectedProviderId} · {selectedModel || 'default'}
              </span>
              <button
                type="button"
                disabled={generating || !customPrompt.trim()}
                onClick={handleRunStandaloneGeneration}
                className="inline-flex items-center gap-2 rounded bg-[#F0B90B] px-5 py-2.5 text-xs font-semibold text-[#0B0E14] hover:bg-[#FCD535] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {generating ? 'Running Model...' : 'Run Generation Test'}
              </button>
            </div>
          </div>
        </div>

        {/* Live Generation Pipe Log Banner (visible right inside Section 2 when running or if no saved history exists yet) */}
        {displayedPipeLogs.length > 0 && standaloneGenerations.length === 0 && (
          <div className="border-t border-white/10 bg-[#0E121A] p-5 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Terminal className="h-3.5 w-3.5 text-[#F0B90B]" />
              <span>Generation Pipeline Log</span>
            </div>
            {renderLogLines(displayedPipeLogs)}
          </div>
        )}
      </section>

      {/* Section 3: Standalone Model Test Output, Execution Log & Comparison History */}
      {standaloneGenerations.length > 0 && activeGeneration && (
        <section className="rounded-lg border border-white/10 bg-[#12161F] overflow-hidden">
          <div className="border-b border-white/10 px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-[#EAECEF]">
                Standalone Output &amp; Generation Pipe Log
              </h3>
              <p className="text-xs text-slate-400">
                Inspect responses, provider errors, HTTP statuses, and step-by-step execution logs across model runs.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {standaloneGenerations.length} run(s) logged
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/10">
            {/* Run History Selector */}
            <div className="lg:col-span-4 max-h-[540px] overflow-y-auto divide-y divide-white/[0.06] bg-[#0E121A]">
              {standaloneGenerations.map((gen) => {
                const selected = gen.id === activeGeneration.id;
                const isFailed = gen.status === 'failed';
                return (
                  <div
                    key={gen.id}
                    onClick={() => {
                      setActiveGenId(gen.id);
                      setLivePipeLogs([]);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveGenId(gen.id);
                        setLivePipeLogs([]);
                      }
                    }}
                    className={`p-3.5 cursor-pointer transition-colors ${
                      selected ? 'bg-[#1A202C]' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                      <span className={isFailed ? 'text-rose-400' : 'text-[#F0B90B]'}>
                        {gen.llm_provider}/{gen.llm_model}
                      </span>
                      <span className="text-slate-500 tabular-nums">
                        {isFailed ? 'Failed · ' : ''}
                        {gen.latency_ms} ms
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-xs font-medium truncate ${
                        isFailed ? 'text-rose-200' : 'text-[#EAECEF]'
                      }`}
                    >
                      {gen.title || (isFailed ? 'Failed Generation' : 'Standalone Output')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400 tabular-nums">
                      {new Date(gen.created_at).toLocaleString()} ·{' '}
                      {isFailed ? `${gen.logs?.length || 0} log step(s)` : `${countWords(gen.content)} words`}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Active Output & Generation Pipe Log Viewer */}
            <div className="lg:col-span-8 p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 tabular-nums">
                  <span className="font-mono text-[#F0B90B]">{activeGeneration.id}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={`font-semibold ${
                      activeGeneration.status === 'failed' ? 'text-rose-400' : 'text-emerald-400'
                    }`}
                  >
                    {activeGeneration.status === 'failed' ? 'Failed' : 'Completed'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-slate-200">
                    {activeGeneration.llm_provider}/{activeGeneration.llm_model}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{activeGeneration.latency_ms} ms</span>
                  {activeGeneration.status !== 'failed' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {countWords(activeGeneration.content)} words ·{' '}
                        {countSymbols(activeGeneration.content)} symbols
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomPrompt(activeGeneration.prompt);
                      onNotify('Loaded prompt from this test run back into editor.');
                    }}
                    className="rounded border border-white/15 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5 whitespace-nowrap shrink-0"
                  >
                    Reuse Prompt
                  </button>
                  {activeGeneration.status !== 'failed' && (
                    <button
                      type="button"
                      onClick={() => handleCopy(activeGeneration)}
                      className="inline-flex items-center gap-1.5 rounded border border-white/15 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
                    >
                      {copiedId === activeGeneration.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {copiedId === activeGeneration.id ? 'Copied' : 'Copy'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDeleteGeneration(activeGeneration.id)}
                    className="rounded p-1.5 text-slate-400 hover:bg-white/5 hover:text-rose-400"
                    title="Delete generation run"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {activeGeneration.status === 'failed' ? (
                <div className="flex items-start gap-2.5 rounded border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                  <div className="space-y-1 min-w-0">
                    <p className="font-semibold text-rose-300">Generation Failed</p>
                    <p className="break-words leading-relaxed">
                      {activeGeneration.error_message || 'Unknown provider error occurred.'}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded border border-white/10 bg-[#0B0E14] p-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-200 max-h-[300px] overflow-y-auto">
                  {activeGeneration.content}
                </div>
              )}

              {/* Generation Pipeline Log */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-300">
                    <Terminal className="h-3.5 w-3.5 text-[#F0B90B]" />
                    Generation Pipe Log ({displayedPipeLogs.length})
                  </span>
                  {generating && (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#F0B90B]">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Running...
                    </span>
                  )}
                </div>
                {displayedPipeLogs.length === 0 ? (
                  <p className="rounded border border-white/10 bg-[#0B0E14] px-3 py-2 text-xs text-slate-500">
                    No step logs recorded for this legacy run.
                  </p>
                ) : (
                  renderLogLines(displayedPipeLogs)
                )}
              </div>

              <details className="text-xs text-slate-400">
                <summary className="cursor-pointer hover:text-slate-200 select-none">
                  Prompt used for this run
                </summary>
                <pre className="mt-2 whitespace-pre-wrap rounded border border-white/10 bg-[#0B0E14] p-3 font-mono text-[11px] text-slate-300">
                  {activeGeneration.prompt}
                </pre>
              </details>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
