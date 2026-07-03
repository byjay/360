#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
modules/_manifest.txt 순서대로 블록 파일을 concat → public/js/main.js 재생성.
각 모듈은 줄바꿈 하나로 연결 (원본이 모듈 사이를 \n 으로 구분했던 것과 동일).
"""
import os, sys

OUT_DIR = "public/js/modules"
TARGET = "public/js/main.js"

manifest = [l.strip() for l in open(os.path.join(OUT_DIR, "_manifest.txt"), encoding="utf-8") if l.strip()]
parts = []
for f in manifest:
    parts.append(open(os.path.join(OUT_DIR, f), encoding="utf-8").read())

# 원본은 각 블록이 \n 으로 이어졌음 → "\n".join 으로 동일하게 복원
result = "\n".join(parts)
open(TARGET, "w", encoding="utf-8").write(result)
print(f"조립 완료: {len(manifest)} 블록 → {TARGET} ({len(result.splitlines())} 줄, {len(result)} 바이트)")
