/**
 * Free LLM pool: Google Gemini (many keys, rotated) → Groq (fallback).
 *
 * - Models are tried best-first. A model that is exhausted (quota/429 on every
 *   key), missing (404) or refused is NEVER retried in the same run.
 * - Keys fail over instantly: rejected keys (401/403/invalid) are retired,
 *   rate-limited / out-of-quota keys are skipped for that model.
 * - Pure fetch: runs on the GitHub runner (Node 22), the Express server and
 *   Cloudflare Workers. Keys are never logged (only their last 4 characters).
 *
 * Gemini "AQ." keys must be sent in the x-goog-api-key header.
 */
export type Provider = 'gemini' | 'groq';
export interface LlmConfig {
  geminiKeys: string[];
  groqKeys: string[];
  geminiModels?: string[];
  groqModels?: string[];
  geminiBase?: string;
  groqBase?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Start position in each key list (spreads the free quotas across runs). */
  seed?: number;
}
export interface LlmRequest {
  system: string;
  user: string;
  /** Softer wording, used after a safety block. */
  saferUser?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
  /**
   * Live web research: Gemini answers with Google Search grounding, Groq with its
   * built-in web-search "compound" models. The answer carries the web sources used.
   */
  webSearch?: boolean;
  /** Images to look at (vision check). Gemini models, then Groq's vision model. */
  images?: { mime: string; data: string }[];
}
export interface WebSource { title: string; uri: string }
export interface LlmAttempt { provider: Provider; model: string; text: string; ms: number; sources?: WebSource[] }

export const GEMINI_MODELS_DEFAULT = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
export const GROQ_MODELS_DEFAULT = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
/** Groq models that search the web themselves (used for fact research). */
export const GROQ_SEARCH_MODELS = ['groq/compound', 'groq/compound-mini'];
/** Groq models that can look at an image (used for image verification). */
export const GROQ_VISION_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];

const tail = (k: string) => `…${String(k).slice(-4)}`;
type Outcome =
  | { kind: 'ok'; text: string; sources?: WebSource[] }
  | { kind: 'dead-key'; why: string }
  | { kind: 'rate'; why: string; daily: boolean }
  | { kind: 'model-gone'; why: string }
  | { kind: 'too-large'; why: string }
  | { kind: 'blocked'; why: string }
  | { kind: 'bad-request'; why: string; extras: boolean }
  | { kind: 'server'; why: string };

function errMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    return String(e?.message || j?.message || text).replace(/\s+/g, ' ').slice(0, 240);
  } catch {
    return String(text || '').replace(/\s+/g, ' ').slice(0, 240);
  }
}

