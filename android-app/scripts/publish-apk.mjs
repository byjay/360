#!/usr/bin/env node
// SEASTAR 360 — 서명된 릴리스 APK 를 웹 배포 위치로 내보내고 메타 JSON(SoT)을 만든다.
//   입력: android-app/android/app/build/outputs/apk/release/app-release.apk (scripts/build-apk.bat 결과)
//   출력: public/download/seastar360.apk + public/download/seastar360.json
//   메타 값은 전부 실제 APK 에서 읽는다(aapt badging·apksigner 인증서 지문·sha256) — 손으로 적지 않는다.
//   CF Pages 파일당 25MiB 한도(창고 19-mobile-flutter-web PITFALLS ④) — 넘으면 중단하고 R2 배포로 돌린다.
// 사용: node android-app/scripts/publish-apk.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAP = path.resolve(HERE, "..");
const REPO = path.resolve(WRAP, "..");
const SRC = path.join(WRAP, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
const OUT_DIR = path.join(REPO, "public", "download");
const FILE = "seastar360.apk";
const LIMIT = 25 * 1024 * 1024;

function die(msg) { console.error("[publish-apk] " + msg); process.exit(1); }
if (!fs.existsSync(SRC)) die("APK 없음: " + SRC + " — 먼저 android-app/scripts/build-apk.bat");

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : "");
const btRoot = path.join(sdk, "build-tools");
if (!sdk || !fs.existsSync(btRoot)) die("Android SDK build-tools 를 찾지 못함 (ANDROID_HOME)");
const bt = path.join(btRoot, fs.readdirSync(btRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop());
const exe = (n) => path.join(bt, process.platform === "win32" ? (n === "apksigner" ? n + ".bat" : n + ".exe") : n);

const buf = fs.readFileSync(SRC);
if (buf.length >= LIMIT) die(`APK ${buf.length} bytes ≥ 25MiB — CF Pages 정적 배포 불가. R2 배포로 전환하세요.`);
const sha256 = createHash("sha256").update(buf).digest("hex");

const badging = execFileSync(exe("aapt"), ["dump", "badging", SRC], { encoding: "utf8" });
const pick = (re) => { const m = badging.match(re); return m ? m[1] : null; };
const appId = pick(/package: name='([^']+)'/);
const versionCode = Number(pick(/versionCode='(\d+)'/));
const versionName = pick(/versionName='([^']+)'/);
const minSdk = Number(pick(/sdkVersion:'(\d+)'/));
const targetSdk = Number(pick(/targetSdkVersion:'(\d+)'/));
const permissions = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
if (!appId || !versionName || !versionCode) die("aapt badging 파싱 실패");

const env = { ...process.env, JAVA_TOOL_OPTIONS: "-Djava.io.tmpdir=" + path.join(REPO, ".tmp") + " -XX:-UsePerfData" };
if (!env.JAVA_HOME) env.JAVA_HOME = "C:\\Program Files\\Android\\Android Studio\\jbr";
const signerOut = execFileSync(exe("apksigner"), ["verify", "--print-certs", SRC], { encoding: "utf8", env, shell: process.platform === "win32" });
const signerSha256 = (signerOut.match(/certificate SHA-256 digest: ([0-9a-f]{64})/) || [])[1];
if (!signerSha256) die("apksigner verify 실패 — 서명되지 않은 APK 는 배포하지 않는다");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, FILE), buf);
const meta = { file: FILE, appId, versionName, versionCode, bytes: buf.length, sha256, signerSha256, minSdk, targetSdk, permissions, builtAt: new Date(fs.statSync(SRC).mtimeMs).toISOString() };
fs.writeFileSync(path.join(OUT_DIR, "seastar360.json"), JSON.stringify(meta, null, 2) + "\n");
console.log(JSON.stringify(meta, null, 2));
