#!/usr/bin/env python3
"""Animato image generator — runs on the GitHub runner's CPU, no API keys.

Model: rupeshs/sdxs-512-0.9-orig-vae (1-step distilled Stable Diffusion, 512px).
Pipeline per image:  fit the prompt to the text encoder -> 1-step generation at
the target aspect ratio -> detail upscale (Real-ESRGAN anime-video model when
available, otherwise a Lanczos resize) -> light sharpen -> exact output size.

Modes
  serve   long-running local HTTP server (the video renderer uses this; the model
          is loaded ONCE and every scene is drawn by the same process)
  batch   draw a JSON list of jobs and exit (used by the image workflow)

Every optional stage fails safe: if the upscaler is unavailable or slow the image
is still produced with a plain high-quality resize.
"""
import argparse
import json
import os
import sys
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_ID = os.environ.get("IMAGEGEN_MODEL", "rupeshs/sdxs-512-0.9-orig-vae")
BASE_AREA = 512 * 512
MAX_TOKENS = 77
UPSCALER_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth"
UPSCALER_FILE = "realesr-animevideov3.pth"
# If one AI upscale takes longer than this, switch to the plain resize for the rest of the run.
MAX_UPSCALE_SECONDS = float(os.environ.get("IMAGEGEN_MAX_UPSCALE_SECONDS", "25"))

STATE = {"ready": False, "error": "", "upscaler": "lanczos", "count": 0, "load_seconds": 0.0}
LOCK = threading.Lock()
PIPE = None
UPSCALER = None


def log(msg):
    print(f"[imagegen] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Upscaler (optional)
# ---------------------------------------------------------------------------
class Upscaler:
    def __init__(self):
        self.model = None
        self.ok = False
        self.name = "lanczos"
        mode = os.environ.get("IMAGEGEN_UPSCALER", "auto").strip().lower()
        if mode in ("off", "none", "lanczos", "0", "false"):
            return
        try:
            self._load()
        except Exception as err:  # never block image generation
            log(f"AI upscaler unavailable, using the plain resize ({str(err)[:160]})")

    def _weights(self):
        cache = os.path.expanduser(os.environ.get("IMAGEGEN_CACHE", "~/.cache/animato-imagegen"))
        os.makedirs(cache, exist_ok=True)
        path = os.path.join(cache, UPSCALER_FILE)
        if os.path.exists(path) and os.path.getsize(path) > 500_000:
            return path
        last = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(UPSCALER_URL, headers={"User-Agent": "AnimatoImagegen/1.0"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                if len(data) < 500_000:
                    raise RuntimeError("download too small")
                tmp = path + ".part"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, path)
                return path
            except Exception as err:
                last = err
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"could not download the upscaler weights ({last})")

    def _load(self):
        from spandrel import ImageModelDescriptor, ModelLoader

        model = ModelLoader().load_from_file(self._weights())
        if not isinstance(model, ImageModelDescriptor):
            raise RuntimeError("unexpected upscaler model type")
        model.cpu().eval()
        self.model = model
        self.ok = True
        self.name = "realesr-animevideov3"

    def run(self, img):
        """Returns the upscaled PIL image, or None when the upscaler is off / failed."""
        if not self.ok:
            return None
        try:
            import numpy as np
            import torch
            from PIL import Image

            t0 = time.time()
            arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
            x = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).contiguous()
            with torch.inference_mode():
                y = self.model(x)
            y = y.squeeze(0).clamp(0, 1).permute(1, 2, 0).mul(255.0).round().byte().numpy()
            out = Image.fromarray(y)
            took = time.time() - t0
            if took > MAX_UPSCALE_SECONDS:
                self.ok = False
                STATE["upscaler"] = "lanczos"
                log(f"AI upscale took {took:.0f}s — switching to the plain resize for the rest of this run")
            return out
        except Exception as err:
            self.ok = False
            STATE["upscaler"] = "lanczos"
            log(f"AI upscale failed, using the plain resize ({str(err)[:160]})")
            return None


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
def load_pipeline():
    import torch

    threads = int(os.environ.get("IMAGEGEN_THREADS") or os.cpu_count() or 2)
    torch.set_num_threads(max(1, threads))
    t0 = time.time()
    try:
        from diffusers import AutoPipelineForText2Image

        pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=torch.float32)
    except Exception as err:
        log(f"AutoPipeline load failed ({str(err)[:120]}), trying StableDiffusionPipeline")
        from diffusers import StableDiffusionPipeline

        pipe = StableDiffusionPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.float32)
    pipe.set_progress_bar_config(disable=True)
    pipe.to("cpu")
    # Warm-up: the first call is always slower (kernel setup); pay for it before the first scene.
    try:
        with torch.inference_mode():
            pipe(prompt="warm up", num_inference_steps=1, guidance_scale=0.0, width=256, height=256)
    except Exception as err:
        log(f"warm-up skipped ({str(err)[:120]})")
    STATE["load_seconds"] = round(time.time() - t0, 1)
    log(f"model ready in {STATE['load_seconds']}s")
    return pipe


