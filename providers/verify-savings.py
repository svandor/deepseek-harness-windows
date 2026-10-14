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

# A host arlistaja tukre (USD / 1M token, lapos = peak korul is). 2026-10-14:
# provider-elotagges kulcsok (a session-log source.provider alapjan), es a
# korabbi "qwen3.8"substring-csapda szukul "qwen3.8-27b"-re.
PRICES = {
    "deepseek-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-pro": {"miss": 0.435, "hit": 0.003625, "out": 0.87},
    # Alibaba EU (Frankfurt) — lapos listaar [D 2026-10-13]
    "alibaba/qwen3.8-flash": {"miss": 0.113, "hit": 0.0113, "out": 0.382},
    "alibaba/qwen3.8-max": {"miss": 1.65, "hit": 0.165, "out": 4.951},
    "alibaba/qwen3.7-plus": {"miss": 0.276, "hit": 0.0276, "out": 1.101},
    "alibaba/qwen3.7-flash": {"miss": 0.028, "hit": 0.0028, "out": 0.11},
    "alibaba/qwen3-coder": {"miss": 0.144, "hit": 0.0144, "out": 0.574},
    "alibaba/": {"miss": 0.113, "hit": 0.0113, "out": 0.382},
    # Alibaba SZINGAPUR (International) — az elso 1M token/modell ingyenes
    "alibaba-intl/qwen3.8-flash": {"miss": 0.15, "hit": 0.015, "out": 0.47},
    "alibaba-intl/qwen3.8-max": {"miss": 2.0, "hit": 0.2, "out": 6.0},
    "alibaba-intl/qwen3.7-plus": {"miss": 0.4, "hit": 0.04, "out": 1.6},
    "alibaba-intl/qwen3.7-flash": {"miss": 0.03, "hit": 0.003, "out": 0.13},
    "alibaba-intl/qwen3-coder": {"miss": 0.3, "hit": 0.03, "out": 1.5},
    "alibaba-intl/": {"miss": 0.15, "hit": 0.015, "out": 0.47},
    "worker": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "nemotron": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gpt-oss": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "qwen3.8-27b": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gemini": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "gemma": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "kimi": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "llama": {"miss": 0.0, "hit": 0.0, "out": 0.0},
    "mistral": {"miss": 0.0, "hit": 0.0, "out": 0.0},
}

# A szingapuri ingyenes keret (host: SG_FREE_TOKENS_PER_MODEL) — modellenkent.
SG_FREE_TOKENS_PER_MODEL = 1_000_000


def family_of(model):
    m = (model or "").lower()
    if m.startswith("alibaba-intl/"):
        return "alibabaSg"
    if m.startswith("alibaba/") or m.startswith("alibaba-compat/"):
        return "alibabaEu"
    if m.startswith("deepseek-official/") or m.startswith("deepseek/"):
        return "deepseek"
    if prices_for(model) == PRICES["worker"]:
        return "free"
    return "other"


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
    model = None
    provider = None
    if isinstance(src, dict) and isinstance(src.get("model"), str):
        model = src["model"]
        provider = src.get("provider")
    msg = data.get("message", {})
    if model is None and isinstance(msg, dict) and isinstance(msg.get("model"), str):
        model = msg["model"]
    if model is None:
        return ""
    # Provider-elotag, hogy a fizetos Alibaba-sorok illeszkedjenek (a host
    # messageModel fuggvenye ugyanezt teszi 2026-10-14 ota).
    if isinstance(provider, str) and provider and not model.startswith(provider + "/"):
        return provider + "/" + model
    return model


totals = {"requests": 0, "costUsd": 0.0}
deleg = {"requests": 0, "costUsd": 0.0, "baselineUsd": 0.0, "sessions": 0}
per_model = {}
by_family = {}
sg_models = {}

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
        # Provider-csalad bontas + a szingapuri keret gyujtese (2026-10-14).
        fam = family_of(m)
        bucket = by_family.setdefault(fam, {"requests": 0, "costUsd": 0.0})
        bucket["requests"] += 1
        bucket["costUsd"] += c
        if fam == "alibabaSg":
            toks = (u.get("totalTokens")
                    or ((u.get("inputTokens") or 0) + (u.get("cacheReadTokens") or 0) + (u.get("outputTokens") or 0)))
            sg = sg_models.setdefault(m or "(ismeretlen)", {"tokens": 0, "costUsd": 0.0})
            sg["tokens"] += toks
            sg["costUsd"] += c
        if is_deleg:
            deleg["requests"] += 1
            deleg["costUsd"] += c
            deleg["baselineUsd"] += cost(u, "deepseek-flash")

saved = max(0.0, deleg["baselineUsd"] - deleg["costUsd"])
share = deleg["requests"] / totals["requests"] * 100 if totals["requests"] else 0

# Szingapuri ingyenes keret: modellenkent az elso 1M token 0 USD.
sg_free_usd = 0.0
sg_paid_usd = 0.0
for model, sg in sg_models.items():
    free_tokens = min(sg["tokens"], SG_FREE_TOKENS_PER_MODEL)
    ratio = free_tokens / sg["tokens"] if sg["tokens"] else 0.0
    free_usd = sg["costUsd"] * ratio
    sg_free_usd += free_usd
    sg_paid_usd += sg["costUsd"] - free_usd
net_total = totals["costUsd"] - sg_free_usd

print("=== AMIT A TOOLTIP MUTATNI FOG ===")
print(f"  Kérések osszesen:        {totals['requests']:,}")
print(f"  Koltseg osszesen:        ${net_total:.4f}  (brutto ${totals['costUsd']:.4f} - SG keret ${sg_free_usd:.4f})")
print(f"  Delegalt keres:          {deleg['requests']:,}  ({share:.1f}%)")
print(f"  Delegalt sessionok:      {deleg['sessions']}")
print(f"  Delegalt koltseg:        ${deleg['costUsd']:.4f}")
print(f"  Baseline (flash aron):   ${deleg['baselineUsd']:.4f}")
print(f"  MEGTAKARITAS:            ${saved:.4f}")
print()
print("=== szolgaltato-csalad szerint (a labléc $DSH / $Alibaba parja) ===")
LABELS = {"deepseek": "DeepSeek (kozvetlen)", "alibabaEu": "Alibaba EU (Frankfurt)",
          "alibabaSg": "Alibaba Szingapur", "free": "Ingyenes lanc", "other": "Egyeb"}
for fam, b in sorted(by_family.items(), key=lambda kv: -kv[1]["costUsd"]):
    extra = ""
    if fam == "alibabaSg":
        extra = f"  [SG keret jovairva ${sg_free_usd:.4f}, fizetve ${sg_paid_usd:.4f}]"
    print(f"  {LABELS.get(fam, fam):<24} ${b['costUsd']:.4f}  ({b['requests']:,} keres){extra}")
if sg_models:
    print()
    print("=== szingapuri ingyenes keret (1M token/modell) ===")
    for model, sg in sorted(sg_models.items(), key=lambda kv: -kv[1]["tokens"]):
        pct = min(100.0, sg["tokens"] / SG_FREE_TOKENS_PER_MODEL * 100)
        print(f"  {model:<44} {sg['tokens']:>9,} token  ({pct:5.1f}% a keretnek)")
print()
print("=== modellenkenti koltseg ===")
for m, c in sorted(per_model.items(), key=lambda kv: -kv[1]):
    print(f"  {m or '(ismeretlen)':<46} ${c:.4f}")

