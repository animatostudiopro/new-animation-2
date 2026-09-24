/**
 * Publishing to a Facebook Page and its Instagram professional account from
 * the GitHub runner. Pure fetch (Node 22), no SDK.
 *
 *  - Facebook, vertical (Shorts format)  → Page Reel  (video_reels: start → upload → finish/publish)
 *  - Facebook, landscape (regular video) → Page video (graph-video …/videos, multipart upload)
 *  - Instagram                           → Reel (resumable upload to rupload.facebook.com, wait
 *                                          until processed, then media_publish)
 *
 * The Page access token comes from the app (it never lives in the render repo).
 */
import fs from 'node:fs';

export interface SocialCfg { pageId: string; pageToken: string; igUserId?: string; version?: string; log: (m: string) => void }
export class SocialError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const G = (v?: string) => `https://graph.facebook.com/${v || 'v23.0'}`;
const GV = (v?: string) => `https://graph-video.facebook.com/${v || 'v23.0'}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(url: string, init: RequestInit = {}, timeoutMs = 120000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok || data?.error) {
    const e = data?.error || {};
    const msg = `${e.message || `HTTP ${res.status}`}${e.error_user_msg ? ` — ${e.error_user_msg}` : ''}`;
    // 190 = expired / invalid token, 10/200/2xx = missing permission.
    const code = e.code === 190 || e.type === 'OAuthException' && /token|session/i.test(e.message || '') ? 'facebook_auth'
      : [10, 200, 283, 3, 100].includes(Number(e.code)) && /permission|capability|not authorized/i.test(e.message || '') ? 'facebook_auth' : 'facebook_upload';
    throw new SocialError(code, msg.slice(0, 400));
  }
  return data;
}

const clean = (s: string, max: number) => String(s || '').replace(/\s+\n/g, '\n').trim().slice(0, max);

/** Upload one MP4 to a Facebook Page. Returns the public URL. */
export async function publishToFacebook(cfg: SocialCfg, file: string, meta: { title: string; description: string; vertical: boolean }): Promise<{ id: string; url: string }> {
  const bytes = fs.readFileSync(file);
  const qs = (o: Record<string, string>) => new URLSearchParams({ ...o, access_token: cfg.pageToken }).toString();
  if (meta.vertical) {
    // Page Reels: start → binary upload → finish (publish)
    const start = await call(`${G(cfg.version)}/${cfg.pageId}/video_reels?${qs({ upload_phase: 'start' })}`, { method: 'POST' });
    const videoId = String(start.video_id || '');
    const uploadUrl = String(start.upload_url || `https://rupload.facebook.com/video-upload/${cfg.version || 'v23.0'}/${videoId}`);
    if (!videoId) throw new SocialError('facebook_upload', 'Facebook did not return a video id for the Reel.');
    cfg.log(`Facebook: uploading the Reel (${(bytes.length / 1e6).toFixed(1)} MB)…`);
    await call(uploadUrl, { method: 'POST', headers: { Authorization: `OAuth ${cfg.pageToken}`, offset: '0', file_size: String(bytes.length), 'Content-Type': 'application/octet-stream' }, body: bytes }, 600000);
    await call(`${G(cfg.version)}/${cfg.pageId}/video_reels?${qs({ upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: clean(`${meta.title}\n\n${meta.description}`, 2200) })}`, { method: 'POST' });
    // Processing continues on Facebook's side; the Reel goes live when it's done.
    for (let i = 0; i < 30; i++) {
      const st = await call(`${G(cfg.version)}/${videoId}?${qs({ fields: 'status' })}`).catch(() => null);
      const phase = st?.status?.video_status || st?.status?.processing_phase?.status;
      if (phase === 'ready' || st?.status?.publishing_phase?.status === 'complete') break;
      if (phase === 'error') throw new SocialError('facebook_upload', 'Facebook could not process the Reel.');
      await sleep(10000);
    }
    return { id: videoId, url: `https://www.facebook.com/reel/${videoId}` };
  }
  // Regular Page video (landscape)
  cfg.log(`Facebook: uploading the video (${(bytes.length / 1e6).toFixed(1)} MB)…`);
  const form = new FormData();
  form.append('access_token', cfg.pageToken);
  form.append('title', clean(meta.title, 250));
  form.append('description', clean(meta.description, 5000));
  form.append('published', 'true');
  form.append('source', new Blob([bytes], { type: 'video/mp4' }), 'video.mp4');
  const out = await call(`${GV(cfg.version)}/${cfg.pageId}/videos`, { method: 'POST', body: form }, 900000);
  const id = String(out.id || '');
  return { id, url: `https://www.facebook.com/${cfg.pageId}/videos/${id}` };
}

/** Publish one MP4 as an Instagram Reel. Returns the permalink. */
export async function publishToInstagram(cfg: SocialCfg, file: string, meta: { caption: string }): Promise<{ id: string; url: string }> {
  if (!cfg.igUserId) throw new SocialError('instagram_not_linked', 'No Instagram account is linked to this Page.');
  const bytes = fs.readFileSync(file);
  const qs = (o: Record<string, string>) => new URLSearchParams({ ...o, access_token: cfg.pageToken }).toString();
  const container = await call(`${G(cfg.version)}/${cfg.igUserId}/media?${qs({ media_type: 'REELS', upload_type: 'resumable', caption: clean(meta.caption, 2200), share_to_feed: 'true' })}`, { method: 'POST' });
  const id = String(container.id || '');
  const uri = String(container.uri || `https://rupload.facebook.com/ig-api-upload/${cfg.version || 'v23.0'}/${id}`);
  if (!id) throw new SocialError('facebook_upload', 'Instagram did not create a media container.');
  cfg.log(`Instagram: uploading the Reel (${(bytes.length / 1e6).toFixed(1)} MB)…`);
  await call(uri, { method: 'POST', headers: { Authorization: `OAuth ${cfg.pageToken}`, offset: '0', file_size: String(bytes.length) }, body: bytes }, 600000);
  // Wait for Instagram to process the video (usually 20 s – 2 min).
  let status = '';
  for (let i = 0; i < 60; i++) {
    await sleep(i < 6 ? 5000 : 10000);
    const st = await call(`${G(cfg.version)}/${id}?${qs({ fields: 'status_code,status' })}`).catch(() => null);
    status = String(st?.status_code || '');
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new SocialError('facebook_upload', `Instagram could not process the video (${st?.status || status}).`);
  }
  if (status !== 'FINISHED') throw new SocialError('facebook_upload', 'Instagram was still processing the video after 10 minutes.');
  const pub = await call(`${G(cfg.version)}/${cfg.igUserId}/media_publish?${qs({ creation_id: id })}`, { method: 'POST' });
  const mediaId = String(pub.id || '');
  const link = await call(`${G(cfg.version)}/${mediaId}?${qs({ fields: 'permalink' })}`).catch(() => ({}));
  return { id: mediaId, url: String(link.permalink || `https://www.instagram.com/`) };
}
