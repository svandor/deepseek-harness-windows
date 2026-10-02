#!/usr/bin/env python
"""A most futó munka valos koltsege es a delegalas hatasa.

Kulon meri a root sessiont es a belole indult gyermeket, hogy latszodjon,
mekkora volt a subagent tenyleges koltsege (es mennyi lett volna ingyenesen).
"""
import glob
import json
import os
import time
from compression import zstd

ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")
PRICES = {
    "deepseek-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-flash": {"miss": 0.14, "hit": 0.0028, "out": 0.28},
    "deepseek-v4-pro": {"miss": 0.435, "hit": 0.003625, "out": 0.87},
    "worker": {"miss": 0.0, "hit": 0.0, "out": 0.0},
}

def prices_for(model):
    low = (model or "").lower()
    for k, p in PRICES.items():
        if k in low:
            return p
    return PRICES["deepseek-flash"]

def cost(u, model):
    p = prices_for(model)
    return ((u.get("inputTokens") or 0) * p["miss"]
            + (u.get("cacheReadTokens") or 0) * p["hit"]
            + (u.get("outputTokens") or 0) * p["out"]) / 1_000_000

def model_of(d):
    src = (d.get("message") or {}).get("source") or d.get("source") or {}
    if isinstance(src, dict) and isinstance(src.get("model"), str):
        return src["model"]
    msg = d.get("message") or {}
    if isinstance(msg, dict) and isinstance(msg.get("model"), str):
        return msg["model"]
    return ""

files = sorted(glob.glob(os.path.join(ROOT, "**", "*.jsonl.zstd"), recursive=True),
               key=os.path.getmtime, reverse=True)

cutoff = time.time() - 40 * 60
print("=== a legutobbi 40 perc sessionjei ===")
grand = {"root": 0.0, "child": 0.0, "childBase": 0.0, "subCalls": 0}

for f in files[:12]:
    if os.path.getmtime(f) < cutoff:
        continue
    try:
        text = zstd.decompress(open(f, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        continue
    try:
        h = json.loads(lines[0])
    except Exception:
        continue
    is_child = (h.get("delegationDepth") or 0) > 0 or h.get("origin") == "subagent"
    routes, u = set(), {"inputTokens": 0, "cacheReadTokens": 0, "outputTokens": 0}
    calls = 0
    sub_calls = 0
    for line in lines:
        if '"request/header"' in line:
            try:
                e = json.loads(line)
                c = e.get("data", {}).get("header", {}).get("config", {})
                if c:
                    routes.add(f"{c.get('provider')}/{c.get('model')}")
            except Exception:
                pass
        if '"tool-call"' in line and ('"name":"subagent"' in line or '"name": "subagent"' in line):
            sub_calls += 1
        if '"usage"' in line:
            try:
                e = json.loads(line)
                uu = e.get("data", {}).get("usage")
                if isinstance(uu, dict):
                    u["inputTokens"] += uu.get("inputTokens") or 0
                    u["cacheReadTokens"] += uu.get("cacheReadTokens") or 0
                    u["outputTokens"] += uu.get("outputTokens") or 0
                    calls += 1
            except Exception:
                pass
    model = sorted(routes)[0].split("/")[-1] if routes else "?"
    c = cost(u, model)
    base = cost(u, "deepseek-flash")
    label = "GYERMEK" if is_child else "SZULO  "
    age = int((time.time() - os.path.getmtime(f)) / 60)
    print(f"\n{label} {os.path.basename(os.path.dirname(f))[:18]}  ({age} perce)")
    print(f"  route: {', '.join(sorted(routes)) or '(meg nincs keres)'}")
    print(f"  keres: {calls:,}   subagent-hivas: {sub_calls}")
    print(f"  tokenek: in={u['inputTokens']:,} cacheRead={u['cacheReadTokens']:,} out={u['outputTokens']:,}")
    print(f"  koltseg: ${c:.5f}   (flash baseline: ${base:.5f})")
    if is_child:
        grand["child"] += c
        grand["childBase"] += base
    else:
        grand["root"] += c
    grand["subCalls"] += sub_calls

print("\n" + "=" * 62)
print(f"  SZULO koltseg osszesen:    ${grand['root']:.4f}")
print(f"  GYERMEK koltseg osszesen:  ${grand['child']:.4f}")
print(f"  subagent-hivasok:          {grand['subCalls']}")
print(f"\n  Ha a gyermek az INGYENES lancon ment volna: ${0.0:.4f}")
print(f"  Elmaradt megtakaritas:     ${grand['child']:.4f}")
print(f"\n  (a route-ok alapjan: ha 'worker' nincs a listaban, a gyermek")
print(f"   a SZULO route-jat orokolte — azaz a beallitas meg nem elt)")
