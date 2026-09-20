#!/usr/bin/env python3
"""
Neural narration for the Animato cloud renderer.

Uses Microsoft Edge's neural voices through the maintained `edge-tts`
package and records WORD-level timings, which drive the karaoke captions,
scene timing and lip-sync gating so everything lines up with the voice.

usage: tts.py --text-file script.txt --voice en-US-AvaMultilingualNeural \
              --rate +0% --out-audio narration.mp3 --out-words words.json
"""
import argparse
import asyncio
import json
import sys

TICKS_PER_SECOND = 10_000_000  # edge-tts offsets are in 100-ns ticks


async def synthesize(text: str, voice: str, rate: str, pitch: str, out_audio: str):
    import edge_tts  # imported here so --help works without the package

    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    except TypeError:
        # Older edge-tts releases have no `boundary` argument (they always emit words).
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)

    words, sentences = [], []
    with open(out_audio, "wb") as audio:
        async for chunk in communicate.stream():
            kind = chunk.get("type")
            if kind == "audio":
                audio.write(chunk["data"])
            elif kind in ("WordBoundary", "SentenceBoundary"):
                item = {
                    "text": chunk.get("text", ""),
                    "start": chunk["offset"] / TICKS_PER_SECOND,
                    "end": (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND,
                }
                (words if kind == "WordBoundary" else sentences).append(item)
    return words, sentences


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--voice", required=True)
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--out-audio", required=True)
    ap.add_argument("--out-words", required=True)
    args = ap.parse_args()

    with open(args.text_file, encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        print("empty text", file=sys.stderr)
        sys.exit(2)

    words, sentences = asyncio.run(synthesize(text, args.voice, args.rate, args.pitch, args.out_audio))
    with open(args.out_words, "w", encoding="utf-8") as f:
        json.dump({"voice": args.voice, "words": words, "sentences": sentences}, f)
    print(f"{args.voice}: {len(words)} word timings, {len(sentences)} sentence timings")


if __name__ == "__main__":
    main()
