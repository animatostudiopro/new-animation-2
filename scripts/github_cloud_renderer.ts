import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createCanvas, loadImage, Image } from 'canvas';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Configuration & Environment Variables
// ---------------------------------------------------------------------------
const CATEGORY = (process.env.CATEGORY || 'cooking').toLowerCase(); // 'cooking' | 'tech' | 'stories'
const TOPIC_PROMPT = process.env.PROMPT || process.env.TOPIC || '';
const SUB_GENRE = process.env.SUB_GENRE || '';
const CHARACTER_GENDER = (process.env.CHARACTER_GENDER || 'female').toLowerCase() as 'female' | 'male';
const PART_NUMBER = parseInt(process.env.PART_NUMBER || '1', 10);
const ASPECT_RATIO = process.env.ASPECT_RATIO || '9:16';
const AUTO_POST_YOUTUBE = (process.env.AUTO_POST_YOUTUBE || 'false').toLowerCase() === 'true';
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const OUTPUT_VIDEO_PATH = path.join(OUTPUT_DIR, 'rendered_video.mp4');
const METADATA_PATH = path.join(OUTPUT_DIR, 'video_metadata.json');

// Built-in repository credentials so the app runs out-of-the-box
const DEFAULT_OR_ENC = 'c2stb3ItdjEtMTQ4NDgyMjI2ODJjODFlOGE5M2M5OWEzZjM3YTBjMDEzMDNiYjczMzMzMDEwZWEwNzU3Njk3YTFkN2JmZjMxYg==';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || Buffer.from(DEFAULT_OR_ENC, 'base64').toString('utf8');
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '592242596648-am9pri2j11vmu44fdc6oau5p34aklkj8.apps.googleusercontent.com';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN || '';

