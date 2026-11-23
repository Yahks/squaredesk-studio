import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { decryptSecret, encryptSecret, maskSecret } from './crypto.ts';
import { db, readPersonaWritingRules } from './db.ts';

export type ProviderId = 'gemini' | 'groq' | 'openrouter' | 'amadd';

export interface ProviderRow {
  id: ProviderId;
  provider_name: string;
  base_url: string;
  api_key_enc: string;
  key_masked: string;
  available_models: string;
  selected_model: string;
  validated: number;
  last_validated_at: string | null;
  validation_error: string;
}

const CURATED_GEMINI_MODELS = [
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-3.1-flash-lite',
];

const CURATED_MODELS: Record<ProviderId, string[]> = {
  gemini: CURATED_GEMINI_MODELS,
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'deepseek-r1-distill-llama-70b',
    'qwen-qwq-32b',
  ],
  openrouter: [
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-4o',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-r1',
    'google/gemini-2.5-flash',
  ],
  amadd: [
    'gpt-4o',
    'gpt-4o-mini',
    'claude-3-5-sonnet-20241022',
    'deepseek-chat',
    'deepseek-reasoner',
  ],
};

function sanitizeBaseUrl(url: string, fallback: string): string {
  const clean = (url || fallback).trim().replace(/\/+$/, '');
  return clean;
}