def native_size(width, height):
    """Generation size: ~512x512 worth of pixels at the target aspect ratio (multiples of 8)."""
    if os.environ.get("IMAGEGEN_SQUARE") == "1":
        return 512, 512
    ar = max(0.4, min(2.5, width / float(height)))
    gh = int(round(((BASE_AREA / ar) ** 0.5) / 8.0)) * 8
    gw = int(round(gh * ar / 8.0)) * 8
    return max(256, min(768, gw)), max(256, min(768, gh))


def fit_prompt(pipe, style, prompt):
    """The text encoder only reads 77 tokens: keep the style prefix whole and trim the scene to fit."""
    style = (style or "").strip().strip(",")
    prompt = " ".join((prompt or "").split())
    try:
        tok = pipe.tokenizer
        style_ids = tok(style, add_special_tokens=False).input_ids if style else []
        budget = MAX_TOKENS - 2 - len(style_ids) - 1
        ids = tok(prompt, add_special_tokens=False).input_ids[: max(budget, 8)]
        scene = tok.decode(ids, skip_special_tokens=True).strip()
    except Exception:
        scene = prompt[:240]
    return f"{style}, {scene}".strip(", ") if style else scene


def is_blank(img):
    from PIL import ImageStat

    stat = ImageStat.Stat(img.convert("L").resize((64, 64)))
    return stat.stddev[0] < 3.0


def finish(img, width, height):
    """Upscale, fit to the exact size and sharpen."""
    from PIL import Image, ImageEnhance, ImageFilter

    ai = UPSCALER.run(img) if UPSCALER is not None else None
    if ai is not None:
        img = ai
    # Cover-fit to the exact target size (the aspect ratio already matches, so little is cropped).
    scale = max(width / img.width, height / img.height)
    nw, nh = max(width, round(img.width * scale)), max(height, round(img.height * scale))
    img = img.convert("RGB").resize((nw, nh), Image.LANCZOS)
    left, top = (nw - width) // 2, (nh - height) // 2
    img = img.crop((left, top, left + width, top + height))
    img = img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=45 if ai is not None else 85, threshold=2))
    return ImageEnhance.Color(img).enhance(1.05)


def generate(job):
    import torch

    width = int(job.get("width") or 1152)
    height = int(job.get("height") or 1152)
    out = job["out"]
    seed = int(job.get("seed") or 0) % (2**32)
    prompt = fit_prompt(PIPE, job.get("style", ""), job.get("prompt", ""))
    gw, gh = native_size(width, height)
    t0 = time.time()
    img = None
    for attempt in range(2):  # a black/flat frame is retried once with a new seed
        gen = torch.Generator("cpu").manual_seed((seed + attempt * 7919) % (2**32))
        with LOCK, torch.inference_mode():
            img = PIPE(prompt=prompt, num_inference_steps=1, guidance_scale=0.0, width=gw, height=gh, generator=gen).images[0]
        if not is_blank(img):
            break
    t1 = time.time()
    with LOCK:  # the upscaler shares the CPU with the model: one job at a time
        final = finish(img, width, height)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    final.save(out, "PNG", compress_level=1)
    STATE["count"] += 1
    log(f"image {STATE['count']}: {gw}x{gh} in {t1 - t0:.1f}s, finished {width}x{height} in {time.time() - t1:.1f}s ({STATE['upscaler']})")
    return {"ok": True, "file": out, "width": width, "height": height, "seconds": round(time.time() - t0, 1)}


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the job log quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, dict(STATE))
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/generate"):
            return self._send(404, {"error": "not found"})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            job = json.loads(self.rfile.read(size) or b"{}")
            if not job.get("out") or not job.get("prompt"):
                return self._send(400, {"ok": False, "error": "prompt and out are required"})
            if STATE["error"]:
                return self._send(500, {"ok": False, "error": STATE["error"]})
            if not STATE["ready"]:
                return self._send(503, {"ok": False, "error": "model still loading"})
            self._send(200, generate(job))
        except Exception as err:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(err)[:300]})


def init_models():
    global PIPE, UPSCALER
    try:
        PIPE = load_pipeline()
        UPSCALER = Upscaler()
        STATE["upscaler"] = UPSCALER.name
        log(f"upscaler: {UPSCALER.name}")
        STATE["ready"] = True
    except Exception as err:
        traceback.print_exc()
        STATE["error"] = f"model failed to load: {str(err)[:240]}"


def cmd_serve(args):
    threading.Thread(target=init_models, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on 127.0.0.1:{args.port}")
    server.serve_forever()


def cmd_batch(args):
    init_models()
    if STATE["error"]:
        log(STATE["error"])
        return 1
    with open(args.jobs, "r", encoding="utf-8") as f:
        jobs = json.load(f)
    if isinstance(jobs, dict):
        jobs = [jobs]
    failed = 0
    for job in jobs:
        try:
            generate(job)
        except Exception as err:
            failed += 1
            log(f"job failed: {str(err)[:200]}")
    return 1 if failed == len(jobs) else 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8012)
    b = sub.add_parser("batch")
    b.add_argument("--jobs", required=True, help="JSON file: one job or a list of {prompt, style, seed, width, height, out}")
    args = parser.parse_args()
    if args.cmd == "serve":
        cmd_serve(args)
        return 0
    return cmd_batch(args)


if __name__ == "__main__":
    sys.exit(main())
