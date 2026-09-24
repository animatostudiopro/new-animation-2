/**
 * Fact research + fact checking for every NON-story video (news, tech reviews,
 * tutorials, cooking, ads).
 *
 * Why: viewers reported "fake news" — the writer only saw a one-line headline
 * and filled a minute of narration with guesses. Now:
 *
 *   1. RESEARCH  — before a word is written, the story is researched on the live
 *      web: the publishers' own articles (Google News + Bing News), the article
 *      text itself, and a web-grounded AI research pass (Gemini + Google Search,
 *      or Groq's web-search models). A story is only used when it is confirmed
 *      by at least two independent outlets (or one full article + a grounded
 *      confirmation). Unconfirmed / rumour / satire stories are skipped.
 *   2. WRITE     — the script writer gets a FACT SHEET and may only state what
 *      is on it (plus universally known background).
 *   3. CHECK     — an independent fact-checker compares every scene with the
 *      fact sheet. Wrong or unsupported sentences are corrected or removed.
 *      If the script still is not clean after that, NOTHING is published
 *      (the run fails with `fact_check_failed` and retries later).
 *
 * Pure fetch, no dependencies (Node 22 on the GitHub runner).
 */
import { LlmPool, extractJsonObject, type WebSource } from './llm.ts';

export interface Headline { title: string; source: string; date: string; link: string }
export interface FactPack {
  /** The headline / dish / product this video is about. */
  subject: string;
  /** Short verified facts, one per line, each with where it came from. */
  facts: string[];
  /** Readable excerpts of the real articles / pages (trimmed). */
  excerpts: { source: string; url: string; text: string }[];
  /** Distinct outlets / sites that confirm the subject. */
  outlets: string[];
  /** Links cited in the description. */
  links: { title: string; url: string }[];
  /** Tech: the product's name and official site, when research found them. */
  productName?: string;
  officialUrl?: string;
  /** Cooking: a verified recipe (ingredients + method) from real recipe sources. */
  recipe?: string;
  /** Headline object this pack belongs to (news / tech). */
  headline?: Headline;
  /** True when the subject was confirmed by independent sources. */
  confirmed: boolean;
}

export interface ResearchCtx {
  llm: LlmPool;
  log: (m: string) => void;
  offline: boolean;
  category: string;
  subGenre: string;
  topic: string;
  /** Titles already posted on this channel (never repeated). */
  pastTitles: string[];
  adBrief?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const decode = (v: string) => v.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const plain = (html: string) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^(www|m|amp|edition)\./, ''); } catch { return ''; } };
/** "bbc.co.uk" and "BBC News" → "bbc" so the same outlet is never counted twice. */
const outletKey = (s: string) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|m|amp|edition)\./, '').replace(/\.(com|co|org|net|news|uk|us|ng|in|au|ca|io|tv|info|gov|edu)(\.[a-z]{2})?(\/.*)?$/, '').replace(/\s+(news|online|media|group|tv)$/, '').replace(/[^a-z0-9]/g, '');
const NOT_OUTLETS = /^(vertexaisearch|google|bing|news|msn|yahoo|youtube|facebook|twitter|x|instagram|tiktok|reddit|wikipedia)$/;

async function getText(url: string, ms = 15000, max = 1_500_000): Promise<{ text: string; url: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, max).toString('utf8'), url: res.url || url };
  } catch { return null; }
}

/** The readable body of a news article / product page (JSON-LD articleBody, else its paragraphs). */
export function articleText(html: string): string {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o: any): string => {
        if (!o || typeof o !== 'object') return '';
        if (typeof o.articleBody === 'string' && o.articleBody.length > 300) return o.articleBody;
        for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = walk(v); if (r) return r; }
        return '';
      };
      const body = walk(JSON.parse(m[1].trim()));
      if (body) return plain(body).slice(0, 6000);
    } catch {}
  }
  const cleaned = html.replace(/<(script|style|noscript|nav|header|footer|aside|form|figure|svg)[\s\S]*?<\/\1>/gi, ' ');
  const scope = (cleaned.match(/<article[\s\S]*?<\/article>/i) || [cleaned])[0];
  const paras = Array.from(scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)).map((m) => plain(m[1]))
    .filter((p) => p.length > 60 && !/cookie|subscribe|newsletter|sign up|all rights reserved|advertis|javascript/i.test(p));
  return paras.join('\n').slice(0, 6000);
}