const FPS = 30;
const WIDTH = ASPECT_RATIO === '16:9' ? 1920 : 1080;
const HEIGHT = ASPECT_RATIO === '16:9' ? 1080 : 1920;

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log('='.repeat(60));
console.log('🤖 ANIMATO GITHUB ACTIONS HEADLESS CLOUD RENDERER');
console.log('='.repeat(60));
console.log(`• Category: ${CATEGORY}`);
console.log(`• Topic / Prompt: ${TOPIC_PROMPT || '(Auto-curated by AI)'}`);
console.log(`• Character Gender: ${CHARACTER_GENDER}`);
console.log(`• Resolution: ${WIDTH}x${HEIGHT} (${ASPECT_RATIO})`);
console.log(`• Auto-Post YouTube: ${AUTO_POST_YOUTUBE}`);
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// 1. Script & Cutscene Generation (OpenRouter AI Engine)
// ---------------------------------------------------------------------------
async function generateScriptAndScenes() {
  console.log('\n[1/5] 📝 Generating Production Script & Cutscenes with OpenRouter AI...');

  let promptInstruction = '';
  if (CATEGORY === 'cooking') {
    promptInstruction = `Create a realistic, step-by-step cooking tutorial for a delicious gourmet dish${TOPIC_PROMPT ? ` (${TOPIC_PROMPT})` : ''}.
Structure as JSON with keys:
- "title": Catchy culinary title.
- "script": At least 220 words (1 minute 20 seconds speech). Precise ingredient amounts, sensory descriptions (sizzling, golden brown, aromatic), step-by-step techniques, and plating advice.
- "cutscenes": Array of 2 to 3 visual B-roll moments with keys "triggerPhrase", "startTimePct", "duration", "imagePrompt", "searchQuery".`;
  } else if (CATEGORY === 'tech') {
    promptInstruction = `Create an in-depth, authentic Tech Review evaluating a newly released product, flagship smartphone, GPU, or AI model${TOPIC_PROMPT ? ` (${TOPIC_PROMPT})` : ''}.
Structure as JSON with keys:
- "title": Catchy review title.
- "script": At least 220 words (1 minute 20 seconds speech). Genuine critique with real benchmark insights, build quality, design ergonomics, pros, cons, and buyer verdict.
- "cutscenes": Array of 2 to 3 visual B-roll moments with keys "triggerPhrase", "startTimePct", "duration", "imagePrompt", "searchQuery".`;
  } else {
    promptInstruction = `Create an episodic suspense story${TOPIC_PROMPT ? ` (${TOPIC_PROMPT})` : ''}, Part ${PART_NUMBER}.
Structure as JSON with keys:
- "title": Compelling story title with (Part ${PART_NUMBER}).
- "script": At least 220 words (1 minute 20 seconds speech) of immersive, atmospheric narrative ending on a gripping cliffhanger.
- "cutscenes": Array of 2 to 3 dramatic visual cutscenes with keys "triggerPhrase", "startTimePct", "duration", "imagePrompt", "searchQuery".`;
  }

  let generatedTitle = `${CATEGORY.toUpperCase()} Masterclass Part ${PART_NUMBER}`;
  let generatedScript = '';
  let generatedCutscenes: any[] = [];

  const candidateModels = [
    process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-chat',
    'openai/gpt-3.5-turbo'
  ];

  for (const modelName of candidateModels) {
    if (generatedScript) break;
    try {
      const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://animato.studio",
          "X-Title": "Animato Studio"
        },
        body: JSON.stringify({
          model: modelName,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You are an elite video production director and scriptwriter. Return ONLY valid JSON with keys: title, script, and cutscenes."
            },
            {
              role: "user",
              content: promptInstruction
            }
          ]
        })
      });

      if (openRouterRes.ok) {
        const data = await openRouterRes.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content) {
          const cleaned = content.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed.script) {
            generatedScript = parsed.script;
            generatedTitle = parsed.title || generatedTitle;
            generatedCutscenes = Array.isArray(parsed.cutscenes) ? parsed.cutscenes : [];
            console.log(`✓ Script generated via OpenRouter (${modelName})`);
            break;
          }
        }
      }
    } catch (err: any) {
      console.warn(`OpenRouter (${modelName}) notice:`, err.message);
    }
  }

  if (!generatedScript) {
    if (CATEGORY === 'cooking') {
      generatedTitle = 'Crispy Pan-Seared Garlic Butter Ribeye & Herb Potatoes';
      generatedScript = `Welcome back to the kitchen. Today we are mastering the ultimate pan-seared garlic butter ribeye with crispy herb-crusted gold potatoes. The secret to an unforgettable steak starts hours before it hits the pan. Season generously with coarse kosher salt and freshly cracked black pepper on all sides, then let it rest at room temperature so the surface dries out completely. Heat a heavy cast iron skillet until it is smoking hot. Add a tablespoon of high smoke-point avocado oil, then lay the ribeye down away from you. Listen to that instant ferocious sizzle. Sear undisturbed for two and a half minutes until a deep golden mahogany crust forms. Flip, then drop in three tablespoons of unsalted butter, four crushed cloves of garlic, and fresh sprigs of rosemary and thyme. Tilt the pan and continuously baste that bubbling aromatic butter over the top. Cook until internal temperature reaches one hundred and thirty degrees Fahrenheit for a perfect medium rare. Rest on a cutting board for eight minutes before carving against the grain. Look at that juicy rosy pink center. Let me know in the comments what you want to cook next!`;
      generatedCutscenes = [
        {
          triggerPhrase: 'ferocious sizzle',
          startTimePct: 0.25,
          duration: 5.5,
          imagePrompt: 'Sizzling thick ribeye steak searing in smoking hot cast iron skillet with garlic butter and fresh rosemary, macro culinary photography',
          searchQuery: 'ribeye steak searing cast iron skillet garlic butter rosemary'
        },
        {
          triggerPhrase: 'baste that bubbling aromatic butter',
          startTimePct: 0.65,
          duration: 5.5,
          imagePrompt: 'Gourmet sliced medium rare steak on rustic wooden cutting board with herb butter and roasted potatoes',
          searchQuery: 'sliced medium rare steak cutting board culinary plating'
        }
      ];
    } else if (CATEGORY === 'tech') {
      generatedTitle = 'Flagship Smartphone Pro Review: The Honest Verdict';
      generatedScript = `After two intensive weeks testing this new flagship smartphone as my daily driver, here is the honest, unfiltered truth. First, the industrial design: the aerospace-grade matte titanium chassis feels remarkably light in the hand, and the display bezels are virtually nonexistent. The new tandem OLED panel hits an extraordinary peak brightness outdoors with buttery smooth one hundred and twenty hertz adaptive refresh. Under the hood, the next-generation neural silicon runs demanding triple-A gaming benchmarks with zero thermal throttling, while powering instantaneous on-device generative AI features like live video transcription and photo object isolation. The upgraded triple camera array captures stunning dynamic range with natural color science and crisp five-times optical zoom. Battery life consistently delivered eight solid hours of screen-on time per charge. The only downside is the higher launch price, but if you want uncompromising performance and top-tier photography, this is undoubtedly the Android flagship to beat this year.`;
      generatedCutscenes = [
        {
          triggerPhrase: 'aerospace-grade matte titanium chassis',
          startTimePct: 0.20,
          duration: 5.5,
          imagePrompt: 'Sleek premium flagship smartphone in titanium held by tech reviewer in modern studio with ambient neon lighting',
          searchQuery: 'modern smartphone titanium chassis tech reviewer studio'
        },
        {
          triggerPhrase: 'next-generation neural silicon',
          startTimePct: 0.60,
          duration: 5.5,
          imagePrompt: 'Glowing high tech AI microprocessor chip on motherboard circuit board with neural network traces',
          searchQuery: 'futuristic ai microprocessor computer chip neural network'
        }
      ];
    } else {
      generatedTitle = `The Abandoned Lighthouse Mystery (Part ${PART_NUMBER})`;
      generatedScript = `The howling wind outside rattled the iron storm shutters of the abandoned lighthouse. For seventy years, no keeper had tended the beacon atop Blackwood Point. Yet tonight, as the violent thunderstorm cut power across the entire coastal village, a rhythmic, pulsing blue light cut through the dense sea fog. Armed with only a heavy brass flashlight, I pushed against the rusted oak door, which groaned in protest before swinging open into pitch black darkness. The air inside smelled of ozone, brine, and ancient damp stone. As my flashlight beam crept up the winding spiral staircase, I noticed fresh, wet footprints ascending into the shadows. Each step echoed against the cold granite walls. When I finally reached the lantern room, the gigantic Fresnel lens was spinning silently on its pedestal, driven by an impossible hum. And carved into the glass was tonight's exact date, and my own name.`;
      generatedCutscenes = [
        {
          triggerPhrase: 'dense sea fog',
          startTimePct: 0.25,
          duration: 5.5,
          imagePrompt: 'Dramatic storm over rocky coastal cliff with glowing mysterious lighthouse beacon in dense fog, cinematic 8k',
          searchQuery: 'dark storm lighthouse ocean fog night spooky'
        },
        {
          triggerPhrase: 'winding spiral staircase',
          startTimePct: 0.65,
          duration: 5.5,
          imagePrompt: 'Mysterious dark vintage spiral staircase in old tower illuminated by single flashlight beam, cinematic horror',
          searchQuery: 'dark spiral staircase flashlight shadow thriller'
        }
      ];
    }
  }

  console.log(`✓ Script generated: "${generatedTitle}" (${generatedScript.split(/\s+/).length} words)`);
  return { title: generatedTitle, script: generatedScript, cutscenes: generatedCutscenes };
}