export class LlmPool {
  cfg: LlmConfig;
  exhausted = new Set<string>();          // provider:model
  deadKeys = new Map<string, string>();   // key → reason
  pairDone = new Set<string>();           // key|model
  cursor: Record<Provider, number> = { gemini: 0, groq: 0 };
  lastErrors: string[] = [];

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
    const seed = Math.abs(Math.floor(cfg.seed || 0));
    this.cursor.gemini = cfg.geminiKeys.length ? seed % cfg.geminiKeys.length : 0;
    this.cursor.groq = cfg.groqKeys.length ? seed % cfg.groqKeys.length : 0;
  }

  get hasKeys() { return this.cfg.geminiKeys.length + this.cfg.groqKeys.length > 0; }
  private log(m: string) { this.cfg.log?.(m); }
  private keysFor(p: Provider): string[] {
    const list = p === 'gemini' ? this.cfg.geminiKeys : this.cfg.groqKeys;
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const k = list[(this.cursor[p] + i) % list.length];
      if (!this.deadKeys.has(k)) out.push(k);
    }
    return out;
  }
  models(p: Provider, req?: LlmRequest): string[] {
    let list = p === 'gemini' ? this.cfg.geminiModels || GEMINI_MODELS_DEFAULT : this.cfg.groqModels || GROQ_MODELS_DEFAULT;
    // Research and vision need special Groq models (the Gemini ones do both natively).
    if (p === 'groq' && req?.webSearch) list = GROQ_SEARCH_MODELS;
    else if (p === 'groq' && req?.images?.length) list = GROQ_VISION_MODELS;
    const mode = this.modeOf(req);
    return list.filter((m) => !this.exhausted.has(`${p}:${m}${mode}`));
  }
  private modeOf(req?: LlmRequest): string { return req?.webSearch ? '#search' : req?.images?.length ? '#vision' : ''; }

  /** Every usable (provider, model) answer, best first. Stop iterating once an answer is good enough. */
  async *attempts(req: LlmRequest): AsyncGenerator<LlmAttempt> {
    let user = req.user;
    for (const provider of ['gemini', 'groq'] as Provider[]) {
      if (!(provider === 'gemini' ? this.cfg.geminiKeys : this.cfg.groqKeys).length) continue;
      for (const model of this.models(provider, req)) {
        let serverErrors = 0;
        let withExtras = true;
        let answered = false;
        let keys = this.keysFor(provider).filter((k) => !this.pairDone.has(`${k}|${model}`));
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const t0 = Date.now();
          const out = await this.call(provider, model, key, { ...req, user }, withExtras);
          const ms = Date.now() - t0;
          if (out.kind === 'ok') {
            this.cursor[provider] = (provider === 'gemini' ? this.cfg.geminiKeys : this.cfg.groqKeys).indexOf(key);
            answered = true;
            yield { provider, model, text: out.text, ms, sources: out.sources };
            break; // the caller wants another answer → next MODEL, never the same one again
          }
          const note = `${provider}/${model} key ${tail(key)}: ${out.why}`;
          this.lastErrors.push(note);
          if (out.kind === 'dead-key') { this.deadKeys.set(key, out.why); this.log(`${note} — key retired, next key.`); continue; }
          if (out.kind === 'rate') { this.pairDone.add(`${key}|${model}`); this.log(`${note} — ${out.daily ? 'daily quota used' : 'rate-limited'}, next key.`); continue; }
          if (out.kind === 'model-gone') { this.log(`${note} — model unavailable, next model.`); break; }
          if (out.kind === 'too-large') { this.log(`${note} — request too large for this model's free tier, next model.`); break; }
          if (out.kind === 'blocked') {
            if (req.saferUser && user !== req.saferUser) { user = req.saferUser; this.log(`${note} — safety filter; retrying with softer wording.`); i--; continue; }
            this.log(`${note} — blocked, next model.`);
            break;
          }
          if (out.kind === 'bad-request') {
            if (out.extras && withExtras) { withExtras = false; i--; continue; } // retry the same key without optional params
            this.log(`${note} — next model.`);
            break;
          }
          // server / network / timeout: one more key, then next model
          if (++serverErrors >= 2) { this.log(`${note} — next model.`); break; }
          this.log(`${note} — trying another key.`);
        }
        // Either every key is spent / the model is gone, or it answered and the caller wants a
        // different answer: never ask this model again in this run.
        this.exhausted.add(`${provider}:${model}${this.modeOf(req)}`);
        if (!answered && !this.keysFor(provider).length) break; // no live keys left for this provider
      }
    }
  }

  private async call(p: Provider, model: string, key: string, req: LlmRequest, extras: boolean): Promise<Outcome> {
    const f = this.cfg.fetchImpl || fetch;
    const timeout = req.timeoutMs || 90000;
    try {
      if (p === 'gemini') {
        const base = (this.cfg.geminiBase || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
        const gen: any = { temperature: req.temperature ?? 0.8, maxOutputTokens: req.maxTokens || 8192 };
        // Grounded (search) answers cannot be forced into JSON mode: the JSON is parsed from the text.
        if (req.json && !req.webSearch) gen.responseMimeType = 'application/json';
        if (extras) {
          if (/2\.5-flash(?!-lite)/.test(model)) gen.thinkingConfig = { thinkingBudget: 512 };
          else if (/gemini-3/.test(model)) gen.thinkingConfig = { thinkingLevel: 'low' };
        }
        const body = {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [
            ...(req.images || []).map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
            { text: req.user }
          ] }],
          ...(req.webSearch ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: gen,
          safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
            .map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }))
        };
        const res = await f(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout)
        });
        const text = await res.text();
        if (!res.ok) return this.classify(p, res.status, text);
        let data: any;
        try { data = JSON.parse(text); } catch { return { kind: 'server', why: 'unreadable response' }; }
        if (data?.promptFeedback?.blockReason) return { kind: 'blocked', why: `prompt blocked (${data.promptFeedback.blockReason})` };
        const cand = data?.candidates?.[0];
        const out = (cand?.content?.parts || []).filter((x: any) => !x?.thought).map((x: any) => x?.text || '').join('').trim();
        if (!out) {
          const fr = String(cand?.finishReason || 'empty');
          if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(fr)) return { kind: 'blocked', why: `answer blocked (${fr})` };
          return { kind: 'server', why: `empty answer (${fr})` };
        }
        const chunks = cand?.groundingMetadata?.groundingChunks || [];
        const sources: WebSource[] = chunks.map((c: any) => ({ title: String(c?.web?.title || c?.web?.domain || ''), uri: String(c?.web?.uri || '') })).filter((x: WebSource) => x.title || x.uri);
        if (req.webSearch && !sources.length && !/search/i.test(JSON.stringify(cand?.groundingMetadata || {}))) {
          // The model answered from memory instead of searching: not good enough for research.
          return { kind: 'model-gone', why: 'answered without searching the web' };
        }
        return { kind: 'ok', text: out, sources };
      }
      const base = (this.cfg.groqBase || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
      const body: any = {
        model,
        temperature: req.temperature ?? 0.8,
        max_completion_tokens: req.maxTokens || 8192,
        messages: [{ role: 'system', content: req.system }, {
          role: 'user',
          content: req.images?.length
            ? [...req.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })), { type: 'text', text: req.user }]
            : req.user
        }]
      };
      if (req.json && extras && !req.webSearch) body.response_format = { type: 'json_object' };
      if (extras && /gpt-oss/.test(model)) body.reasoning_effort = 'low';
      const res = await f(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
      const text = await res.text();
      if (!res.ok) return this.classify(p, res.status, text);
      let data: any;
      try { data = JSON.parse(text); } catch { return { kind: 'server', why: 'unreadable response' }; }
      const msg = data?.choices?.[0]?.message || {};
      const out = String(msg.content || '').trim();
      if (!out) return { kind: 'server', why: `empty answer (${data?.choices?.[0]?.finish_reason || 'none'})` };
      // Compound models report the searches they ran (executed_tools[].search_results).
      const sources: WebSource[] = [];
      for (const t of Array.isArray(msg.executed_tools) ? msg.executed_tools : []) {
        for (const r of t?.search_results?.results || []) if (r?.url) sources.push({ title: String(r.title || ''), uri: String(r.url) });
      }
      if (req.webSearch && !sources.length) {
        for (const m of out.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) sources.push({ title: '', uri: m[0] });
      }
      return { kind: 'ok', text: out, sources };
    } catch (err: any) {
      const m = String(err?.name === 'TimeoutError' ? `timed out after ${Math.round(timeout / 1000)}s` : err?.message || err);
      return { kind: 'server', why: m.slice(0, 160) };
    }
  }

  private classify(p: Provider, status: number, text: string): Outcome {
    const why = `HTTP ${status} ${errMessage(text)}`.trim();
    const low = text.toLowerCase();
    if (status === 401) return { kind: 'dead-key', why };
    if (status === 403) {
      // Gemini: API disabled / key leaked / no permission → the key is unusable. Groq: org/key blocked.
      if (/model|not have access to (the )?model|permission.*model/.test(low) && p === 'groq') return { kind: 'model-gone', why };
      return { kind: 'dead-key', why };
    }
    if (status === 400 && /api key not valid|api_key_invalid|invalid api key|expired/.test(low)) return { kind: 'dead-key', why };
    if (status === 404) return { kind: 'model-gone', why };
    if (status === 400 && /model.*(not found|not supported|does not exist|decommissioned)|unknown model|is not found for api version/.test(low)) return { kind: 'model-gone', why };
    if (status === 413 || /request too large|reduce your message size/.test(low)) return { kind: 'too-large', why };
    if (status === 429 || /resource_exhausted|quota|rate limit/.test(low)) return { kind: 'rate', why, daily: /per ?day|perday|daily|tpd|rpd/.test(low) };
    if (status === 400 && /json_validate_failed|failed to generate json|thinking|reasoning_effort|response_format|responsemimetype|unknown name|invalid json payload/.test(low)) return { kind: 'bad-request', why, extras: true };
    if (status === 400 && /safety|blocked/.test(low)) return { kind: 'blocked', why };
    if (status >= 500 || status === 0) return { kind: 'server', why };
    return { kind: 'bad-request', why, extras: false };
  }
}

/** First JSON object in a model answer (tolerates code fences and <think> blocks). */
export function extractJsonObject(text: string): any {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json/gi, '```').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}