export async function validateAndSaveProviderKey(params: {
  providerId: ProviderId;
  apiKey: string;
  baseUrl?: string;
  selectedModel?: string;
}): Promise<{ ok: boolean; models: string[]; selectedModel: string; error?: string }> {
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.providerId) as ProviderRow | undefined;
  if (!row) {
    return { ok: false, models: [], selectedModel: '', error: `Unknown provider: ${params.providerId}` };
  }

  const trimmedKey = params.apiKey.trim();
  const effectiveKey =
    trimmedKey ||
    (params.providerId === 'gemini' ? process.env.GEMINI_API_KEY || '' : decryptSecret(row.api_key_enc));

  if (!effectiveKey) {
    return { ok: false, models: [], selectedModel: '', error: 'API key is required to validate against the provider endpoint.' };
  }

  const baseUrl = sanitizeBaseUrl(params.baseUrl || row.base_url, row.base_url);
  let discoveredModels: string[] = [];

  try {
    if (params.providerId === 'gemini') {
      // Validate against Gemini endpoint & @google/genai SDK
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(effectiveKey)}`,
        { signal: AbortSignal.timeout(12000) }
      );
      const data = (await res.json().catch(() => ({}))) as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
        error?: { message?: string };
      };
      if (!res.ok) {
        const msg = data?.error?.message || `Gemini API returned HTTP ${res.status}`;
        db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(msg, 'gemini');
        return { ok: false, models: [], selectedModel: '', error: msg };
      }
      const apiModels = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter(
          (name) =>
            name &&
            !name.includes('1.5') &&
            !name.includes('2.0') &&
            !name.includes('embedding') &&
            !name.includes('aqa')
        );
      discoveredModels = Array.from(new Set([...CURATED_GEMINI_MODELS, ...apiModels]));
    } else if (params.providerId === 'groq') {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${effectiveKey}` },
        signal: AbortSignal.timeout(12000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ id: string }>;
        error?: { message?: string };
      };
      if (!res.ok) {
        const msg = data?.error?.message || `Groq API returned HTTP ${res.status}`;
        db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(msg, 'groq');
        return { ok: false, models: [], selectedModel: '', error: msg };
      }
      const apiModels = (data.data || [])
        .map((m) => m.id)
        .filter((id) => id && !id.includes('whisper') && !id.includes('guard'));
      discoveredModels = Array.from(new Set([...apiModels, ...CURATED_MODELS.groq]));
    } else if (params.providerId === 'openrouter') {
      // Check key auth first
      const authRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${effectiveKey}` },
        signal: AbortSignal.timeout(12000),
      });
      if (!authRes.ok) {
        const errBody = (await authRes.json().catch(() => ({}))) as { error?: { message?: string } };
        const msg = errBody?.error?.message || `OpenRouter key validation failed (HTTP ${authRes.status})`;
        db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(msg, 'openrouter');
        return { ok: false, models: [], selectedModel: '', error: msg };
      }
      const modelsRes = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${effectiveKey}` },
        signal: AbortSignal.timeout(12000),
      });
      const modelsData = (await modelsRes.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
      const topApiModels = (modelsData.data || []).slice(0, 80).map((m) => m.id);
      discoveredModels = Array.from(new Set([...CURATED_MODELS.openrouter, ...topApiModels]));
    } else if (params.providerId === 'amadd') {
      // api.amadd (OpenAI-compatible endpoint)
      const modelsRes = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${effectiveKey}` },
        signal: AbortSignal.timeout(12000),
      });
      if (modelsRes.ok) {
        const data = (await modelsRes.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
        const apiModels = (data.data || []).map((m) => m.id).filter(Boolean);
        discoveredModels = Array.from(new Set([...apiModels, ...CURATED_MODELS.amadd]));
      } else if (modelsRes.status === 401 || modelsRes.status === 403) {
        const errBody = (await modelsRes.json().catch(() => ({}))) as { error?: { message?: string } };
        const msg = errBody?.error?.message || `api.amadd rejected key (HTTP ${modelsRes.status})`;
        db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(msg, 'amadd');
        return { ok: false, models: [], selectedModel: '', error: msg };
      } else {
        // Fallback test via minimal chat/completions probe
        const probeModel = params.selectedModel || row.selected_model || 'gpt-4o-mini';
        const probeRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${effectiveKey}`,
          },
          body: JSON.stringify({
            model: probeModel,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 4,
          }),
          signal: AbortSignal.timeout(12000),
        });
        if (!probeRes.ok) {
          const errBody = (await probeRes.json().catch(() => ({}))) as { error?: { message?: string } };
          const msg = errBody?.error?.message || `api.amadd endpoint validation failed (HTTP ${probeRes.status})`;
          db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(msg, 'amadd');
          return { ok: false, models: [], selectedModel: '', error: msg };
        }
        discoveredModels = CURATED_MODELS.amadd;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error connecting to provider endpoint';
    db.prepare('UPDATE ai_providers SET validated = 0, validation_error = ? WHERE id = ?').run(
      msg,
      params.providerId
    );
    return { ok: false, models: [], selectedModel: '', error: msg };
  }

  const finalModels = discoveredModels.length > 0 ? discoveredModels : CURATED_MODELS[params.providerId];
  const chosenModel =
    params.selectedModel && finalModels.includes(params.selectedModel)
      ? params.selectedModel
      : row.selected_model && finalModels.includes(row.selected_model)
      ? row.selected_model
      : finalModels[0];

  const now = new Date().toISOString();
  const masked = trimmedKey
    ? maskSecret(trimmedKey)
    : params.providerId === 'gemini' && process.env.GEMINI_API_KEY
    ? 'ENV••••INJECTED'
    : row.key_masked;
  const encrypted = trimmedKey ? encryptSecret(trimmedKey) : row.api_key_enc;

  db.prepare(`
    UPDATE ai_providers
    SET base_url = ?, api_key_enc = ?, key_masked = ?, available_models = ?, selected_model = ?,
        validated = 1, last_validated_at = ?, validation_error = ''
    WHERE id = ?
  `).run(
    baseUrl,
    encrypted,
    masked,
    JSON.stringify(finalModels),
    chosenModel,
    now,
    params.providerId
  );

  return { ok: true, models: finalModels, selectedModel: chosenModel };
}

