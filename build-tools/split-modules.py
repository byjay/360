#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
main.js → 기능별 블록 모듈로 분리.
모든 모듈이 같은 IIFE 클로저를 공유하므로,
  - HEADER (IIFE 시작 + 공용 헬퍼)
  - modules/NN_Name.js  (각 const XXX = {...} 블록)
  - FOOTER (진입 + IIFE 종료)
로 쪼갠 뒤, assemble.py 가 순서대로 concat 하면 원본과 동일.
"""
import re, os, sys

SRC = "public/js/main.js"
OUT_DIR = "public/js/modules"
os.makedirs(OUT_DIR, exist_ok=True)

raw = open(SRC, encoding="utf-8").read()
lines = raw.split("\n")

# 모듈 시작 라인(0-based)
mods = []
for i, ln in enumerate(lines):
    m = re.match(r'^  const ([A-Z][a-zA-Z]*) = \{', ln)
    if m:
        mods.append((i, m.group(1)))

first = mods[0][0]                 # 첫 모듈 시작
# 진입부(footer) 시작
footer = None
for i, ln in enumerate(lines):
    if ln.strip() == "/* ── 진입 ── */":
        footer = i
        break
assert footer is not None, "진입부를 찾지 못함"

# HEADER = 0 .. first-1
header = "\n".join(lines[0:first])
open(os.path.join(OUT_DIR, "00_header.js"), "w", encoding="utf-8").write(header)

# 각 모듈
manifest = ["00_header.js"]
for idx, (start, name) in enumerate(mods):
    end = mods[idx+1][0] if idx+1 < len(mods) else footer
    block = "\n".join(lines[start:end])
    fname = f"{idx+1:02d}_{name}.js"
    open(os.path.join(OUT_DIR, fname), "w", encoding="utf-8").write(block)
    manifest.append(fname)

# FOOTER = footer .. EOF
footer_txt = "\n".join(lines[footer:])
open(os.path.join(OUT_DIR, "99_footer.js"), "w", encoding="utf-8").write(footer_txt)
manifest.append("99_footer.js")

# manifest 저장 (조립 순서)
open(os.path.join(OUT_DIR, "_manifest.txt"), "w", encoding="utf-8").write("\n".join(manifest) + "\n")

print(f"분리 완료: HEADER + {len(mods)} 모듈 + FOOTER = {len(manifest)} 파일")
for f in manifest:
    p = os.path.join(OUT_DIR, f)
    print(f"  {f:24s} {len(open(p,encoding='utf-8').read().splitlines()):5d} 줄")
