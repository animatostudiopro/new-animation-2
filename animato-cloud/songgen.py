#!/usr/bin/env python3
"""Animato song generator — writes a full song (vocals + music) on the GitHub runner's CPU.

Model: ACE-Step 1.5 (MIT licence, https://github.com/ACE-Step/ACE-Step-1.5), the "turbo"
2B diffusion transformer, run WITHOUT its language-model planner (DiT-only mode). The
caption (style + singer + language) and the lyrics go straight to the diffusion model.

Commands
  download   fetch only the checkpoints DiT-only mode needs (turbo DiT, VAE, text encoder)
             into $ACESTEP_CHECKPOINTS_DIR and copy the model code next to them
  generate   compose one song from a JSON job and write <out>/song.mp3 + <out>/meta.json

Job JSON (written by .github/workflows/animato_music.yml from the dispatch inputs):
  {"title": "", "lyrics": "", "style": "afrobeats", "custom_style": "", "singer": "female_pop",
   "language": "en", "duration": 60, "seed": 1234, "out": "output"}

Every progress line starts with "[songgen]" and names the stage, so the run log reads:
  installing -> downloading model -> composing -> encoding mp3 -> done
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MAIN_REPO = "ACE-Step/Ace-Step1.5"
DIT_CONFIG = "acestep-v15-turbo"
# DiT-only mode needs these three folders of the main repo; the 1.7B planner LM is skipped.
NEEDED_COMPONENTS = [DIT_CONFIG, "vae", "Qwen3-Embedding-0.6B"]
SAMPLE_RATE = 48000

MIN_DURATION, MAX_DURATION = 10, 600
MAX_LYRICS = 4000          # ACE-Step accepts up to 4096 characters

# acestep/constants.py VALID_LANGUAGES (+ "unknown" = let the model decide).
LANGUAGE_NAMES = {
    "ar": "Arabic", "az": "Azerbaijani", "bg": "Bulgarian", "bn": "Bengali", "ca": "Catalan",
    "cs": "Czech", "da": "Danish", "de": "German", "el": "Greek", "en": "English",
    "es": "Spanish", "fa": "Persian", "fi": "Finnish", "fr": "French", "he": "Hebrew",
    "hi": "Hindi", "hr": "Croatian", "ht": "Haitian Creole", "hu": "Hungarian", "id": "Indonesian",
    "is": "Icelandic", "it": "Italian", "ja": "Japanese", "ko": "Korean", "la": "Latin",
    "lt": "Lithuanian", "ms": "Malay", "ne": "Nepali", "nl": "Dutch", "no": "Norwegian",
    "pa": "Punjabi", "pl": "Polish", "pt": "Portuguese", "ro": "Romanian", "ru": "Russian",
    "sa": "Sanskrit", "sk": "Slovak", "sr": "Serbian", "sv": "Swedish", "sw": "Swahili",
    "ta": "Tamil", "te": "Telugu", "th": "Thai", "tl": "Tagalog", "tr": "Turkish",
    "uk": "Ukrainian", "ur": "Urdu", "vi": "Vietnamese", "yue": "Cantonese", "zh": "Chinese (Mandarin)",
    "unknown": "",
}
# Languages the model has no code for, sung through the closest supported one.
LANGUAGE_ALIASES = {
    "pcm": ("en", "Nigerian Pidgin English"),
}

# Style presets: caption words + a typical tempo (the tempo helps DiT-only mode a lot).
STYLES = {
    "pop": ("pop, catchy melody, bright synths, punchy drums, radio-ready", 116),
    "afrobeats": ("afrobeats, afropop groove, syncopated percussion, shekere, talking drum, bouncy bass, melodic guitar licks", 104),
    "amapiano": ("amapiano, log drum bass, deep house piano chords, shakers, laid-back south african groove", 113),
    "hiphop": ("hip-hop, boom bap drums, deep bass, sampled keys, head-nodding groove", 92),
    "trap": ("trap, booming 808 bass, rapid hi-hats, dark synth melody, hard-hitting", 140),
    "rnb": ("contemporary r&b, smooth electric piano, lush harmonies, slow sensual groove", 76),
    "gospel": ("gospel, hammond organ, piano, choir harmonies, uplifting worship, hand claps", 82),
    "highlife": ("highlife, west african guitar melodies, brass section, palm-wine groove, joyful", 120),
    "reggae": ("reggae, offbeat skank guitar, one drop drums, warm bass, island vibe", 76),
    "dancehall": ("dancehall, riddim, digital drums, energetic caribbean bounce", 98),
    "rock": ("rock, distorted electric guitars, live drums, driving bass guitar, energetic", 128),
    "edm": ("edm, electronic dance music, festival synth leads, four on the floor kick, big build-up and drop", 126),
    "lofi": ("lo-fi hip hop, mellow jazzy chords, vinyl crackle, relaxed dusty beat", 80),
    "jazz": ("jazz, swing feel, upright bass, brushed drums, piano, saxophone", 120),
    "country": ("country, acoustic guitar, pedal steel, fiddle, heartfelt storytelling", 100),
    "kpop": ("k-pop, polished dance pop, punchy synths, energetic hooks", 124),
    "latin": ("latin pop, reggaeton dembow rhythm, nylon guitar, latin percussion", 95),
    "cinematic": ("cinematic orchestral, epic strings, brass, choir, timpani, film score", 90),
    "acoustic": ("acoustic, unplugged, fingerpicked acoustic guitar, soft piano, intimate, warm room sound", 92),
}
SINGERS = {
    "female_pop": "female vocal, bright pop voice",
    "female_soul": "female vocal, soulful powerful r&b voice, rich runs",
    "female_soft": "female vocal, soft breathy intimate voice, gentle",
    "male_pop": "male vocal, clear pop tenor",
    "male_deep": "male vocal, deep warm baritone",
    "male_rock": "male vocal, raspy gritty rock voice, powerful belting",
    "male_rap": "male rap vocal, rhythmic confident flow",
    "female_rap": "female rap vocal, sharp confident flow",
    "choir": "gospel choir, layered group vocals",
    "duet": "duet, male and female vocals, call and response harmonies",
}

T0 = time.time()


def log(stage, msg=""):
    print(f"[songgen] [{stage}] {msg}".rstrip(), flush=True)


def checkpoints_dir():
    d = os.environ.get("ACESTEP_CHECKPOINTS_DIR") or os.path.join(os.getcwd(), "checkpoints")
    return os.path.abspath(os.path.expanduser(d))


def has_weights(path):
    names = ("model.safetensors", "model.safetensors.index.json", "diffusion_pytorch_model.safetensors",
             "pytorch_model.bin", "diffusion_pytorch_model.bin")
    return os.path.isdir(path) and any(os.path.exists(os.path.join(path, n)) for n in names)


# ---------------------------------------------------------------------------
# download
# ---------------------------------------------------------------------------
def sync_model_code(ckpt):
    """Copy acestep/models/turbo/*.py (except __init__.py) into the DiT checkpoint folder,
    exactly like acestep.model_downloader does after a download."""
    try:
        from acestep.model_downloader import _sync_model_code_files
        from pathlib import Path
        synced = _sync_model_code_files(DIT_CONFIG, Path(ckpt))
        if synced:
            log("downloading model", f"model code synced: {', '.join(synced)}")
            return
    except Exception as err:  # older/newer layout: do it by hand
        log("downloading model", f"built-in code sync unavailable ({err}); copying by hand")
    import acestep
    src = os.path.join(os.path.dirname(acestep.__file__), "models", "turbo")
    dst = os.path.join(ckpt, DIT_CONFIG)
    for name in sorted(os.listdir(src)):
        if name.endswith(".py") and name != "__init__.py":
            shutil.copy2(os.path.join(src, name), os.path.join(dst, name))
            log("downloading model", f"copied {name}")


def cmd_download(_args):
    from huggingface_hub import snapshot_download
    ckpt = checkpoints_dir()
    os.makedirs(ckpt, exist_ok=True)
    missing = [c for c in NEEDED_COMPONENTS if not has_weights(os.path.join(ckpt, c))]
    if missing:
        log("downloading model", f"{MAIN_REPO}: {', '.join(missing)} -> {ckpt} (about 6.3 GB)")
        last = None
        for attempt in range(1, 4):
            try:
                snapshot_download(
                    repo_id=MAIN_REPO,
                    local_dir=ckpt,
                    allow_patterns=[f"{c}/*" for c in NEEDED_COMPONENTS],
                    max_workers=8,
                )
                last = None
                break
            except Exception as err:
                last = err
                log("downloading model", f"attempt {attempt} failed: {err}")
                time.sleep(10 * attempt)
        if last is not None:
            raise SystemExit(f"[songgen] could not download the music model: {last}")
    still = [c for c in NEEDED_COMPONENTS if not has_weights(os.path.join(ckpt, c))]
    if still:
        raise SystemExit(f"[songgen] model download incomplete, missing: {', '.join(still)}")
    if not os.path.exists(os.path.join(ckpt, DIT_CONFIG, "silence_latent.pt")):
        raise SystemExit("[songgen] model download incomplete: silence_latent.pt is missing")
    sync_model_code(ckpt)
    log("downloading model", f"ready in {time.time() - T0:.0f}s")


# ---------------------------------------------------------------------------
# prompt building
# ---------------------------------------------------------------------------
def clean_text(s, n):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


def resolve_language(code):
    code = str(code or "").strip().lower()
    if code in LANGUAGE_ALIASES:
        return LANGUAGE_ALIASES[code]
    if code in LANGUAGE_NAMES:
        return code, LANGUAGE_NAMES[code]
    return "unknown", ""


def build_caption(style, custom_style, singer, language_label, instrumental):
    parts = []
    preset = STYLES.get(style)
    bpm = None
    if preset:
        parts.append(preset[0])
        bpm = preset[1]
    custom = clean_text(custom_style, 300)
    if custom:
        parts.append(custom)
        if not preset:
            bpm = None
    if not parts:
        parts.append(STYLES["pop"][0])
        bpm = STYLES["pop"][1]
    if instrumental:
        parts.append("instrumental, no vocals")
    else:
        parts.append(SINGERS.get(singer, SINGERS["female_pop"]))
        if language_label:
            parts.append(f"sung in {language_label}")
        parts.append("clear expressive lead vocal")
    parts.append("professionally mixed and mastered, high quality")
    # One flat, de-duplicated tag list (custom words often repeat the preset's).
    tags, seen = [], set()
    for part in parts:
        for tag in part.split(","):
            tag = tag.strip()
            if tag and tag.lower() not in seen:
                seen.add(tag.lower())
                tags.append(tag)
    return ", ".join(tags)[:900], bpm


TAG_RE = re.compile(r"^\s*\[[^\]\n]{1,60}\]\s*$")


def _norm(par):
    return re.sub(r"[^\w]+", " ", par.lower()).strip()


def format_lyrics(raw):
    """Return lyrics with [Section] tags. Lyrics that already use tags are kept as written;
    plain text is split into sections (blank lines, else 4 lines each) and labelled:
    repeated sections become the chorus, the others verses (a late one becomes the bridge)."""
    text = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return ""
    lines = [ln.rstrip() for ln in text.split("\n")]
    if any(TAG_RE.match(ln) for ln in lines):
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()[:MAX_LYRICS]

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paragraphs) == 1:
        plain = [ln.strip() for ln in paragraphs[0].split("\n") if ln.strip()]
        if len(plain) > 6:
            paragraphs = ["\n".join(plain[i:i + 4]) for i in range(0, len(plain), 4)]
    keys = [_norm(p) for p in paragraphs]
    counts = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    has_repeat = any(v > 1 for v in counts.values())

    labels = []
    verse = 0
    for i, k in enumerate(keys):
        if has_repeat:
            is_chorus = counts[k] > 1
        else:
            # No repeats: alternate verse / chorus so the song gets a hook.
            is_chorus = len(keys) > 1 and i % 2 == 1
        if is_chorus:
            labels.append("Chorus")
        else:
            verse += 1
            labels.append(f"Verse {verse}" if len(keys) > 1 else "Verse")
    # A late, non-chorus section in a longer song works best as a bridge.
    if len(keys) >= 5:
        for j in range(len(keys) - 2, 1, -1):
            if labels[j].startswith("Verse"):
                labels[j] = "Bridge"
                break
    out = ["[Intro]", ""]
    for label, par in zip(labels, paragraphs):
        out += [f"[{label}]", par, ""]
    out.append("[Outro]")
    return "\n".join(out).strip()[:MAX_LYRICS]


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------
def write_mp3(tensor, sample_rate, out_dir):
    import numpy as np
    import soundfile as sf
    audio = tensor.detach().float().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor, dtype="float32")
    if audio.ndim == 1:
        audio = audio[None, :]
    audio = np.clip(audio, -1.0, 1.0).T          # [samples, channels]
    wav = os.path.join(out_dir, "song.wav")
    mp3 = os.path.join(out_dir, "song.mp3")
    sf.write(wav, audio, int(sample_rate), subtype="PCM_16")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
         "-af", "afade=t=out:st={:.2f}:d=1.5".format(max(0.0, audio.shape[0] / float(sample_rate) - 1.5)),
         "-codec:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", mp3],
        check=True,
    )
    os.remove(wav)
    return mp3, audio.shape[0] / float(sample_rate)


def cmd_generate(args):
    job = json.load(open(args.job, encoding="utf-8"))
    out_dir = job.get("out") or "output"
    os.makedirs(out_dir, exist_ok=True)

    try:
        duration = int(float(job.get("duration") or 60))
    except ValueError:
        duration = 60
    duration = max(MIN_DURATION, min(MAX_DURATION, duration))
    try:
        seed = int(float(job.get("seed") or 0)) % (2 ** 32 - 1)
    except ValueError:
        seed = 1
    style = str(job.get("style") or "pop").strip().lower()
    singer = str(job.get("singer") or "female_pop").strip().lower()
    lang_code, lang_label = resolve_language(job.get("language"))
    lyrics = format_lyrics(job.get("lyrics", ""))
    instrumental = not lyrics
    caption, bpm = build_caption(style, job.get("custom_style", ""), singer, lang_label, instrumental)
    title = clean_text(job.get("title"), 120)

    log("composing", f"title={title!r} style={style} singer={singer} language={lang_code} duration={duration}s seed={seed}")
    log("composing", f"caption: {caption}")
    log("composing", "lyrics:\n" + (lyrics or "[Instrumental]"))

    import torch
    threads = os.cpu_count() or 4
    torch.set_num_threads(threads)
    log("composing", f"torch {torch.__version__}, {threads} CPU threads")

    ckpt = checkpoints_dir()
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = ckpt
    missing = [c for c in NEEDED_COMPONENTS if not has_weights(os.path.join(ckpt, c))]
    if missing:
        raise SystemExit(f"[songgen] model files missing ({', '.join(missing)}); run 'songgen.py download' first")

    # ACE-Step's start-up check also wants the 1.7B planner LM (and would download all
    # 10 GB of the main repo without it). DiT-only mode never loads it, so tell the
    # check the main model is present once the three folders we need are there.
    try:
        from acestep.core.generation.handler import init_service_downloads as _isd
        if hasattr(_isd, "check_main_model_exists"):
            _isd.check_main_model_exists = lambda *_a, **_k: True
    except Exception as err:
        log("composing", f"note: could not skip the planner check ({err}); it may download the LM")

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    t_load = time.time()
    handler = AceStepHandler()
    status, ok = handler.initialize_service(
        project_root=os.path.dirname(ckpt),
        config_path=DIT_CONFIG,
        device="cpu",
        use_flash_attention=False,
        compile_model=False,
        offload_to_cpu=False,
        offload_dit_to_cpu=False,
        quantization=None,
        use_mlx_dit=False,
    )
    log("composing", f"model loaded in {time.time() - t_load:.0f}s: ok={ok}")
    print(status, flush=True)
    if not ok:
        raise SystemExit("[songgen] the music model failed to load (see above)")

    params = GenerationParams(
        task_type="text2music",
        caption=caption,
        lyrics=lyrics or "[Instrumental]",
        instrumental=instrumental,
        vocal_language=lang_code if not instrumental else "unknown",
        bpm=bpm,
        duration=float(duration),
        inference_steps=8,           # turbo default
        shift=3.0,                   # recommended for turbo
        seed=seed,
        # DiT-only: no planner LM, so every chain-of-thought step is off.
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_language=False,
        use_cot_lyrics=False,
    )
    config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[seed], audio_format="flac")

    t_gen = time.time()
    log("composing", f"generating {duration}s of audio (8 diffusion steps)…")
    result = generate_music(handler, None, params, config, save_dir=None)
    gen_seconds = time.time() - t_gen
    if not getattr(result, "success", False) or not result.audios:
        raise SystemExit(f"[songgen] generation failed: {getattr(result, 'error', None) or getattr(result, 'status_message', '')}")
    first = result.audios[0]
    tensor = first.get("tensor")
    if tensor is None:
        raise SystemExit("[songgen] the model returned no audio")
    log("composing", f"composed in {gen_seconds:.0f}s")

    log("encoding mp3")
    mp3, seconds = write_mp3(tensor, first.get("sample_rate", SAMPLE_RATE), out_dir)
    size = os.path.getsize(mp3)
    meta = {
        "title": title,
        "style": style,
        "custom_style": clean_text(job.get("custom_style"), 300),
        "singer": singer,
        "language": lang_code,
        "language_label": lang_label or "auto",
        "instrumental": instrumental,
        "duration": duration,
        "seconds": round(seconds, 2),
        "seed": seed,
        "bpm": bpm,
        "caption": caption,
        "lyrics": lyrics,
        "model": f"ACE-Step 1.5 {DIT_CONFIG} (DiT-only, CPU)",
        "generate_seconds": round(gen_seconds, 1),
        "total_seconds": round(time.time() - T0, 1),
        "bytes": size,
    }
    json.dump(meta, open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log("done", f"{mp3} ({size / 1e6:.1f} MB, {seconds:.0f}s of audio)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("download", help="download the model checkpoints")
    g = sub.add_parser("generate", help="compose one song")
    g.add_argument("--job", required=True, help="job JSON file")
    sub.add_parser("lyrics", help="print how stdin lyrics would be structured (debug)")
    args = ap.parse_args()
    try:
        if args.cmd == "download":
            cmd_download(args)
        elif args.cmd == "generate":
            cmd_generate(args)
        else:
            print(format_lyrics(sys.stdin.read()))
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)


if __name__ == "__main__":
    main()
