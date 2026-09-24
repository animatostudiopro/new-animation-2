/**
 * Animato — AI Auto Video Editor (runs on GitHub Actions).
 *
 * Input: a video (e.g. a screen recording of an app) and, optionally, a
 * separate voice recording talking about it. Output: a finished MP4 (+ SRT
 * captions) where
 *   1. the voice is transcribed word by word (Groq Whisper → local faster-whisper);
 *   2. filler words (um, uh, er…), stutters, false starts and long pauses are cut;
 *   3. an AI editor reads the whole transcript and keeps what informs and holds
 *      attention — dropping retakes (the best / last take wins), rambling and
 *      off-topic parts — and may open on the strongest hook;
 *   4. when the voice was recorded separately, the video is "watched" (frames
 *      described by a vision model) and each kept sentence is matched to the
 *      part of the video that shows what is being said;
 *   5. FFmpeg compiles the timeline: clean, levelled voice (denoise,
 *      compression, -16 LUFS), matched video, the chosen frame (9:16, 16:9,
 *      1:1, 4:5 with a blurred fill, or the original), H.264 + AAC, fast start.
 *
 * Run with: node --experimental-strip-types animato-cloud/editor.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { LlmPool, extractJsonObject } from './llm.ts';

const ENV = process.env;
const EVENT = (() => { try { return JSON.parse(fs.readFileSync(ENV.GITHUB_EVENT_PATH || '', 'utf8')); } catch { return {}; } })();
const CP = EVENT.client_payload || {};
const JOB = CP.job || {};
const AUTH = CP.auth || {};
const JOB_ID = String(CP.job_id || ENV.EDITOR_JOB_ID || 'local');
const APP = String(CP.app_url || ENV.APP_URL || '').replace(/\/+$/, '');
const RUN_URL = ENV.GITHUB_RUN_ID ? `${ENV.GITHUB_SERVER_URL || 'https://github.com'}/${ENV.GITHUB_REPOSITORY}/actions/runs/${ENV.GITHUB_RUN_ID}` : '';
const keys = (v: any) => String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x.length > 8);
const GEMINI = keys(AUTH.gemini_api_keys || ENV.GEMINI_API_KEYS);
const GROQ = keys(AUTH.groq_api_keys || ENV.GROQ_API_KEYS);
if (ENV.GITHUB_ACTIONS === 'true') for (const s of [AUTH.runner_key, ...GEMINI, ...GROQ]) if (s && String(s).length > 6) console.log(`::add-mask::${s}`);

const WORK = path.resolve(ENV.ANIMATO_OUTPUT_DIR || 'output/editor');
fs.mkdirSync(WORK, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
class EditError extends Error {}

const LLM = new LlmPool({
  geminiKeys: GEMINI, groqKeys: GROQ, log, seed: Date.now() % 997,
});

async function report(status: string, step: string, progress: number, logLine = '', extra: any = {}) {
  if (logLine) log(logLine);
  if (!APP) return;
  try {
    await fetch(`${APP}/api/editor/jobs/${JOB_ID}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Animato-Runner-Key': String(AUTH.runner_key || '') },
      body: JSON.stringify({ status, step, progress, log: logLine, runUrl: RUN_URL, ...extra }), signal: AbortSignal.timeout(20000)
    });
  } catch (e: any) { log(`(status update failed: ${e?.message})`); }
}

function run(cmd: string, args: string[], timeoutMs = 3600_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
  });
}
async function probe(file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean; fps: number }> {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  const j = JSON.parse(r.out || '{}');
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  const [n, d] = String(v?.r_frame_rate || '30/1').split('/').map(Number);
  return { duration: Number(j.format?.duration || 0), width: v?.width || 0, height: v?.height || 0, hasAudio: (j.streams || []).some((s: any) => s.codec_type === 'audio'), hasVideo: !!v, fps: d ? n / d : 30 };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
async function fetchFile(spec: any, dest: string) {
  if (!spec) return false;
  if (spec.url) {
    // Streamed straight to disk (large screen recordings), with a few retries.
    for (let a = 0; a < 4; a++) {
      const res = await fetch(spec.url, { signal: AbortSignal.timeout(3600_000) }).catch(() => null);
      if (res?.ok && res.body) {
        const { Readable } = await import('node:stream');
        const { pipeline } = await import('node:stream/promises');
        await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest));
        if (!spec.size || fs.statSync(dest).size === Number(spec.size)) return true;
        log(`Download of ${spec.name || 'the file'} was incomplete — retrying.`);
      } else if (res && res.status < 500 && res.status !== 429) {
        throw new EditError(`Could not download ${spec.name || 'the file'} (HTTP ${res.status}).`);
      }
      await new Promise((z) => setTimeout(z, 3000 * (a + 1)));
    }
    throw new EditError(`Could not download ${spec.name || 'the file'} after several tries.`);
  }
  if (spec.base) {
    const fd = fs.openSync(dest, 'w');
    for (let i = 0; i < Number(spec.chunks || 0); i++) {
      let buf: Buffer | null = null;
      for (let a = 0; a < 4 && !buf; a++) {
        const r = await fetch(`${spec.base}/${i}`, { headers: { 'X-Animato-Runner-Key': String(AUTH.runner_key || '') }, signal: AbortSignal.timeout(120000) }).catch(() => null);
        if (r?.ok) buf = Buffer.from(await r.arrayBuffer()); else await new Promise((z) => setTimeout(z, 2000 * (a + 1)));
      }
      if (!buf) throw new EditError(`Could not download part ${i + 1} of ${spec.name || 'the file'}.`);
      fs.writeSync(fd, buf);
    }
    fs.closeSync(fd);
    return true;
  }
  return false;
}
async function sendFile(spec: any, file: string, type: string): Promise<{ chunks?: number; size: number }> {
  const bytes = fs.readFileSync(file);
  if (!spec) { log(`(local run: kept ${path.basename(file)} in ${WORK})`); return { size: bytes.length }; }
  if (spec?.url) {
    const r = await fetch(spec.url, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes, signal: AbortSignal.timeout(3600_000) });
    if (!r.ok) throw new EditError(`Could not upload the result (HTTP ${r.status}).`);
    return { size: bytes.length };
  }
  const size = Number(spec?.chunkSize || 3_500_000);
  let n = 0;
  for (let o = 0; o < bytes.length; o += size, n++) {
    let ok = false;
    for (let a = 0; a < 4 && !ok; a++) {
      const r = await fetch(`${spec.base}/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Animato-Runner-Key': String(AUTH.runner_key || '') }, body: bytes.subarray(o, o + size), signal: AbortSignal.timeout(120000) }).catch(() => null);
      ok = !!r?.ok;
      if (!ok) await new Promise((z) => setTimeout(z, 2000 * (a + 1)));
    }
    if (!ok) throw new EditError(`Could not upload part ${n + 1} of the result.`);
  }
  return { chunks: n, size: bytes.length };
}

// ---------------------------------------------------------------------------
// 1. Transcription (word timings)
// ---------------------------------------------------------------------------
interface W { w: string; s: number; e: number }
async function transcribe(audio: string): Promise<W[]> {
  // Test hook (never set in production): a ready word list.
  if (ENV.EDITOR_TRANSCRIPT && fs.existsSync(ENV.EDITOR_TRANSCRIPT)) return JSON.parse(fs.readFileSync(ENV.EDITOR_TRANSCRIPT, 'utf8'));
  const dur = (await probe(audio)).duration;
  const words: W[] = [];
  // Groq Whisper: 16 kHz mono MP3 pieces of ≤ 10 min (well under the 25 MB limit).
  if (GROQ.length) {
    const piece = 600;
    let ok = true;
    for (let t = 0; t < dur && ok; t += piece) {
      const mp3 = path.join(WORK, `asr_${t}.mp3`);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-t', String(piece + 1), '-i', audio, '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3]);
      let done = false;
      for (const key of GROQ) {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'audio.mp3');
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
        const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300000) }).catch(() => null);
        if (!r?.ok) continue;
        const j: any = await r.json();
        for (const x of j.words || []) if (x.start >= 0 && x.start < piece + 0.5 || t === 0) words.push({ w: String(x.word).trim(), s: t + Number(x.start), e: t + Number(x.end) });
        // Whisper's word list has no punctuation: take it from the segments.
        punctuate(words, (j.segments || []).map((sg: any) => ({ text: String(sg.text || ''), s: t + Number(sg.start), e: t + Number(sg.end) })));
        done = true;
        break;
      }
      if (!done) ok = false;
    }
    if (ok && words.length) { log(`Transcribed ${words.length} words with Groq Whisper.`); return dedupeOverlap(words); }
    words.length = 0;
    log('Groq Whisper was unavailable — transcribing on this runner instead (slower).');
  }
  // Local fallback: faster-whisper (CPU, int8).
  await run('python3', ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'faster-whisper'], 900000);
  const py = path.join(WORK, 'asr.py');
  fs.writeFileSync(py, `import json,sys
from faster_whisper import WhisperModel
m=WhisperModel(sys.argv[2] if len(sys.argv)>2 else "small",device="cpu",compute_type="int8")
segs,_=m.transcribe(sys.argv[1],word_timestamps=True,vad_filter=False)
out=[]
for s in segs:
  for w in (s.words or []): out.append({"w":w.word.strip(),"s":w.start,"e":w.end})
print(json.dumps(out))
`);
  const r = await run('python3', [py, audio, dur > 1800 ? 'base' : 'small'], 3 * 3600_000);
  if (r.code !== 0) throw new EditError(`Transcription failed: ${r.err.slice(-400)}`);
  const list: W[] = JSON.parse(r.out.trim().split('\n').pop() || '[]');
  log(`Transcribed ${list.length} words on the runner (faster-whisper).`);
  return list;
}
function punctuate(words: W[], segs: { text: string; s: number; e: number }[]) {
  for (const sg of segs) {
    const toks = sg.text.trim().split(/\s+/);
    const inSeg = words.filter((w) => w.s >= sg.s - 0.05 && w.e <= sg.e + 0.3 && !/[.!?,]$/.test(w.w));
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9']/g, '');
    let j = 0;
    for (const w of inSeg) {
      while (j < toks.length && norm(toks[j]) !== norm(w.w)) j++;
      if (j < toks.length) { if (/[.!?,;:]$/.test(toks[j])) w.w = w.w.replace(/[.!?,;:]*$/, '') + toks[j].slice(-1); j++; }
    }
  }
}
function dedupeOverlap(words: W[]): W[] {
  words.sort((a, b) => a.s - b.s);
  return words.filter((w, i) => i === 0 || !(Math.abs(w.s - words[i - 1].s) < 0.02 && w.w === words[i - 1].w));
}

// ---------------------------------------------------------------------------
// 2. Clean-up: fillers, stutters, sentences
// ---------------------------------------------------------------------------
const FILLER = /^(um+|uh+|uhm+|erm+|er+|ah+|eh+|hmm+|mm+|mhm|uh-huh|umm+)[.,!?]?$/i;
interface Sentence { id: number; text: string; s: number; e: number; words: W[] }
function sentences(words: W[]): { list: Sentence[]; fillers: number; stutters: number } {
  let fillers = 0, stutters = 0;
  const kept: W[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const bare = w.w.toLowerCase().replace(/[^a-z']/g, '');
    if (FILLER.test(w.w.trim())) { fillers++; continue; }
    // Stutter / repeated word ("the the", "I I").
    const nextBare = (words[i + 1]?.w || '').toLowerCase().replace(/[^a-z']/g, '');
    if (bare && bare === nextBare && words[i + 1].s - w.e < 0.6 && bare.length < 8) { stutters++; continue; }
    // "you know" / "I mean" as verbal fillers between pauses.
    const pair = `${bare} ${nextBare}`;
    if ((pair === 'you know' || pair === 'i mean') && (i === 0 || w.s - words[i - 1].e > 0.25)) { fillers++; i++; continue; }
    kept.push(w);
  }
  const list: Sentence[] = [];
  let cur: W[] = [];
  const flush = () => { if (cur.length) { list.push({ id: list.length, text: cur.map((x) => x.w).join(' ').replace(/\s+([,.!?])/g, '$1'), s: cur[0].s, e: cur[cur.length - 1].e, words: cur }); cur = []; } };
  kept.forEach((w, i) => {
    if (cur.length && w.s - cur[cur.length - 1].e > 1.1) flush(); // a long pause ends a thought
    cur.push(w);
    const len = cur.length;
    if (/[.!?]$/.test(w.w) || len > 40 || (i === kept.length - 1)) flush();
  });
  flush();
  return { list, fillers, stutters };
}

// ---------------------------------------------------------------------------
// 3. The AI editor: keep what informs and holds attention
// ---------------------------------------------------------------------------
async function planEdit(list: Sentence[], instructions: string): Promise<{ keep: number[]; removed: { id: number; reason: string }[]; title: string; model: string }> {
  const lines = list.map((x) => `${x.id} [${x.s.toFixed(1)}-${x.e.toFixed(1)}s] ${x.text}`).join('\n');
  const user = `You are a top short-form video editor. Below is the word-accurate transcript of a creator's voice-over, split into numbered sentences with timings. Filler sounds are already removed.

Decide what stays in the final video:
- KEEP every sentence that explains, shows, persuades or entertains — the substance of what they are saying.
- REMOVE: retakes / repeated attempts at the same line (keep only the BEST, usually the last complete take), false starts and abandoned sentences, rambling that repeats a point already made, off-topic asides, "wait / let me try again / sorry" moments, test phrases ("testing, one two"), and dead openings ("so, um, hi, so today…") when a stronger opening exists.
- Keep the original order, EXCEPT you may move ONE strong hook sentence (a benefit or surprising fact) to the very start if the recording opens weakly.
- Never cut the middle of an explanation so that it stops making sense. When unsure, keep.
${instructions ? `\nTHE CREATOR'S INSTRUCTIONS (follow them): ${instructions}\n` : ''}
TRANSCRIPT
${lines}

Return ONLY JSON: {"keep": [sentence ids in final order], "removed": [{"id": 3, "reason": "retake of 4"}], "title": "a short title for the video"}`;
  for await (const a of LLM.attempts({ system: 'You are an expert video editor. You answer with one JSON object.', user, json: true, temperature: 0.2, maxTokens: 6000, timeoutMs: 120000, task: 'editor_plan' })) {
    try {
      const j = extractJsonObject(a.text);
      const ids = new Set(list.map((x) => x.id));
      const keep = (Array.isArray(j.keep) ? j.keep : []).map(Number).filter((x: number, i: number, arr: number[]) => ids.has(x) && arr.indexOf(x) === i);
      if (keep.length < Math.max(1, Math.round(list.length * 0.25))) throw new Error(`kept only ${keep.length}/${list.length}`);
      return { keep, removed: (Array.isArray(j.removed) ? j.removed : []).map((r: any) => ({ id: Number(r.id), reason: String(r.reason || '') })), title: String(j.title || ''), model: `${a.provider}/${a.model}` };
    } catch (e: any) { log(`Edit plan from ${a.provider}/${a.model} unusable (${e?.message}).`); }
  }
  // No model: drop retakes by similarity (keep the last take), keep the rest in order.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean);
  const sim = (a: string, b: string) => { const A = new Set(norm(a)), B = norm(b); return B.length ? B.filter((x) => A.has(x)).length / Math.max(A.size, B.length) : 0; };
  const keep = list.filter((x, i) => !list.slice(i + 1, i + 4).some((y) => sim(x.text, y.text) > 0.6) && x.words.length >= 2).map((x) => x.id);
  return { keep, removed: [], title: '', model: 'rules' };
}

// ---------------------------------------------------------------------------
// 4. Watch the video and match each sentence to what is on screen
// ---------------------------------------------------------------------------
async function describeFrames(video: string, duration: number): Promise<{ t: number; d: string }[]> {
  const n = Math.max(6, Math.min(90, Math.round(duration / 2)));
  const step = duration / n;
  const frames: { t: number; file: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = +(i * step + step / 2).toFixed(2);
    const f = path.join(WORK, `f_${i}.jpg`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '6', f]);
    if (fs.existsSync(f)) frames.push({ t, file: f });
  }
  const out: { t: number; d: string }[] = [];
  for (let i = 0; i < frames.length; i += 8) {
    const batch = frames.slice(i, i + 8);
    let got = false;
    for await (const a of LLM.attempts({
      system: 'You describe video frames for an editor. Answer with one JSON object.',
      user: `These ${batch.length} images are frames from a screen recording / video, in order. For EACH frame say in 8-18 words exactly what is on screen (which app/page/screen, the feature or button in focus, any headline text, what the person is doing). Return ONLY JSON: {"frames": ["...", "..."]} with exactly ${batch.length} items.`,
      images: batch.map((b) => ({ mime: 'image/jpeg', data: fs.readFileSync(b.file).toString('base64') })),
      json: true, temperature: 0, maxTokens: 1200, timeoutMs: 90000, task: 'editor_vision'
    })) {
      try {
        const j = extractJsonObject(a.text);
        (j.frames || []).slice(0, batch.length).forEach((d: any, k: number) => out.push({ t: batch[k].t, d: String(d).slice(0, 160) }));
        got = true;
        break;
      } catch {}
    }
    if (!got) batch.forEach((b) => out.push({ t: b.t, d: '' }));
  }
  return out;
}

async function matchVideo(kept: Sentence[], frames: { t: number; d: string }[], videoDur: number, audioDur: number): Promise<number[]> {
  // Default: time-proportional (works when the voice was recorded along with the video).
  const linear = kept.map((x) => Math.max(0, Math.min(videoDur - (x.e - x.s), x.s * (videoDur / Math.max(1, audioDur)))));
  if (!frames.some((f) => f.d)) return linear;
  const user = `You are editing a video. The voice-over sentences below must each be shown over the part of the video that matches what is said.

VIDEO (${videoDur.toFixed(1)} s) — what is on screen at each time:
${frames.map((f) => `${f.t.toFixed(1)}s: ${f.d || '(unknown)'}`).join('\n')}

VOICE-OVER SENTENCES (in final order) with how long each lasts:
${kept.map((x, i) => `${i}. (${(x.e - x.s).toFixed(1)} s) ${x.text}`).join('\n')}

For each sentence choose the video START time (seconds) of the clip to show while it is spoken (the clip lasts as long as the sentence). Rules: match the feature/screen being talked about; generally move forward through the video; avoid showing the same seconds twice unless nothing else fits; start + duration must be ≤ ${videoDur.toFixed(1)}.
Return ONLY JSON: {"starts": [number, ...]} with exactly ${kept.length} numbers.`;
  for await (const a of LLM.attempts({ system: 'You are an expert video editor. You answer with one JSON object.', user, json: true, temperature: 0.1, maxTokens: 3000, timeoutMs: 120000, task: 'editor_match' })) {
    try {
      const j = extractJsonObject(a.text);
      const st = (j.starts || []).map(Number);
      if (st.length !== kept.length || st.some((x: number) => !Number.isFinite(x))) throw new Error('wrong length');
      return st.map((x: number, i: number) => Math.max(0, Math.min(videoDur - Math.min(videoDur, kept[i].e - kept[i].s), x)));
    } catch (e: any) { log(`Match from ${a.provider}/${a.model} unusable (${e?.message}).`); }
  }
  return linear;
}

// ---------------------------------------------------------------------------
// 5. Render
// ---------------------------------------------------------------------------
function frameSize(format: string, w: number, h: number): [number, number] {
  const even = (x: number) => Math.round(x / 2) * 2;
  switch (format) {
    case '9:16': return [1080, 1920];
    case '16:9': return [1920, 1080];
    case '1:1': return [1080, 1080];
    case '4:5': return [1080, 1350];
    default: { const s = Math.min(1, 1920 / Math.max(w, h)); return [even(w * s) || 1920, even(h * s) || 1080]; }
  }
}

async function render(opts: { video: string; audio: string; segs: { a0: number; a1: number; v0: number }[]; W: number; H: number; videoDur: number; out: string }) {
  const { segs, W, H } = opts;
  const parts: string[] = [];
  const pad = (t: number) => Math.max(0, t);
  segs.forEach((g, i) => {
    const d = +(g.a1 - g.a0).toFixed(3);
    const v0 = Math.min(pad(g.v0), Math.max(0, opts.videoDur - 0.05));
    const avail = Math.max(0.04, opts.videoDur - v0);
    // A clip longer than what is left of the video holds its last frame.
    const hold = d > avail ? `,tpad=stop_mode=clone:stop_duration=${(d - avail + 0.05).toFixed(3)}` : '';
    parts.push(`[0:v]trim=start=${v0.toFixed(3)}:duration=${Math.min(d, avail).toFixed(3)},setpts=PTS-STARTPTS${hold},fps=30,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    const fade = Math.min(0.02, d / 4);
    parts.push(`[1:a]atrim=start=${pad(g.a0).toFixed(3)}:end=${g.a1.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fade.toFixed(3)},afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`);
  });
  const n = segs.length;
  parts.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[cv][ca]`);
  // Frame: the picture fitted inside, with a blurred copy filling the rest.
  parts.push(`[cv]split[b][f];[b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.06[bg];[f]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[vout]`);
  // Voice: rumble cut, light denoise, gentle compression, broadcast loudness.
  parts.push(`[ca]highpass=f=80,afftdn=nr=10:nf=-40,acompressor=threshold=-20dB:ratio=3:attack=5:release=120:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9[aout]`);
  const script = path.join(WORK, 'graph.txt');
  fs.writeFileSync(script, parts.join(';\n'));
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', opts.video, '-i', opts.audio, '-filter_complex_script', script, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', opts.out], 3 * 3600_000);
  if (r.code !== 0 || !fs.existsSync(opts.out)) throw new EditError(`FFmpeg could not compile the video: ${r.err.slice(-600)}`);
}

function srt(segs: { a0: number; a1: number }[], kept: Sentence[]): string {
  const ts = (t: number) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const out: string[] = [];
  let t = 0, n = 1;
  kept.forEach((x, i) => {
    const off = t - segs[i].a0;
    // Captions of ≤ 7 words, timed to the words themselves.
    for (let k = 0; k < x.words.length; k += 7) {
      const ws = x.words.slice(k, k + 7).filter((w) => w.s >= segs[i].a0 - 0.05 && w.e <= segs[i].a1 + 0.05);
      if (!ws.length) continue;
      out.push(`${n++}\n${ts(ws[0].s + off)} --> ${ts(ws[ws.length - 1].e + off)}\n${ws.map((w) => w.w).join(' ')}\n`);
    }
    t += segs[i].a1 - segs[i].a0;
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  log(`AI AUTO VIDEO EDITOR — job ${JOB_ID}`);
  await report('running', '1/5 Downloading your files', 8, 'GitHub runner started the edit.');
  const video = path.join(WORK, `source_video${path.extname(CP.files?.video?.name || '.mp4') || '.mp4'}`);
  if (!(await fetchFile(CP.files?.video, video)) && !fs.existsSync(ENV.EDITOR_VIDEO || '')) throw new EditError('No video was provided.');
  if (!fs.existsSync(video) && ENV.EDITOR_VIDEO) fs.copyFileSync(ENV.EDITOR_VIDEO, video);
  let voice = '';
  if (CP.files?.audio) { voice = path.join(WORK, `source_audio${path.extname(CP.files.audio.name || '.m4a') || '.m4a'}`); await fetchFile(CP.files.audio, voice); }
  else if (ENV.EDITOR_AUDIO) voice = ENV.EDITOR_AUDIO;
  const vInfo = await probe(video);
  if (!vInfo.hasVideo) throw new EditError('The video file has no video stream.');
  const separate = !!voice;
  if (!separate) {
    if (!vInfo.hasAudio) throw new EditError('The video has no sound and no voice recording was uploaded.');
    voice = path.join(WORK, 'voice_from_video.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '48000', voice]);
  } else {
    const wav = path.join(WORK, 'voice.wav');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', voice, '-vn', '-ac', '1', '-ar', '48000', wav]);
    voice = wav;
  }
  const aInfo = await probe(voice);
  log(`Video ${vInfo.width}x${vInfo.height}, ${vInfo.duration.toFixed(1)}s; voice ${aInfo.duration.toFixed(1)}s (${separate ? 'separate recording' : 'from the video'}).`);

  await report('running', '2/5 Listening to your voice', 20, 'Transcribing the voice word by word…');
  const words = await transcribe(voice);
  if (words.length < 3) throw new EditError('No speech was found in the recording.');
  const { list, fillers, stutters } = sentences(words);
  log(`${list.length} sentences; removed ${fillers} filler word(s) and ${stutters} stutter(s).`);

  await report('running', '3/5 Editing: keeping the best parts', 38, `Cleaned ${fillers + stutters} filler words/stutters. Deciding what to keep…`);
  const plan = await planEdit(list, String(JOB.instructions || ''));
  const kept = plan.keep.map((id) => list.find((x) => x.id === id)!).filter(Boolean);
  log(`Edit plan (${plan.model}): keeping ${kept.length}/${list.length} sentences. ${plan.removed.slice(0, 6).map((r) => `#${r.id} ${r.reason}`).join('; ')}`);

  // Tighten each kept sentence: small breathing room, never overlapping the next word.
  const segsA = kept.map((x) => {
    const iFirst = words.indexOf(x.words[0]), iLast = words.indexOf(x.words[x.words.length - 1]);
    const before = iFirst > 0 ? words[iFirst - 1].e : 0, after = iLast < words.length - 1 ? words[iLast + 1].s : aInfo.duration;
    return { a0: Math.max(before, x.s - 0.12), a1: Math.min(after, x.e + 0.18) };
  });
  // Inside a sentence, cut out the removed fillers and long pauses too.
  const segs: { a0: number; a1: number; si: number }[] = [];
  segsA.forEach((g, si) => {
    const ws = kept[si].words;
    let start = g.a0;
    for (let k = 1; k < ws.length; k++) {
      const gap = ws[k].s - ws[k - 1].e;
      const skipped = words.slice(words.indexOf(ws[k - 1]) + 1, words.indexOf(ws[k])).length > 0;
      if ((JOB.remove_silences !== 'false' && gap > 0.55) || skipped) {
        segs.push({ a0: start, a1: ws[k - 1].e + 0.1, si });
        start = ws[k].s - 0.08;
      }
    }
    segs.push({ a0: start, a1: g.a1, si });
  });
  const finalDur = segs.reduce((n, g) => n + (g.a1 - g.a0), 0);
  log(`Timeline: ${segs.length} cuts, ${finalDur.toFixed(1)}s (from ${aInfo.duration.toFixed(1)}s — ${(aInfo.duration - finalDur).toFixed(1)}s removed).`);

  await report('running', '4/5 Matching the video to what you say', 55, separate ? 'Watching the video to match each sentence…' : 'Voice and video are in sync — cutting both together.');
  let vStarts: number[];
  if (separate) {
    const frames = await describeFrames(video, vInfo.duration);
    const sentStarts = await matchVideo(kept, frames, vInfo.duration, aInfo.duration);
    // Each sub-cut inside a sentence continues the sentence's matched clip.
    vStarts = segs.map((g) => sentStarts[g.si] + (g.a0 - segsA[g.si].a0));
  } else {
    vStarts = segs.map((g) => g.a0); // same recording: cut picture and sound together
  }

  await report('running', '5/5 Compiling the final video', 72, 'Rendering the final MP4…');
  const [W, H] = frameSize(String(JOB.format || 'auto'), vInfo.width, vInfo.height);
  const out = path.join(WORK, 'edited.mp4');
  await render({ video, audio: voice, segs: segs.map((g, i) => ({ a0: g.a0, a1: g.a1, v0: vStarts[i] })), W, H, videoDur: vInfo.duration, out });
  const oInfo = await probe(out);
  log(`Rendered ${W}x${H}, ${oInfo.duration.toFixed(1)}s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB.`);

  // Captions (SRT) for the kept words, timed to the new timeline.
  const byCut = segs.map((g) => ({ a0: g.a0, a1: g.a1 }));
  const cutSentences = segs.map((g) => ({ ...kept[g.si], words: kept[g.si].words.filter((w) => w.s >= g.a0 - 0.05 && w.e <= g.a1 + 0.05) }));
  const srtFile = path.join(WORK, 'captions.srt');
  fs.writeFileSync(srtFile, srt(byCut, cutSentences as any));

  await report('running', 'Uploading the finished video', 92, 'Uploading…');
  const up = await sendFile(CP.output?.result, out, 'video/mp4');
  let cap: any = null;
  if (JOB.captions !== 'false') cap = await sendFile(CP.output?.captions, srtFile, 'application/x-subrip').catch(() => null);
  const result = { size: up.size, chunks: up.chunks, captions: !!cap, captionsChunks: cap?.chunks, duration: +oInfo.duration.toFixed(2), width: W, height: H,
    originalDuration: +aInfo.duration.toFixed(2), removedSeconds: +(aInfo.duration - finalDur).toFixed(1), fillers, stutters, keptSentences: kept.length, totalSentences: list.length, title: plan.title, planModel: plan.model };
  await report('done', 'Your video is ready', 100, `✅ Done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${result.duration}s video, ${result.removedSeconds}s of filler/pauses/retakes removed.`, { result });
}

main().then(() => process.exit(0)).catch(async (err: any) => {
  const msg = err?.message || String(err);
  console.error(`❌ ${msg}`);
  if (!(err instanceof EditError)) console.error(err?.stack || err);
  await report('failed', 'Failed', 0, `❌ ${msg}`, { error: msg });
  process.exit(1);
});