export interface GenerationLogEntry {
  ts: string;
  step: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export class GenerationPipelineError extends Error {
  logs: GenerationLogEntry[];
  generation?: Record<string, unknown>;

  constructor(
    message: string,
    logs: GenerationLogEntry[],
    generation?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'GenerationPipelineError';
    this.logs = logs;
    this.generation = generation;
  }
}

function appendGenLog(
  logs: GenerationLogEntry[],
  step: string,
  message: string,
  level: 'info' | 'success' | 'error' = 'info'
) {
  logs.push({
    ts: new Date().toISOString(),
    step,
    level,
    message,
  });
}

function formatEndpointSummary(providerId: ProviderId, baseUrl: string): string {
  if (providerId === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta (GoogleGenAI SDK)';
  }
  const clean = sanitizeBaseUrl(baseUrl, '');
  return `${clean}/chat/completions`;
}

function extractHttpErrorDetail(rawText: string, fallbackStatus: number, providerName: string): string {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return `${providerName} returned HTTP ${fallbackStatus}`;
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string; code?: string | number; type?: string };
      message?: string;
    };
    const msg = parsed?.error?.message || parsed?.message;
    const code = parsed?.error?.code || parsed?.error?.type;
    if (msg) {
      return code ? `${msg} (${code})` : msg;
    }
  } catch {
    // Plain text / HTML error snippet
  }
  const compact = trimmed.replace(/\s+/g, ' ').slice(0, 260);
  return `HTTP ${fallbackStatus}: ${compact}`;
}

interface GeneratedPayload {
  title: string;
  content: string;
  uniqueness_notes: string;
}

export function countArticleWords(text: string): number {
  const clean = (text || '').trim();
  if (!clean) return 0;
  return clean.split(/\s+/).length;
}

