"""Képkockák kinyerése a forrásvideóból (6:10-6:40) — avatar-alapanyag.

Használat:  python extract_frames.py <video.mp4> <ki-mappa>
"""
import os
import sys

import cv2

TIMES = [370, 375, 380, 385, 390, 395, 400]  # 6:10 … 6:40


def main() -> int:
    video = sys.argv[1]
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print("HIBA: a video nem nyithato meg:", video)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    print(f"fps={fps:.2f} frames={frames:.0f} hossz={(frames / fps if fps else 0):.1f}s")
    for t in TIMES:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            print(f"  {t}s: nincs kepkocka")
            continue
        h, w = frame.shape[:2]
        path = os.path.join(outdir, f"frame-{t:04d}.png")
        cv2.imwrite(path, frame)
        print(f"  {t}s -> {path} ({w}x{h})")
    cap.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