/** Google News RSS links are wrapped; this unwraps them to the publisher's URL (best effort). */
async function unwrapGoogleNews(link: string): Promise<string> {
  if (!/news\.google\.com\/(rss\/)?articles\//.test(link)) return link;
  try {
    const id = (link.match(/articles\/([^?/#]+)/) || [])[1];
    if (!id) return '';
    const page = await getText(`https://news.google.com/articles/${id}?hl=en-US&gl=US&ceid=US:en`, 12000, 400_000);
    const sig = page?.text.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page?.text.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sig || !ts) return '';
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`;
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA }, body, signal: AbortSignal.timeout(12000)
    });
    const txt = await res.text();
    const m = txt.match(/garturlres\\",\\"(https?:[^\\"]+)/);
    return m ? m[1].replace(/\\+u003d/g, '=').replace(/\\+u0026/g, '&') : '';
  } catch { return ''; }
}

/** Other outlets covering the same story (Bing News RSS gives the publishers' real URLs). */
async function bingNews(query: string): Promise<{ title: string; url: string; desc: string; outlet: string }[]> {
  const r = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en-US&cc=US`, 15000, 600_000);
  if (!r) return [];
  const out: { title: string; url: string; desc: string; outlet: string }[] = [];
  for (const m of r.text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = plain((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    let url = plain((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const real = url.match(/[?&]url=([^&]+)/);
    if (real) { try { url = decodeURIComponent(real[1]); } catch {} }
    const desc = plain((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    const outlet = plain((b.match(/<News:Source>([\s\S]*?)<\/News:Source>/i) || [])[1] || '') || hostOf(url);
    if (title && url) out.push({ title, url, desc, outlet });
  }
  return out.slice(0, 8);
}

const words = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
const STOP = new Set(['this', 'that', 'with', 'from', 'will', 'have', 'says', 'said', 'after', 'about', 'what', 'when', 'your', 'their', 'more', 'than', 'into', 'over', 'just', 'news', 'here', 'they', 'been', 'were', 'report', 'reports', 'amid', 'could', 'would', 'should', 'first', 'new', 'latest']);
/** Share of the headline's meaningful words that appear in `text`. */
export function overlap(headline: string, text: string): number {
  const h = Array.from(new Set(words(headline)));
  if (!h.length) return 0;
  const t = new Set(words(text));
  return h.filter((w) => t.has(w) || t.has(w.replace(/s$/, ''))).length / h.length;
}

/** A web-grounded research pass: the AI searches the web and returns only facts it can source. */
async function groundedResearch(ctx: ResearchCtx, question: string, shape: string): Promise<{ data: any; sources: WebSource[]; model: string } | null> {
  if (ctx.offline || !ctx.llm.hasKeys) return null;
  const system = 'You are a meticulous fact-checking researcher for a news desk. You search the live web, read several reputable independent sources, and report ONLY facts those sources state. You never guess, never fill gaps and never present rumours as facts. You answer with one JSON object and nothing else.';
  for await (const a of ctx.llm.attempts({ system, user: `${question}\n\nReturn ONLY this JSON:\n${shape}`, webSearch: true, json: true, temperature: 0.1, maxTokens: 4000, timeoutMs: 120000 })) {
    try {
      const data = extractJsonObject(a.text);
      return { data, sources: a.sources || [], model: `${a.provider}/${a.model}` };
    } catch (err: any) {
      ctx.log(`Research answer from ${a.provider}/${a.model} was unreadable (${err?.message}) — asking another model.`);
    }
  }
  return null;
}

const FACT_SHAPE = `{
  "confirmed": true,
  "status": "confirmed | developing | rumour | false | satire",
  "summary": "3-5 sentence neutral summary of what is confirmed",
  "date": "when it happened (as reported)",
  "facts": ["one verifiable fact per item, with the outlet that reports it in brackets, e.g. 'The phone starts at $799 (The Verge)'"],
  "uncertain": ["claims that are only reported by one outlet, disputed or unconfirmed"],
  "productName": "tech only: the exact product/tool/model name, else empty",
  "officialUrl": "tech only: the product's official website if the sources name it, else empty",
  "outlets": ["names of the independent outlets you read"]
}`;

/**
 * Research one headline. Returns a fact pack, `confirmed` only when independent
 * outlets back it up.
 */
async function researchHeadline(ctx: ResearchCtx, h: Headline): Promise<FactPack> {
  const pack: FactPack = { subject: h.title, facts: [], excerpts: [], outlets: [], links: [], confirmed: false, headline: h };
  const addOutlet = (name: string) => { const k = outletKey(name); if (k && k.length > 1 && !NOT_OUTLETS.test(k) && !pack.outlets.some((o) => outletKey(o) === k)) pack.outlets.push(name); };
  if (h.source) addOutlet(h.source);

  // 1. The same story at other outlets + the article text itself.
  const [coverage, publisherUrl] = await Promise.all([bingNews(h.title.slice(0, 150)), unwrapGoogleNews(h.link)]);
  const related = coverage.filter((c) => overlap(h.title, `${c.title} ${c.desc}`) >= 0.5);
  for (const c of related) addOutlet(c.outlet || hostOf(c.url));
  const urls = Array.from(new Set([publisherUrl, ...related.map((c) => c.url)].filter(Boolean))).slice(0, 5);
  const bodies = await Promise.all(urls.map(async (u) => {
    const page = await getText(u, 15000);
    if (!page) return null;
    const text = articleText(page.text);
    return text.length > 400 && overlap(h.title, text) >= 0.4 ? { source: hostOf(page.url), url: page.url, text } : null;
  }));
  for (const b of bodies) if (b && pack.excerpts.length < 3) { pack.excerpts.push({ ...b, text: b.text.slice(0, 2800) }); addOutlet(b.source); pack.links.push({ title: b.source, url: b.url }); }
  for (const c of related.slice(0, 4)) if (c.desc) pack.facts.push(`${c.desc} (${c.outlet || hostOf(c.url)})`);

  // 2. Web-grounded research pass.
  const g = await groundedResearch(ctx,
    `Research this news story on the live web and verify it: "${h.title}"${h.source ? ` (first reported by ${h.source}${h.date ? `, ${h.date}` : ''})` : ''}.\nRead at least two independent reputable outlets. Report what is actually confirmed — names, numbers, dates, places, prices, specs — exactly as the sources state them. If it is a rumour, leak, satire, or you cannot confirm it, say so in "status" and set "confirmed" to false.`,
    FACT_SHAPE);
  if (g) {
    const d = g.data || {};
    const status = String(d.status || '').toLowerCase();
    if (d.summary) pack.facts.unshift(`SUMMARY: ${String(d.summary).slice(0, 900)}`);
    if (d.date) pack.facts.push(`DATE: ${String(d.date).slice(0, 80)}`);
    for (const f of (Array.isArray(d.facts) ? d.facts : []).slice(0, 18)) pack.facts.push(String(f).slice(0, 300));
    for (const u of (Array.isArray(d.uncertain) ? d.uncertain : []).slice(0, 6)) pack.facts.push(`UNCONFIRMED (only say "reportedly" or leave out): ${String(u).slice(0, 240)}`);
    for (const o of Array.isArray(d.outlets) ? d.outlets : []) addOutlet(String(o));
    for (const s of g.sources) addOutlet(s.title || hostOf(s.uri));
    if (d.productName) pack.productName = String(d.productName).slice(0, 80);
    if (d.officialUrl) pack.officialUrl = String(d.officialUrl).slice(0, 200);
    const refuted = /false|satire|rumou?r|hoax|fake/.test(status) || d.confirmed === false;
    if (refuted) {
      ctx.log(`Research (${g.model}): "${h.title}" is ${status || 'not confirmed'} — skipped.`);
      return pack;
    }
    pack.confirmed = pack.outlets.length >= 2 || (pack.excerpts.length >= 1 && g.sources.length >= 1);
  } else {
    // No research model answered: only independent coverage with real article text counts.
    pack.confirmed = pack.outlets.length >= 2 && pack.excerpts.length >= 1;
  }
  ctx.log(`Research: "${h.title.slice(0, 80)}" — ${pack.outlets.length} outlet(s) [${pack.outlets.slice(0, 6).join(', ')}], ${pack.excerpts.length} article text(s), ${pack.facts.length} fact line(s) → ${pack.confirmed ? 'CONFIRMED' : 'not confirmed, skipped'}.`);
  return pack;
}

/** News / tech: research the freshest headlines in order and keep the first confirmed one. */
export async function researchNews(ctx: ResearchCtx, headlines: Headline[]): Promise<FactPack | null> {
  if (ctx.offline) return null;
  for (const h of headlines.slice(0, 4)) {
    const pack = await researchHeadline(ctx, h);
    if (pack.confirmed) return pack;
  }
  // No fresh headline could be confirmed: a well-documented, verifiable subject instead.
  const g = await groundedResearch(ctx,
    ctx.category === 'tech'
      ? `Find ONE real AI tool, app, model or gadget${ctx.subGenre ? ` in the area "${ctx.subGenre}"` : ''}${ctx.topic ? ` (creator's direction: "${ctx.topic}")` : ''} that launched or had a major confirmed update in the last 30 days, confirmed by at least two reputable tech outlets. Avoid: ${ctx.pastTitles.slice(-12).join(' | ') || 'nothing'}. Report what it does, where to get it, pricing and how to use it, exactly as the sources state.`
      : `Find ONE important news story${ctx.subGenre ? ` about "${ctx.subGenre}"` : ''}${ctx.topic ? ` (creator's direction: "${ctx.topic}")` : ''} from the last 48 hours that is confirmed by at least two reputable independent outlets. Avoid: ${ctx.pastTitles.slice(-12).join(' | ') || 'nothing'}. Report the confirmed facts exactly as the sources state them.`,
    `{ "headline": "the story's headline", ${FACT_SHAPE.slice(1)}`);
  if (!g || g.data?.confirmed === false || !g.data?.headline) return null;
  const d = g.data;
  const pack: FactPack = {
    subject: String(d.headline).slice(0, 200), facts: [], excerpts: [], outlets: [], links: [], confirmed: false,
    headline: { title: String(d.headline).slice(0, 200), source: String((d.outlets || [])[0] || ''), date: String(d.date || ''), link: '' }
  };
  if (d.summary) pack.facts.push(`SUMMARY: ${String(d.summary).slice(0, 900)}`);
  for (const f of (Array.isArray(d.facts) ? d.facts : []).slice(0, 18)) pack.facts.push(String(f).slice(0, 300));
  for (const u of (Array.isArray(d.uncertain) ? d.uncertain : []).slice(0, 6)) pack.facts.push(`UNCONFIRMED (only say "reportedly" or leave out): ${String(u).slice(0, 240)}`);
  const outs = new Set<string>();
  for (const o of [...(Array.isArray(d.outlets) ? d.outlets : []), ...g.sources.map((s) => s.title || hostOf(s.uri))]) { const k = outletKey(String(o)); if (k && !NOT_OUTLETS.test(k) && !outs.has(k)) { outs.add(k); pack.outlets.push(String(o)); } }
  pack.productName = d.productName ? String(d.productName).slice(0, 80) : undefined;
  pack.officialUrl = d.officialUrl ? String(d.officialUrl).slice(0, 200) : undefined;
  pack.confirmed = pack.outlets.length >= 2 && pack.facts.length >= 3;
  ctx.log(`Research (${g.model}): picked "${pack.subject.slice(0, 80)}" — ${pack.outlets.length} outlet(s) → ${pack.confirmed ? 'CONFIRMED' : 'not confirmed'}.`);
  return pack.confirmed ? pack : null;
}

/** Cooking: pick a dish and get a real, tested recipe from real recipe sources before writing. */
export async function researchRecipe(ctx: ResearchCtx): Promise<FactPack | null> {
  if (ctx.offline) return null;
  const g = await groundedResearch(ctx,
    `Pick ONE specific, genuinely good dish${ctx.subGenre ? ` in the style "${ctx.subGenre}"` : ''}${ctx.topic ? ` (creator's direction: "${ctx.topic}")` : ''} that is NOT one of: ${ctx.pastTitles.slice(-15).join(' | ') || 'nothing yet'}.\nSearch the web for well-tested recipes of it from reputable recipe sites or cooks, compare them, and report one correct, safe recipe: every ingredient with its exact amount, the method in order with correct times and temperatures (and safe internal temperatures for meat, poultry, fish or eggs), servings, and one genuine tip the sources give.`,
    `{
  "dish": "dish name",
  "servings": "e.g. 4",
  "ingredients": ["amount + ingredient, e.g. '2 cups long-grain parboiled rice'"],
  "steps": ["one step each, with time/temperature where it matters"],
  "tip": "one genuine tip from the sources",
  "safety": "any food-safety note (safe internal temperature etc.) or empty",
  "outlets": ["recipe sites / cooks you used"]
}`);
  if (!g || !g.data?.dish || !Array.isArray(g.data?.ingredients) || !Array.isArray(g.data?.steps) || g.data.ingredients.length < 2) return null;
  const d = g.data;
  const recipe = [`DISH: ${d.dish}${d.servings ? ` (serves ${d.servings})` : ''}`, 'INGREDIENTS:', ...d.ingredients.slice(0, 25).map((x: any) => `- ${String(x).slice(0, 140)}`), 'METHOD:', ...d.steps.slice(0, 20).map((x: any, i: number) => `${i + 1}. ${String(x).slice(0, 300)}`), d.tip ? `TIP: ${String(d.tip).slice(0, 300)}` : '', d.safety ? `SAFETY: ${String(d.safety).slice(0, 300)}` : ''].filter(Boolean).join('\n');
  const outlets = Array.from(new Set([...(Array.isArray(d.outlets) ? d.outlets : []).map(String), ...g.sources.map((s) => s.title || hostOf(s.uri))].filter(Boolean))).slice(0, 6);
  ctx.log(`Recipe research (${g.model}): "${d.dish}" from ${outlets.join(', ') || 'web sources'}.`);
  return { subject: String(d.dish).slice(0, 120), facts: [], excerpts: [], outlets, links: [], recipe, confirmed: true };
}

/** The fact sheet as it is shown to the script writer and to the fact-checker. */
export function factSheet(p: FactPack): string {
  return [
    `SUBJECT: ${p.subject}`,
    p.headline?.date ? `FIRST REPORTED: ${p.headline.date}${p.headline.source ? ` by ${p.headline.source}` : ''}` : '',
    p.outlets.length ? `CONFIRMED BY: ${p.outlets.slice(0, 8).join(', ')}` : '',
    p.productName ? `PRODUCT: ${p.productName}${p.officialUrl ? ` — official site ${p.officialUrl}` : ''}` : '',
    p.recipe ? `VERIFIED RECIPE:\n${p.recipe}` : '',
    p.facts.length ? `VERIFIED FACTS:\n${p.facts.map((f) => `- ${f}`).join('\n')}` : '',
    ...p.excerpts.map((e, i) => `ARTICLE ${i + 1} (${e.source}):\n${e.text}`)
  ].filter(Boolean).join('\n\n').slice(0, 14000);
}

// ---------------------------------------------------------------------------
// Fact check
// ---------------------------------------------------------------------------
export interface CheckScene { tagged: string }
export interface CheckResult {
  ok: boolean;
  /** scene index → corrected narration (with tags), or '' to remove the scene */
  fixes: Map<number, string>;
  issues: string[];
  model: string;
  titleFix?: string;
  descriptionFix?: string;
}

export async function factCheck(ctx: ResearchCtx, sheet: string, scenes: CheckScene[], title: string, description: string): Promise<CheckResult | null> {
  if (ctx.offline || !ctx.llm.hasKeys) return null;
  const kind = ctx.category === 'cooking' ? 'cooking tutorial' : ctx.category === 'ads' ? 'product advert' : ctx.category === 'tech' ? 'tech review / tutorial' : 'news report';
  const system = 'You are a strict, independent fact-checker for a video publisher. You compare a script with its source material, sentence by sentence. You flag anything that is wrong, invented, exaggerated, speculative-presented-as-fact, or not supported by the sources. You answer with one JSON object and nothing else.';
  const user = `Fact-check this ${kind} script against the SOURCE MATERIAL.

SOURCE MATERIAL
${sheet}

SCRIPT
TITLE: ${title}
DESCRIPTION: ${description}
${scenes.map((s, i) => `SCENE ${i}: ${s.tagged}`).join('\n')}

RULES
- A claim is OK only if the source material states it, or it is universally known, stable background (e.g. "Nvidia makes graphics chips", "salt enhances flavour").
- Numbers, prices, specs, dates, names, places, quotes, rankings, "first/only/biggest" claims and outcomes must match the source material EXACTLY.
- Anything only marked UNCONFIRMED may appear only with "reportedly"/"according to …".
- Opinions of the presenter ("I love how fast it is"), hooks, questions to the viewer and calls to action are fine as long as they don't state a false fact.
${ctx.category === 'cooking' ? '- Cooking: amounts, times, temperatures and order must match the verified recipe; anything unsafe (undercooked meat/poultry/eggs/fish, dangerous oil handling) is an error.\n' : ''}- For every scene with a problem, give a corrected narration that keeps the same meaning where true, keeps the [tags], is about the same length and only states supported facts. Use "" to delete a scene that cannot be saved.
- Also correct the title/description if they claim anything unsupported.

Return ONLY:
{
  "verdict": "pass" or "fix",
  "problems": [ { "scene": 0, "claim": "the wrong/unsupported claim", "why": "what the sources actually say", "fixed": "[serious] corrected narration with tags, or empty string to delete" } ],
  "title": "corrected title, or empty if fine",
  "description": "corrected description, or empty if fine"
}`;
  for await (const a of ctx.llm.attempts({ system, user, json: true, temperature: 0, maxTokens: 6000, timeoutMs: 120000 })) {
    try {
      const d = extractJsonObject(a.text);
      const fixes = new Map<number, string>();
      const issues: string[] = [];
      for (const p of Array.isArray(d.problems) ? d.problems : []) {
        const i = Number(p?.scene);
        if (!Number.isInteger(i) || i < 0 || i >= scenes.length) continue;
        fixes.set(i, typeof p?.fixed === 'string' ? p.fixed.trim() : '');
        issues.push(`scene ${i}: ${String(p?.claim || '').slice(0, 140)} — ${String(p?.why || '').slice(0, 160)}`);
      }
      const ok = String(d.verdict || '').toLowerCase() === 'pass' && !fixes.size;
      return { ok, fixes, issues, model: `${a.provider}/${a.model}`, titleFix: d.title ? String(d.title).slice(0, 100) : undefined, descriptionFix: d.description ? String(d.description).slice(0, 1200) : undefined };
    } catch (err: any) {
      ctx.log(`Fact-check answer from ${a.provider}/${a.model} was unreadable (${err?.message}) — asking another model.`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image verification — "is this really the thing the presenter is talking about?"
// ---------------------------------------------------------------------------
/** Words that pin down a specific product/model: digits, versions, model letters ("S26", "15", "Pro", "Ultra", "M4"). */
export function identifierTokens(q: string): string[] {
  const t = String(q || '').toLowerCase().split(/[\s/-]+/).filter(Boolean);
  return t.filter((w) => !/[$€£%]/.test(w)).map((w) => w.replace(/[^a-z0-9+]/g, ''))
    .filter((w) => w && !/^(19|20)\d\d$/.test(w) && (/\d/.test(w) || /^(pro|max|ultra|plus|mini|air|lite|fold|flip|edge|fe|se|note|neo)$/.test(w)));
}

/** Text relevance of an image's title/tags to the query: brand + every model identifier must appear. */
export function metadataMatches(query: string, meta: string, strict: boolean): boolean {
  const m = ` ${String(meta || '').toLowerCase().replace(/[_\-.,()]+/g, ' ')} `;
  const ids = identifierTokens(query);
  if (ids.some((id) => !m.includes(` ${id}`) && !m.replace(/\s+/g, '').includes(id))) return false;
  const main = words(query).filter((w) => !/\d/.test(w));
  if (!main.length) return true;
  const hits = main.filter((w) => m.includes(w) || m.includes(w.replace(/(es|s)$/, ''))).length;
  return strict ? hits >= Math.max(1, Math.ceil(main.length * 0.6)) : hits >= 1;
}

/** Ask a vision model whether the picture really shows `subject`. null = could not ask. */
export async function visionMatches(ctx: ResearchCtx, jpegBase64: string, subject: string, context: string): Promise<{ match: boolean; shows: string } | null> {
  if (ctx.offline || !ctx.llm.hasKeys) return null;
  const user = `A ${context} video is about to show this picture while the presenter talks about: "${subject}".
Does the picture clearly and correctly show "${subject}"?
- For a specific product/model (phone, laptop, chip, car…): answer true only if it is that product line from that brand, and nothing visible (logo, design, name on it) shows it is a different product or brand.
- For food/ingredients: true only if that food or ingredient is clearly the main subject.
- For a person/place/organisation/event: true only if it plausibly shows that exact subject (not a generic stock scene).
- Logos only, icons, charts, text-only slides, collages, memes, watermark-covered or blurry images → false.
Return ONLY JSON: {"match": true|false, "shows": "what the picture actually shows, 3-8 words"}`;
  for await (const a of ctx.llm.attempts({ system: 'You verify that pictures match what a video is saying. You answer with one JSON object.', user, images: [{ mime: 'image/jpeg', data: jpegBase64 }], json: true, temperature: 0, maxTokens: 300, timeoutMs: 45000 })) {
    try {
      const d = extractJsonObject(a.text);
      return { match: d.match === true || String(d.match).toLowerCase() === 'true', shows: String(d.shows || '').slice(0, 80) };
    } catch { /* ask the next vision model */ }
  }
  return null;
}