export async function generatePersonaArticle(params: {
  sourcePostIds: string[];
  personaId: string;
  providerId: ProviderId;
  model?: string;
  postFormat?: 'short_post' | 'long_article';
  customAngle?: string;
  scheduledFor?: string;
  targetWordRange?: { min: number; max: number };
  initialStatus?: 'pending_review' | 'approved';
}) {
  const logs: GenerationLogEntry[] = [];
  const effectiveFormat = params.targetWordRange
    ? 'long_article'
    : params.postFormat || 'short_post';
  appendGenLog(
    logs,
    'Init',
    `Starting persona generation for ${params.personaId} (${params.sourcePostIds.length} source post(s), format: ${effectiveFormat}${
      params.targetWordRange
        ? `, target: ${params.targetWordRange.min}-${params.targetWordRange.max} words`
        : ''
    }).`
  );

  const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(params.personaId) as {
    id: string;
    account_id: string;
    display_name: string;
    bio: string;
    niche: string;
    tone: string;
    style_examples: string;
    posting_frequency: string;
    active_hours: string;
    banned_topics: string;
  } | undefined;

  if (!persona) {
    const msg = `Persona not found: ${params.personaId}`;
    appendGenLog(logs, 'Persona', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }
  appendGenLog(logs, 'Persona', `Loaded persona "${persona.display_name}" (${persona.id}).`);

  const placeholders = params.sourcePostIds.map(() => '?').join(',');
  const sourcePosts = db
    .prepare(`SELECT * FROM source_posts WHERE id IN (${placeholders})`)
    .all(...params.sourcePostIds) as Array<{
    id: string;
    author: string;
    content: string;
    cashtags: string;
    hashtags: string;
    used_by_persona_ids: string;
    comments_json?: string;
  }>;

  if (sourcePosts.length === 0) {
    const msg = 'No matching source posts found in local database.';
    appendGenLog(logs, 'Sources', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }
  appendGenLog(logs, 'Sources', `Loaded ${sourcePosts.length} source post(s) from database.`);

  // Diversity control check: warn/note if this persona already covered any of these source posts
  const otherPersonasCovered = new Set<string>();
  for (const sp of sourcePosts) {
    const used = JSON.parse(sp.used_by_persona_ids || '[]') as string[];
    used.filter((id) => id !== persona.id).forEach((id) => otherPersonasCovered.add(id));
  }

  const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.providerId) as
    | ProviderRow
    | undefined;
  if (!provider) {
    const msg = `AI provider not configured: ${params.providerId}`;
    appendGenLog(logs, 'Provider', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }

  const chosenModel = params.model || provider.selected_model || CURATED_MODELS[params.providerId][0];
  const rawStoredKey = decryptSecret(provider.api_key_enc);
  const apiKey =
    rawStoredKey || (params.providerId === 'gemini' ? process.env.GEMINI_API_KEY || '' : '');

  if (!apiKey) {
    const msg = `No validated API key saved for ${provider.provider_name}. Add and test an API key in AI Providers first.`;
    appendGenLog(logs, 'Provider', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }

  appendGenLog(
    logs,
    'Provider',
    `Using ${provider.provider_name} · model: ${chosenModel} · endpoint: ${formatEndpointSummary(
      params.providerId,
      provider.base_url
    )}`
  );

  const niche = JSON.parse(persona.niche || '[]') as string[];
  const styleExamples = JSON.parse(persona.style_examples || '[]') as string[];
  const bannedTopics = JSON.parse(persona.banned_topics || '[]') as string[];
  const { rules: personaWritingRules, filePath: personaRulesFile } = readPersonaWritingRules(persona.id);
  const trimmedRules = personaWritingRules.trim();
  if (trimmedRules) {
    appendGenLog(
      logs,
      'Writing Rules',
      `Loaded ${trimmedRules.length} chars of persona writing rules from ${personaRulesFile || 'persona config'}.`
    );
  }
  const postFormat = params.targetWordRange ? 'long_article' : params.postFormat || 'short_post';
  const wordRange = params.targetWordRange;
  const targetMidWords = wordRange ? Math.round((wordRange.min + wordRange.max) / 2) : 450;

  const systemPrompt = `You are "${persona.display_name}", an independent crypto & market writer on Binance Square.
Bio: ${persona.bio}
Niche Focus: ${niche.join(', ')}
Voice & Tone: ${persona.tone}
Style Examples (emulate rhythm and formatting, never copy verbatim):
${styleExamples.map((ex, i) => `Example ${i + 1}: ${ex}`).join('\n')}

STRICT EDITORIAL RULES:
1. REWRITE COMPLETELY FROM SCRATCH: Your article must be entirely different in phrasing, structure, opening hook, and framing from the source material—zero copied sentences or paraphrasing templates.
2. PRESERVE CORE FACTS 100%: Every number, dollar amount, percentage, date, time, ticker/cashtag, event location, and protocol fact from the source must stay accurate. Never invent fake numbers or claims.
3. BANNED TOPICS: Never include ${bannedTopics.join(', ')}.
4. DIVERSITY CONTROL: ${
    otherPersonasCovered.size > 0
      ? `Other accounts (${Array.from(otherPersonasCovered).join(', ')}) have already covered this source. Take a fresh, non-overlapping analytical angle tailored strictly to ${niche.join('/')}.`
      : 'Lead with an original insight tailored to your niche.'
  }
5. FORMAT: ${
    wordRange
      ? `Comprehensive long-form Binance Square article strictly between ${wordRange.min} and ${wordRange.max} words (aim for ~${targetMidWords} words). Use an authoritative opening thesis, well-developed analytical sections with clear subheadings, structural market implications grounded strictly in the source facts, and a concise closing takeaway.`
      : postFormat === 'long_article'
      ? 'Long-form Binance Square article (350-550 words) with clear section subheadings and a strong takeaway.'
      : 'Crisp high-signal Binance Square post (90-180 words), scannable lines, relevant cashtags/hashtags.'
  }
${params.customAngle ? `6. REQUESTED ANGLE: ${params.customAngle}\n` : ''}${
    trimmedRules
      ? `\nADDITIONAL PERSONA WRITING & STRUCTURE RULES (FOLLOW CLOSELY TO SHAPE ARTICLE LAYOUT, HOOK, SECTIONS, AND FLOW):\n${trimmedRules}\n`
      : ''
  }
Return valid JSON only with keys: "title", "content", "uniqueness_notes".`;

  const sourceBlock = sourcePosts
    .map((sp, idx) => {
      let commentsContext = '';
      try {
        const parsedComments = JSON.parse(sp.comments_json || '[]') as Array<{
          author?: string;
          content?: string;
        }>;
        if (Array.isArray(parsedComments) && parsedComments.length > 0) {
          const sample = parsedComments
            .slice(0, 8)
            .map((c) => `- ${c.author || 'Reader'}: ${(c.content || '').replace(/\s+/g, ' ').trim()}`)
            .filter((line) => line.length > 4)
            .join('\n');
          if (sample) {
            commentsContext = `\nAudience Replies Context (${parsedComments.length} total scraped):\n${sample}`;
          }
        }
      } catch {
        commentsContext = '';
      }
      return `[Source #${idx + 1} | ID: ${sp.id} | Author: ${sp.author}]\n${sp.content}\nCashtags: ${sp.cashtags} | Hashtags: ${sp.hashtags}${commentsContext}`;
    })
    .join('\n\n---\n\n');

  let parsed: GeneratedPayload;
  const startedAt = Date.now();
  appendGenLog(logs, 'Request', `Sending rewrite request to ${chosenModel}...`);

  const invokeModelJson = async (userPromptText: string, timeoutMs: number): Promise<GeneratedPayload> => {
    if (params.providerId === 'gemini') {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const response = await ai.models.generateContent({
        model: chosenModel,
        contents: userPromptText,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: wordRange ? 8192 : undefined,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: 'Concise editorial headline for internal tracking and article header' },
              content: { type: Type.STRING, description: 'Complete rewritten Binance Square post/article body' },
              uniqueness_notes: { type: Type.STRING, description: 'Brief note explaining the distinct angle and factual anchors preserved' },
            },
            required: ['title', 'content', 'uniqueness_notes'],
          },
        },
      });
      const text = (response.text || '{}').trim();
      appendGenLog(
        logs,
        'Response',
        `Received ${text.length} chars from ${chosenModel} in ${Date.now() - startedAt} ms.`
      );
      return JSON.parse(text) as GeneratedPayload;
    }

    const baseUrl = sanitizeBaseUrl(provider.base_url, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (params.providerId === 'openrouter') {
      headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
      headers['X-Title'] = 'SquareDesk Studio';
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: chosenModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPromptText },
        ],
        temperature: 0.75,
        ...(wordRange ? { max_tokens: 4096 } : {}),
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawBodyText = await res.text();
    if (!res.ok) {
      const msg = extractHttpErrorDetail(rawBodyText, res.status, provider.provider_name);
      throw new Error(msg);
    }

    const data = JSON.parse(rawBodyText || '{}') as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content || '';
    appendGenLog(
      logs,
      'Response',
      `Received HTTP ${res.status} (${rawContent.length} chars) in ${Date.now() - startedAt} ms.`
    );
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Model response did not contain valid JSON payload.');
    }
    return JSON.parse(jsonMatch[0]) as GeneratedPayload;
  };

  try {
    const baseUserPrompt =
      params.providerId === 'gemini'
        ? `Rewrite the following source material into an original ${persona.display_name} post:\n\n${sourceBlock}`
        : `Rewrite the following source material into an original ${persona.display_name} post and respond strictly with JSON { "title", "content", "uniqueness_notes" }:\n\n${sourceBlock}`;

    parsed = await invokeModelJson(baseUserPrompt, wordRange ? 90000 : 45000);

    if (wordRange) {
      let currentWords = countArticleWords(parsed.content || '');
      appendGenLog(
        logs,
        'Word Count',
        `Initial draft length: ${currentWords} words (target ${wordRange.min}–${wordRange.max} words).`
      );
      if (currentWords < wordRange.min || currentWords > wordRange.max) {
        const direction =
          currentWords < wordRange.min
            ? `expand the depth, structural context, and section explanations so the article reaches strictly between ${wordRange.min} and ${wordRange.max} words (currently ${currentWords} words)`
            : `tighten and condense verbose phrasing so the article stays strictly between ${wordRange.min} and ${wordRange.max} words (currently ${currentWords} words)`;
        appendGenLog(
          logs,
          'Length Pass',
          `Adjusting draft word count (${currentWords}w -> target ${wordRange.min}–${wordRange.max}w)...`
        );
        try {
          const refined = await invokeModelJson(
            `Revise the draft below to ${direction}. Keep every number, date, ticker, and source fact accurate and do NOT invent fake numbers.\n\nDraft JSON:\n${JSON.stringify(
              parsed
            )}\n\nSource Reference:\n${sourceBlock}\n\nReturn strictly valid JSON { "title", "content", "uniqueness_notes" }.`,
            90000
          );
          if (refined?.content && refined.content.trim()) {
            const refinedWords = countArticleWords(refined.content);
            const oldDist =
              currentWords < wordRange.min
                ? wordRange.min - currentWords
                : currentWords > wordRange.max
                ? currentWords - wordRange.max
                : 0;
            const newDist =
              refinedWords < wordRange.min
                ? wordRange.min - refinedWords
                : refinedWords > wordRange.max
                ? refinedWords - wordRange.max
                : 0;
            if (newDist <= oldDist) {
              parsed = refined;
              currentWords = refinedWords;
            }
            appendGenLog(
              logs,
              'Length Verified',
              `Final pipeline article length: ${currentWords} words.`
            );
          }
        } catch (adjustErr) {
          appendGenLog(
            logs,
            'Length Warning',
            `Length refinement skipped (${
              adjustErr instanceof Error ? adjustErr.message : 'error'
            }); keeping ${currentWords}-word draft.`
          );
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Model request failed';
    appendGenLog(logs, 'Error', `${msg} (after ${Date.now() - startedAt} ms)`, 'error');
    throw new GenerationPipelineError(msg, logs);
  }

  const now = new Date();
  const dateTag = now.toISOString().slice(0, 10).replace(/-/g, '');
  const articleId = `ART-${dateTag}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const draftStatus = params.initialStatus || 'pending_review';
  const reviewedAt = draftStatus === 'approved' ? now.toISOString() : null;

  db.prepare(`
    INSERT INTO drafts (
      id, persona_id, source_post_ids, title, content, media_paths,
      post_format, status, llm_provider, llm_model, uniqueness_notes,
      scheduled_for, generated_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    articleId,
    persona.id,
    JSON.stringify(params.sourcePostIds),
    parsed.title || 'Untitled Draft',
    parsed.content || '',
    JSON.stringify([]),
    postFormat,
    draftStatus,
    params.providerId,
    chosenModel,
    parsed.uniqueness_notes || '',
    params.scheduledFor || null,
    now.toISOString(),
    reviewedAt
  );

  // Record diversity usage on each source post
  for (const sp of sourcePosts) {
    const used = JSON.parse(sp.used_by_persona_ids || '[]') as string[];
    if (!used.includes(persona.id)) {
      used.push(persona.id);
      db.prepare('UPDATE source_posts SET used_by_persona_ids = ? WHERE id = ?').run(
        JSON.stringify(used),
        sp.id
      );
    }
  }

  appendGenLog(logs, 'Saved', `Saved article ${articleId} to review queue.`, 'success');
  const draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(articleId);
  return { draft, logs };
}

function parseStandaloneModelOutput(rawText: string): { title: string; content: string } {
  const cleaned = rawText
    .replace(/^\s*```(?:json|markdown|md|text)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();

  // If the user's custom prompt asked for JSON with title/content, extract cleanly
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
    try {
      const parsed = JSON.parse(cleaned) as { title?: unknown; content?: unknown };
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return {
          title:
            typeof parsed.title === 'string' && parsed.title.trim()
              ? parsed.title.trim()
              : parsed.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 90),
          content: parsed.content.trim(),
        };
      }
    } catch {
      // Treat as plain text below
    }
  }

  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstLine = (lines[0] || 'Standalone Generation').replace(/^#+\s*/, '').replace(/\*\*/g, '');
  const title = firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
  return {
    title: title || 'Standalone Generation',
    content: cleaned,
  };
}

export async function generateStandaloneArticle(params: {
  sourcePostIds?: string[];
  providerId: ProviderId;
  model?: string;
  prompt: string;
  customInput?: string;
}) {
  const logs: GenerationLogEntry[] = [];
  const promptText = (params.prompt || '').trim();
  const customInput = (params.customInput || '').trim();
  const sourceIds = Array.isArray(params.sourcePostIds) ? params.sourcePostIds.filter(Boolean) : [];

  appendGenLog(
    logs,
    'Init',
    `Starting standalone generation (${promptText.length} prompt chars, ${sourceIds.length} source post(s), ${customInput.length} custom input chars).`
  );

  if (!promptText) {
    const msg = 'Generation prompt cannot be empty.';
    appendGenLog(logs, 'Init', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }

  const provider = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(params.providerId) as
    | ProviderRow
    | undefined;
  if (!provider) {
    const msg = `AI provider not configured: ${params.providerId}`;
    appendGenLog(logs, 'Provider', msg, 'error');
    throw new GenerationPipelineError(msg, logs);
  }

  const chosenModel = params.model || provider.selected_model || CURATED_MODELS[params.providerId][0];
  const endpointLabel = formatEndpointSummary(params.providerId, provider.base_url);
  appendGenLog(
    logs,
    'Provider',
    `Selected ${provider.provider_name} (${params.providerId}) · model: ${chosenModel} · endpoint: ${endpointLabel}`
  );

  const rawStoredKey = decryptSecret(provider.api_key_enc);
  const apiKey =
    rawStoredKey || (params.providerId === 'gemini' ? process.env.GEMINI_API_KEY || '' : '');

  const genId = `GEN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;
  const createdAt = new Date().toISOString();

  const persistStandaloneRecord = (record: {
    status: 'completed' | 'failed';
    title: string;
    content: string;
    errorMessage: string;
    latencyMs: number;
  }) => {
    db.prepare(`
      INSERT INTO standalone_generations (
        id, source_post_ids, custom_input, prompt, title, content,
        llm_provider, llm_model, latency_ms, status, error_message, logs, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      JSON.stringify(sourceIds),
      customInput,
      promptText,
      record.title,
      record.content,
      params.providerId,
      chosenModel,
      record.latencyMs,
      record.status,
      record.errorMessage,
      JSON.stringify(logs),
      createdAt
    );

    const saved = db.prepare('SELECT * FROM standalone_generations WHERE id = ?').get(genId) as {
      id: string;
      source_post_ids: string;
      custom_input: string;
      prompt: string;
      title: string;
      content: string;
      llm_provider: string;
      llm_model: string;
      latency_ms: number;
      status: 'completed' | 'failed';
      error_message: string;
      logs: string;
      created_at: string;
    };

    return {
      ...saved,
      source_post_ids: JSON.parse(saved.source_post_ids || '[]') as string[],
      logs: JSON.parse(saved.logs || '[]') as GenerationLogEntry[],
    };
  };

  if (!apiKey) {
    const msg = `No validated API key saved for ${provider.provider_name}. Add and test an API key in AI Provider Connections above first.`;
    appendGenLog(logs, 'Auth', msg, 'error');
    const failedRecord = persistStandaloneRecord({
      status: 'failed',
      title: `Failed · ${provider.provider_name}/${chosenModel}`,
      content: '',
      errorMessage: msg,
      latencyMs: 0,
    });
    throw new GenerationPipelineError(msg, logs, failedRecord);
  }

  let sourcePosts: Array<{
    id: string;
    author: string;
    content: string;
    cashtags: string;
    hashtags: string;
    comments_json?: string;
  }> = [];

  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => '?').join(',');
    sourcePosts = db
      .prepare(`SELECT id, author, content, cashtags, hashtags, comments_json FROM source_posts WHERE id IN (${placeholders})`)
      .all(...sourceIds) as typeof sourcePosts;
    appendGenLog(
      logs,
      'Sources',
      `Loaded ${sourcePosts.length}/${sourceIds.length} scraped source post(s) for prompt context.`
    );
  }

  const sourceBlock = sourcePosts
    .map((sp, idx) => {
      let commentsContext = '';
      try {
        const parsedComments = JSON.parse(sp.comments_json || '[]') as Array<{
          author?: string;
          content?: string;
        }>;
        if (Array.isArray(parsedComments) && parsedComments.length > 0) {
          const sample = parsedComments
            .slice(0, 8)
            .map((c) => `- ${c.author || 'Reader'}: ${(c.content || '').replace(/\s+/g, ' ').trim()}`)
            .filter((line) => line.length > 4)
            .join('\n');
          if (sample) {
            commentsContext = `\nComments (${parsedComments.length}):\n${sample}`;
          }
        }
      } catch {
        commentsContext = '';
      }
      return `[Source #${idx + 1} | ID: ${sp.id} | Author: ${sp.author}]\n${sp.content}\nCashtags: ${sp.cashtags} | Hashtags: ${sp.hashtags}${commentsContext}`;
    })
    .join('\n\n---\n\n');

  const userParts: string[] = [];
  if (sourceBlock) {
    userParts.push(`Source Material:\n\n${sourceBlock}`);
  }
  if (customInput) {
    userParts.push(`Additional Input / Notes:\n\n${customInput}`);
  }
  const userMessage =
    userParts.length > 0
      ? userParts.join('\n\n===\n\n')
      : 'Follow the system prompt instructions directly and generate your response.';

  const startedAt = Date.now();
  appendGenLog(
    logs,
    'Request',
    `Dispatching request to ${chosenModel} (user payload: ${userMessage.length} chars, timeout: 60s)...`
  );

  let rawOutput = '';
  try {
    if (params.providerId === 'gemini') {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const response = await ai.models.generateContent({
        model: chosenModel,
        contents: userMessage,
        config: {
          systemInstruction: promptText,
        },
      });
      rawOutput = (response.text || '').trim();
      appendGenLog(
        logs,
        'Response',
        `Gemini SDK returned ${rawOutput.length} chars in ${Date.now() - startedAt} ms.`
      );
    } else {
      const baseUrl = sanitizeBaseUrl(provider.base_url, '');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (params.providerId === 'openrouter') {
        headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
        headers['X-Title'] = 'SquareDesk Studio';
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chosenModel,
          messages: [
            { role: 'system', content: promptText },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.75,
        }),
        signal: AbortSignal.timeout(60000),
      });

      const rawBodyText = await res.text();
      if (!res.ok) {
        const msg = extractHttpErrorDetail(rawBodyText, res.status, provider.provider_name);
        throw new Error(msg);
      }

      let data: {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string };
        }>;
      } = {};
      try {
        data = JSON.parse(rawBodyText || '{}') as typeof data;
      } catch {
        throw new Error(
          `${provider.provider_name} returned non-JSON response: ${rawBodyText.slice(0, 200)}`
        );
      }

      const choice = data.choices?.[0];
      const mainText = (choice?.message?.content || '').trim();
      const reasoningFallback = (choice?.message?.reasoning_content || '').trim();
      rawOutput = mainText || reasoningFallback;

      appendGenLog(
        logs,
        'Response',
        `HTTP ${res.status} · finish_reason=${choice?.finish_reason || 'unknown'} · ${
          mainText
            ? `${mainText.length} output chars`
            : reasoningFallback
            ? `used reasoning_content (${reasoningFallback.length} chars)`
            : '0 output chars'
        } in ${Date.now() - startedAt} ms.`
      );
    }

    if (!rawOutput) {
      throw new Error(`${provider.provider_name} (${chosenModel}) returned an empty response.`);
    }
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - startedAt);
    const msg = err instanceof Error ? err.message : 'Standalone generation request failed';
    appendGenLog(logs, 'Error', `${msg} (after ${latencyMs} ms)`, 'error');
    const failedRecord = persistStandaloneRecord({
      status: 'failed',
      title: `Failed · ${provider.provider_name}/${chosenModel}`,
      content: '',
      errorMessage: msg,
      latencyMs,
    });
    throw new GenerationPipelineError(msg, logs, failedRecord);
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  const { title, content } = parseStandaloneModelOutput(rawOutput);
  appendGenLog(
    logs,
    'Complete',
    `Parsed "${title}" (${content.length} chars) in ${latencyMs} ms.`,
    'success'
  );

  return persistStandaloneRecord({
    status: 'completed',
    title,
    content,
    errorMessage: '',
    latencyMs,
  });
}