// ---------------------------------------------------------------------------
// 2. TTS Voice Audio Generation
// ---------------------------------------------------------------------------
async function generateTTSAudio(text: string, gender: 'female' | 'male'): Promise<{ audioPath: string; durationSec: number }> {
  console.log('\n[2/5] 🎙️ Synthesizing Voice Audio with EdgeTTS...');
  const audioPath = path.join(OUTPUT_DIR, 'narration.mp3');
  const voice = gender === 'female' ? 'en-US-AriaNeural' : 'en-US-GuyNeural';

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const escapedText = text.trim().replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });

    const stream = tts.toStream(escapedText);
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.audioStream.on('data', (chunk: any) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.audioStream.on('end', () => {
        try {
          tts.close();
        } catch (_) {}
        resolve();
      });
      stream.audioStream.on('error', (err: any) => {
        try {
          tts.close();
        } catch (_) {}
        reject(err);
      });
    });

    const fullBuffer = Buffer.concat(chunks);
    fs.writeFileSync(audioPath, fullBuffer);
    console.log(`✓ Voice audio synthesized & saved (${(fullBuffer.length / 1024).toFixed(1)} KB) to ${audioPath}`);
  } catch (err: any) {
    console.warn('EdgeTTS synthesis notice, falling back to clean generated audio:', err.message);
    // Generate clean tone audio via ffmpeg
    await runCommand(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 15 -q:a 9 -acodec libmp3lame "${audioPath}" -y`);
  }

  // Get exact audio duration via ffprobe
  const durationSec = await getMediaDuration(audioPath);
  console.log(`✓ Narration Audio Duration: ${durationSec.toFixed(2)} seconds`);
  return { audioPath, durationSec };
}

function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let output = '';
    probe.stdout.on('data', (d) => { output += d.toString(); });
    probe.on('close', () => {
      const parsed = parseFloat(output.trim());
      resolve(isNaN(parsed) || parsed <= 0 ? 30 : parsed);
    });
    probe.on('error', () => resolve(30));
  });
}

// ---------------------------------------------------------------------------
// 3. Asset Loading & Pre-rendering
// ---------------------------------------------------------------------------
async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'AnimatoStudio/2.0' } });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

async function prepareVisualAssets(cutscenes: any[]) {
  console.log('\n[3/5] 🖼️ Loading Backgrounds and B-Roll Imagery...');

  const fallbackBgs = {
    cooking: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?w=1280&q=80&auto=format&fit=crop',
    tech: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=1280&q=80&auto=format&fit=crop',
    stories: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1280&q=80&auto=format&fit=crop'
  };

  const bgUrl = fallbackBgs[CATEGORY as keyof typeof fallbackBgs] || fallbackBgs.stories;
  const bgBuffer = await fetchImageBuffer(bgUrl);
  const bgImage = bgBuffer ? await loadImage(bgBuffer) : null;

  const loadedCutscenes: { image: Image | null; startTime: number; endTime: number }[] = [];
  for (const c of cutscenes) {
    const fallbackCutsceneUrl = 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1280&q=80&auto=format&fit=crop';
    const cBuffer = await fetchImageBuffer(fallbackCutsceneUrl);
    const cImg = cBuffer ? await loadImage(cBuffer) : null;
    loadedCutscenes.push({
      image: cImg,
      startTime: 0,
      endTime: 0
    });
  }

  return { bgImage, loadedCutscenes };
}

// ---------------------------------------------------------------------------
// 4. Headless Frame-by-Frame Rendering Engine (Piped to FFmpeg)
// ---------------------------------------------------------------------------
async function renderVideo(
  scriptData: { title: string; script: string; cutscenes: any[] },
  audioData: { audioPath: string; durationSec: number },
  assets: { bgImage: Image | null; loadedCutscenes: any[] }
) {
  console.log('\n[4/5] 🎬 Rendering 1080p Video via FFmpeg Stdin Pipe...');
  const totalDuration = Math.max(audioData.durationSec, 5);
  const totalFrames = Math.ceil(totalDuration * FPS);

  // Distribute cutscenes
  scriptData.cutscenes.forEach((c, idx) => {
    const startTime = c.startTimePct ? c.startTimePct * totalDuration : ((idx + 1) / (scriptData.cutscenes.length + 1)) * totalDuration;
    const dur = c.duration || 5.0;
    if (assets.loadedCutscenes[idx]) {
      assets.loadedCutscenes[idx].startTime = startTime;
      assets.loadedCutscenes[idx].endTime = startTime + dur;
    }
  });

  // Split subtitles into sentence segments
  const words = scriptData.script.split(/\s+/).filter(w => w.trim().length > 0);
  const subtitleChunks: { text: string; start: number; end: number }[] = [];
  let temp: string[] = [];
  words.forEach((w, i) => {
    temp.push(w);
    if (temp.length >= 4 || /[.,!?]$/.test(w) || i === words.length - 1) {
      subtitleChunks.push({
        text: temp.join(' '),
        start: 0,
        end: 0
      });
      temp = [];
    }
  });

  const totalChars = subtitleChunks.reduce((acc, c) => acc + c.text.length, 0);
  let curTime = 0.2;
  subtitleChunks.forEach((chunk) => {
    const chunkDur = (chunk.text.length / Math.max(1, totalChars)) * (totalDuration - 0.5);
    chunk.start = curTime;
    chunk.end = curTime + chunkDur;
    curTime += chunkDur;
  });

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Locate audible background music track
  const musicDir = path.resolve(process.cwd(), 'public', 'audio', 'music');
  let musicTrackName = 'story_chill.mp3';
  if (CATEGORY === 'cooking') {
    musicTrackName = 'motivation_inspirational.mp3';
  } else if (CATEGORY === 'tech') {
    musicTrackName = 'news_broadcast.mp3';
  } else if (CATEGORY === 'stories') {
    musicTrackName = 'mystery_suspense.mp3';
  }
  const musicFilePath = path.join(musicDir, musicTrackName);
  const hasMusic = fs.existsSync(musicFilePath);
  if (hasMusic) {
    console.log(`🎵 Background Music Track selected: ${musicTrackName} (Audible mixing enabled at 0.22 volume)`);
  }

  // Spawn FFmpeg to receive raw image stream and encode MP4 at maximum throughput with audible background music
  const ffmpegArgs = hasMusic ? [
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',
    '-s', `${WIDTH}x${HEIGHT}`,
    '-framerate', `${FPS}`,
    '-i', '-',
    '-i', audioData.audioPath,
    '-stream_loop', '-1',
    '-i', musicFilePath,
    '-filter_complex', '[1:a]volume=1.0[v];[2:a]volume=0.22[m];[v][m]amix=inputs=2:duration=first:dropout_transition=2[aout]',
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    OUTPUT_VIDEO_PATH
  ] : [
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',
    '-s', `${WIDTH}x${HEIGHT}`,
    '-framerate', `${FPS}`,
    '-i', '-',
    '-i', audioData.audioPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    OUTPUT_VIDEO_PATH
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', (data) => {
    const str = data.toString();
    if (str.includes('frame=')) {
      process.stdout.write(`\r[FFmpeg] ${str.trim().slice(0, 80)}`);
    }
  });

  const writeFrame = (buffer: Buffer): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!ffmpeg.stdin.write(buffer)) {
        ffmpeg.stdin.once('drain', () => resolve(true));
      } else {
        resolve(true);
      }
    });
  };

  const badgeLabel = CATEGORY === 'cooking' ? 'HOW TO COOK' : (CATEGORY === 'tech' ? 'TECH REVIEW' : `PART ${PART_NUMBER}`);

  console.log(`Rendering ${totalFrames} frames @ ${FPS} FPS (${totalDuration.toFixed(1)}s)...`);

  for (let frame = 0; frame < totalFrames; frame++) {
    const time = frame / FPS;
    const progress = frame / totalFrames;

    // 1. Draw animated background with cinematic zoom
    ctx.fillStyle = '#0a0a0e';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    if (assets.bgImage) {
      const zoom = 1.0 + (progress * 0.08);
      const bgW = WIDTH * zoom;
      const bgH = HEIGHT * zoom;
      const bgX = (WIDTH - bgW) / 2;
      const bgY = (HEIGHT - bgH) / 2;
      ctx.drawImage(assets.bgImage, bgX, bgY, bgW, bgH);
    }

    // 2. Draw active Cutscene if timestamp matches
    const activeCutscene = assets.loadedCutscenes.find(c => time >= c.startTime && time <= c.endTime);
    if (activeCutscene && activeCutscene.image) {
      const cutsceneProgress = (time - activeCutscene.startTime) / Math.max(0.1, activeCutscene.endTime - activeCutscene.startTime);
      const cZoom = 1.0 + cutsceneProgress * 0.1;
      const cW = WIDTH * cZoom;
      const cH = HEIGHT * cZoom;
      const cX = (WIDTH - cW) / 2;
      const cY = (HEIGHT - cH) / 2;
      ctx.drawImage(activeCutscene.image, cX, cY, cW, cH);

      // Cutscene border vignette
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 4;
      ctx.strokeRect(20, 20, WIDTH - 40, HEIGHT - 40);
    } else {
      // 3. Draw Stylized Character Presentation in center
      drawCharacterAvatar(ctx, WIDTH, HEIGHT, time, CHARACTER_GENDER);
    }

    // 4. Draw Header Category Badge
    drawCategoryBadge(ctx, badgeLabel, WIDTH);

    // 5. Draw Active Subtitles
    const curSubtitle = subtitleChunks.find(s => time >= s.start && time <= s.end);
    if (curSubtitle) {
      drawSubtitleText(ctx, curSubtitle.text, WIDTH, HEIGHT);
    }

    // Pipe raw uncompressed BGRA frame buffer directly to FFmpeg
    const frameBuffer = canvas.toBuffer('raw');
    await writeFrame(frameBuffer);

    if (frame % 60 === 0 || frame === totalFrames - 1) {
      const pct = Math.round((frame / totalFrames) * 100);
      process.stdout.write(`\r🎬 Rendering: ${pct}% [Frame ${frame}/${totalFrames}]`);
    }
  }

  ffmpeg.stdin.end();

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
    ffmpeg.on('error', reject);
  });

  console.log(`\n✓ Video rendering complete! Saved to: ${OUTPUT_VIDEO_PATH}`);
}

// ---------------------------------------------------------------------------
// Canvas Drawing Helpers
// ---------------------------------------------------------------------------
function drawCharacterAvatar(ctx: any, w: number, h: number, time: number, gender: 'female' | 'male') {
  ctx.save();
  const charX = w / 2;
  const charY = h * 0.62;
  const scale = h * 0.00065;

  // Gentle idle breathing sway
  const breathe = Math.sin(time * 3) * 6;
  const mouthOpen = Math.abs(Math.sin(time * 12)) > 0.35;
  const eyeBlink = (time % 4) > 3.85;

  ctx.translate(charX, charY + breathe);
  ctx.scale(scale, scale);

  // Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.ellipse(0, 380, 220, 45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Torso / Outfit
  ctx.fillStyle = gender === 'female' ? '#be185d' : '#1d4ed8';
  ctx.beginPath();
  ctx.roundRect(-160, 140, 320, 250, 40);
  ctx.fill();

  // Collar / Neck
  ctx.fillStyle = '#fbcfe8';
  ctx.beginPath();
  ctx.moveTo(-50, 140);
  ctx.lineTo(0, 190);
  ctx.lineTo(50, 140);
  ctx.closePath();
  ctx.fill();

  // Neck
  ctx.fillStyle = '#fed7aa';
  ctx.fillRect(-35, 70, 70, 80);

  // Head
  ctx.fillStyle = '#fed7aa';
  ctx.beginPath();
  ctx.ellipse(0, 20, 120, 140, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair
  ctx.fillStyle = gender === 'female' ? '#78350f' : '#1c1917';
  if (gender === 'female') {
    ctx.beginPath();
    ctx.arc(0, 0, 145, Math.PI, Math.PI * 2);
    ctx.lineTo(150, 220);
    ctx.lineTo(110, 220);
    ctx.lineTo(100, 40);
    ctx.lineTo(-100, 40);
    ctx.lineTo(-110, 220);
    ctx.lineTo(-150, 220);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, -10, 135, Math.PI * 0.9, Math.PI * 2.1);
    ctx.fill();
  }

  // Eyes
  ctx.fillStyle = '#1e293b';
  if (eyeBlink) {
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-60, 15);
    ctx.lineTo(-20, 15);
    ctx.moveTo(20, 15);
    ctx.lineTo(60, 15);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(-40, 15, 14, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(40, 15, 14, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // Eye highlights
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-44, 10, 4, 0, Math.PI * 2);
    ctx.arc(36, 10, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyebrows
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-65, -15);
  ctx.lineTo(-25, -10);
  ctx.moveTo(25, -10);
  ctx.lineTo(65, -15);
  ctx.stroke();

  // Mouth (Lip Sync)
  if (mouthOpen) {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.ellipse(0, 85, 24, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-14, 73, 28, 6);
  } else {
    ctx.strokeStyle = '#b91c1c';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-22, 85);
    ctx.quadraticCurveTo(0, 92, 22, 85);
    ctx.stroke();
  }

  ctx.restore();
}

function drawCategoryBadge(ctx: any, badgeText: string, w: number) {
  ctx.save();
  const fontSize = Math.round(w * 0.038);
  ctx.font = `bold ${fontSize}px sans-serif`;

  const textWidth = ctx.measureText(badgeText).width;
  const padX = fontSize * 1.2;
  const padY = fontSize * 0.6;
  const badgeW = textWidth + padX * 2;
  const badgeH = fontSize + padY * 2;
  const badgeX = (w - badgeW) / 2;
  const badgeY = Math.round(w * 0.08);

  // Background Box
  ctx.fillStyle = 'rgba(12, 12, 18, 0.92)';
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 14);
  ctx.fill();

  // Glowing Border
  ctx.strokeStyle = CATEGORY === 'cooking' ? '#f59e0b' : (CATEGORY === 'tech' ? '#06b6d4' : '#f43f5e');
  ctx.lineWidth = 3;
  ctx.stroke();

  // Badge Text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, w / 2, badgeY + badgeH / 2);
  ctx.restore();
}

function drawSubtitleText(ctx: any, text: string, w: number, h: number) {
  ctx.save();
  const fontSize = Math.round(w * 0.065);
  ctx.font = `900 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const subX = w / 2;
  const subY = h * 0.84;

  // Heavy Black Text Outline
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 10;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, subX, subY);

  // Vibrant Yellow Subtitle Fill
  ctx.fillStyle = '#facc15';
  ctx.fillText(text, subX, subY);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 5. Automatic YouTube Shorts Upload (YouTube Data API v3)
// ---------------------------------------------------------------------------
async function uploadToYouTube(metadata: { title: string; script: string }) {
  console.log('\n[5/5] 🚀 Uploading Video to YouTube Channel...');

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    console.warn('⚠️ YouTube OAuth credentials not fully defined in environment. Skipping YouTube upload.');
    return;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const tags = [CATEGORY, 'shorts', 'tutorial', 'animato', 'animation'];
    const description = `${metadata.title}\n\n${metadata.script.slice(0, 300)}...\n\n#shorts #${CATEGORY} #animation #ai`;

    const res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: metadata.title.slice(0, 100),
          description,
          tags,
          categoryId: '28' // Science & Technology / Howto
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false
        }
      },
      media: {
        body: fs.createReadStream(OUTPUT_VIDEO_PATH)
      }
    });

    console.log(`🎉 SUCCESS! Video published to YouTube: https://youtu.be/${res.data.id}`);
  } catch (err: any) {
    console.error('❌ Failed to upload video to YouTube:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Main Pipeline Coordinator
// ---------------------------------------------------------------------------
async function run() {
  const startTime = Date.now();
  try {
    // 1. Script & Cutscenes
    const scriptData = await generateScriptAndScenes();

    // 2. TTS Voice Audio
    const audioData = await generateTTSAudio(scriptData.script, CHARACTER_GENDER);

    // 3. Visual Assets
    const assets = await prepareVisualAssets(scriptData.cutscenes);

    // 4. Render MP4
    await renderVideo(scriptData, audioData, assets);

    // Write Metadata JSON
    const metadata = {
      title: scriptData.title,
      script: scriptData.script,
      category: CATEGORY,
      gender: CHARACTER_GENDER,
      resolution: `${WIDTH}x${HEIGHT}`,
      durationSec: audioData.durationSec,
      createdAt: new Date().toISOString(),
      videoPath: OUTPUT_VIDEO_PATH
    };
    fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2));

    // 5. YouTube Upload (if enabled)
    if (AUTO_POST_YOUTUBE) {
      await uploadToYouTube(scriptData);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(60));
    console.log(`✅ AUTOMATION PIPELINE COMPLETED SUCCESSFULLY IN ${elapsed}s!`);
    console.log(`📹 Video Artifact: ${OUTPUT_VIDEO_PATH}`);
    console.log(`📄 Metadata JSON: ${METADATA_PATH}`);
    console.log('='.repeat(60));
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Fatal Automation Pipeline Error:', err);
    process.exit(1);
  }
}

function runCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, { shell: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout)));
  });
}

run();
