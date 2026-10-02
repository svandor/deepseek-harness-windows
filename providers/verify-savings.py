#!/usr/bin/env python
"""A tooltip megtakaritas-szamitasanak ellenorzese a valos session-adatokon.

Ugyanazt a logikat futtatja, mint a host `scanUsage` fuggvenye:
  - delegalt session (delegationDepth > 0 vagy origin == "subagent"),
  - costUsd: a tenyleges ar a hasznalt modell szerint,
  - baselineUsd: ugyanaz a fogyasztas deepseek-flash aron,
  - savedUsd = baseline - tenyleges.
"""
import glob
import json
import os
from compression import zstd

ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")

# A host arlistaja (USD / 1M token). A worker (ingyenes) az ismeretlen
# modell agara esik, ami a deepseek-flash arat adja.
PRICES = {
    "deepseek-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-pro": {"miss": 0.435, "hit": 0.003625, "out": 0.87},
    "worker": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "nemotron": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gpt-oss": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "qwen3.8": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gemini": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gemma": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "kimi": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "llama": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "mistral": {"miss": 0.0, "hit": 0.0, "out": 0.0},
}


def prices_for(model):
    low = (model or "").lower()
    for key, p in PRICES.items():
        if key in low:
            return p
    # ismeretlen (pl. worker, nemotron) -> deepseek-flash, ahogy a host teszi
    return PRICES["deepseek-flash"]


def cost(usage, model):
    p = prices_for(model)
    return ((usage.get("inputTokens") or 0) * p["miss"]
            + (usage.get("cacheReadTokens") or 0) * p["hit"]
            + (usage.get("outputTokens") or 0) * p["out"]) / 1_000_000


def model_of(data):
    src = data.get("message", {}).get("source") or data.get("source") or {}
    if isinstance(src, dict) and isinstance(src.get("model"), str):
        return src["model"]
    msg = data.get("message", {})
    if isinstance(msg, dict) and isinstance(msg.get("model"), str):
        return msg["model"]
    return ""


totals = {"requests": 0, "costUsd": 0.0}
deleg = {"requests": 0, "costUsd": 0.0, "baselineUsd": 0.0, "sessions": 0}
per_model = {}

for f in glob.glob(os.path.join(ROOT, "**", "*.jsonl.zstd"), recursive=True):
    try:
        text = zstd.decompress(open(f, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    lines = text.split("\n")
    first = lines[0] if lines else ""
    is_deleg = False
    if '"type":"session"' in first or '"type": "session"' in first:
        try:
            h = json.loads(first)
            is_deleg = (h.get("delegationDepth") or 0) > 0 or h.get("origin") == "subagent"
        except Exception:
            pass
    if is_deleg:
        deleg["sessions"] += 1

    for line in lines:
        if '"assistant/message"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "assistant/message":
            continue
        d = e.get("data") or {}
        u = d.get("usage")
        if not isinstance(u, dict):
            continue
        m = model_of(d)
        c = cost(u, m)
        totals["requests"] += 1
        totals["costUsd"] += c
        per_model[m or "(ismeretlen)"] = per_model.get(m or "(ismeretlen)", 0.0) + c
        if is_deleg:
            deleg["requests"] += 1
            deleg["costUsd"] += c
            deleg["baselineUsd"] += cost(u, "deepseek-flash")

saved = max(0.0, deleg["baselineUsd"] - deleg["costUsd"])
share = deleg["requests"] / totals["requests"] * 100 if totals["requests"] else 0

print("=== AMIT A TOOLTIP MUTATNI FOG ===")
print(f"  Kérések osszesen:        {totals['requests']:,}")
print(f"  Koltseg osszesen:        ${totals['costUsd']:.4f}")
print(f"  Delegalt keres:          {deleg['requests']:,}  ({share:.1f}%)")
print(f"  Delegalt sessionok:      {deleg['sessions']}")
print(f"  Delegalt koltseg:        ${deleg['costUsd']:.4f}")
print(f"  Baseline (flash aron):   ${deleg['baselineUsd']:.4f}")
print(f"  MEGTAKARITAS:            ${saved:.4f}")
print()
print("=== modellenkenti koltseg ===")
for m, c in sorted(per_model.items(), key=lambda kv: -kv[1]):
    print(f"  {m or '(ismeretlen)':<46} ${c:.4f}")

