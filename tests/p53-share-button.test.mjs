/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p53-share-button.test.mjs)
 *
 * 마스터 원문(2026-09-21): "공유 버튼 추가 — 폰에서 누르면 공유 시트가 뜨고 거기서
 * 카톡 선택." 대상은 [1] 멤버 초대 링크(#proj-members-modal, #pm-invite-link-box)뿐이다.
 * [2] 배포(?d=) 링크는 코드베이스 전수 grep 결과 그 링크를 사용자에게 보여주는 UI가
 * 존재하지 않는다(togglePublish()는 API 토글만 하고 URL을 화면에 띄우지 않음) —
 * YAGNI 원칙에 따라 만들지 않았다(작업지시서 [2] 참조).
 *
 *  ① #pm-invite-link-box 안에 공유 버튼이 존재하고 보이는 글자("공유")가 있다
 *  ② navigator.share 가 있으면 그것을 호출한다(url·프로젝트명 포함)
 *  ③ 없으면 기존 복사(_copyInviteLink, SoT)로 대체하고 사용자에게 알린다(조용한 실패 0)
 *  ④ AbortError(사용자 취소) 시 오류 알림이 뜨지 않는다
 *  ⑤ 공유 문구에 프로젝트명이 들어가고 하드코딩이 아니다(다른 프로젝트명 두 번 호출 → 문구가 바뀜)
 *  ⑥ 기존 복사 버튼(#pm-invite-copy → _copyInviteLink)이 그대로 동작(회귀)
 *  ⑦ 터치타깃 ≥44×44 + 375×812 겹침 0 — 모달은 position:fixed inset:0 z-index:9999
 *     (mobile-dock z-index 140보다 훨씬 높고 배경을 전부 덮으므로 열려 있는 동안
 *     p34/p41/p42/p46 이 검증하는 하단 고정 UI와 애초에 겹칠 수 없다 — 구조 증명)
 *
 * 실제 소스(index.html/12_ProjectHub.js/style.css)를 그대로 로드해 평가한다(목 아님).
 * ③④⑤에 뮤테이션 케이스가 붙는다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const indexHtml = rd("public/index.html");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const styleCssRaw = rd("public/css/style.css");
const styleCss = styleCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const flush = () => new Promise((r) => setTimeout(r, 10));

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — 12_ProjectHub.js 를 실제 소스로 로드(목 구현 아님)
 * ══════════════════════════════════════════════════════════════════ */
function makeSandbox(src, { shareImpl, clipboardImpl } = {}) {
  const registry = { "pm-invite-link": { value: "", select() {} } };
  const el = (id) => (registry[id] = registry[id] || { value: "", select() {} });
  const toastCalls = [];
  const sandbox = {
    console, Promise, Date,
    document: { getElementById: (id) => el(id) },
    navigator: Object.assign(
      {},
      shareImpl ? { share: shareImpl } : {},
      clipboardImpl ? { clipboard: { writeText: clipboardImpl } } : {}
    ),
    Prompt: { toast: (t) => toastCalls.push(t) }
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PH = ProjectHub;", sandbox);
  return { PH: sandbox.__PH, registry, toastCalls };
}

/* ══ ① 버튼 존재 + 보이는 글자 ══════════════════════════════════════ */
{
  const boxMatch = indexHtml.match(/<div id="pm-invite-link-box"[\s\S]*?<\/div>\s*<\/div>/);
  ok(!!boxMatch, "사전조건 — #pm-invite-link-box 블록 파싱됨");
  const box = boxMatch ? boxMatch[0] : "";
  ok(/id="pm-invite-share"/.test(box), "① #pm-invite-share 버튼이 초대 링크 영역 안에 있다");
  const btnMatch = box.match(/<button id="pm-invite-share"[^>]*>([^<]*)<\/button>/);
  ok(!!btnMatch && /공유/.test(btnMatch[1]), "① 버튼에 보이는 글자 '공유' → " + (btnMatch && btnMatch[1]));
  ok(/id="pm-invite-copy"/.test(box), "① 기존 #pm-invite-copy 버튼이 제거되지 않았다");
}

/* ══ ② navigator.share 있으면 호출 ══════════════════════════════════ */
{
  const calls = [];
  const shareImpl = (data) => { calls.push(data); return Promise.resolve(); };
  const { PH, registry } = makeSandbox(projectHubSrc, { shareImpl });
  registry["pm-invite-link"].value = "https://example.com/i?t=abc123";
  PH._memProject = { id: "proj1", name: "선각 A동 검사" };
  PH._shareInviteLink();
  ok(calls.length === 1, "② navigator.share 가 1회 호출됨 → " + calls.length);
  ok(calls[0] && calls[0].url === "https://example.com/i?t=abc123", "② url 이 실제 링크값 그대로 전달됨 → " + (calls[0] && calls[0].url));
}

/* ══ ③ 미지원 → 복사로 대체 + 알림(조용한 실패 0), 뮤테이션: 폴백 제거 ══════════ */
{
  const writeCalls = [];
  const clipboardImpl = (t) => { writeCalls.push(t); return Promise.resolve(); };
  const { PH, registry, toastCalls } = makeSandbox(projectHubSrc, { clipboardImpl }); // shareImpl 없음 = navigator.share undefined
  registry["pm-invite-link"].value = "https://example.com/i?t=xyz";
  PH._memProject = { id: "proj1", name: "선각 A동 검사" };
  PH._shareInviteLink();
  await flush();
  ok(writeCalls.length === 1 && writeCalls[0] === "https://example.com/i?t=xyz", "③ navigator.share 미지원 → 클립보드로 복사됨 → " + JSON.stringify(writeCalls));
  ok(toastCalls.some((t) => /복사했습니다/.test(t)), "③ 사용자에게 복사됐음을 알림(조용한 실패 0) → " + JSON.stringify(toastCalls));

  console.log("\n[뮤테이션ⓐ] 폴백(_copyInviteLink 호출)을 제거하면 ③이 실패해야 함");
  const needle = `      if (!navigator.share) { this._copyInviteLink(); return; }`;
  const mutated = projectHubSrc.replace(needle, `      if (!navigator.share) { return; }`);
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PH: PHm, registry: regM, toastCalls: toastM } = makeSandbox(mutated, { clipboardImpl: () => Promise.resolve() });
    regM["pm-invite-link"].value = "https://example.com/i?t=xyz";
    PHm._memProject = { id: "proj1", name: "선각 A동 검사" };
    PHm._shareInviteLink();
    await flush();
    ok(!toastM.some((t) => /복사했습니다/.test(t)), "뮤테이션 적용 시 복사 알림이 사라짐(③이 깨짐을 확인) → " + JSON.stringify(toastM));
  }
}

/* ══ ④ AbortError → 오류 알림 없음, 뮤테이션: AbortError 도 오류로 취급 ═══════════ */
{
  const shareImpl = () => Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  const { PH, registry, toastCalls } = makeSandbox(projectHubSrc, { shareImpl });
  registry["pm-invite-link"].value = "https://example.com/i?t=abc";
  PH._memProject = { id: "proj1", name: "선각 A동 검사" };
  PH._shareInviteLink();
  await flush();
  ok(toastCalls.length === 0, "④ 사용자가 공유시트를 취소(AbortError)해도 오류 알림이 뜨지 않음 → " + JSON.stringify(toastCalls));

  console.log("\n[뮤테이션ⓑ] AbortError 를 오류로 처리하도록 바꾸면 ④가 실패해야 함");
  const needle = `if (e && e.name === "AbortError") return; // 사용자가 공유시트를 취소 — 정상 동작, 오류 알림 금지`;
  const mutated = projectHubSrc.replace(needle, `if (false) return;`);
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PH: PHm, registry: regM, toastCalls: toastM } = makeSandbox(mutated, { shareImpl });
    regM["pm-invite-link"].value = "https://example.com/i?t=abc";
    PHm._memProject = { id: "proj1", name: "선각 A동 검사" };
    PHm._shareInviteLink();
    await flush();
    ok(toastM.length > 0, "뮤테이션 적용 시 AbortError 에도 오류 토스트가 뜸(④가 깨짐을 확인) → " + JSON.stringify(toastM));
  }
}

/* ══ ⑤ 공유 문구 = 프로젝트명, 하드코딩 아님(뮤테이션: 하드코딩으로 교체) ══════════ */
{
  const calls = [];
  const shareImpl = (data) => { calls.push(data); return Promise.resolve(); };
  const { PH, registry } = makeSandbox(projectHubSrc, { shareImpl });
  registry["pm-invite-link"].value = "https://example.com/i?t=1";
  PH._memProject = { id: "p1", name: "선각 A동 검사" };
  PH._shareInviteLink();
  PH._memProject = { id: "p2", name: "기관실 B구역" };
  PH._shareInviteLink();
  ok(calls.length === 2, "사전조건 — 2회 호출됨");
  ok(calls[0] && /선각 A동 검사/.test(calls[0].text || ""), "⑤a 첫 호출 문구에 프로젝트명1 포함 → " + (calls[0] && calls[0].text));
  ok(calls[1] && /기관실 B구역/.test(calls[1].text || ""), "⑤b 둘째 호출 문구에 프로젝트명2 포함(다른 값 → 다른 문구, 하드코딩 아님) → " + (calls[1] && calls[1].text));
  ok(!/선각 A동 검사/.test(calls[1].text || ""), "⑤c 둘째 호출 문구에 첫 프로젝트명이 남아있지 않음(고정 문자열 아님)");

  console.log("\n[뮤테이션ⓒ] 공유 문구를 프로젝트명 대신 고정 문자열로 바꾸면 ⑤가 실패해야 함");
  const needle = `const projectName = (p && (p.name || p.id)) || "프로젝트"; // SoT: 실제 프로젝트 값에서만 가져온다(하드코딩 금지)`;
  const mutated = projectHubSrc.replace(needle, `const projectName = "고정프로젝트명";`);
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const callsM = [];
    const { PH: PHm, registry: regM } = makeSandbox(mutated, { shareImpl: (d) => { callsM.push(d); return Promise.resolve(); } });
    regM["pm-invite-link"].value = "https://example.com/i?t=1";
    PHm._memProject = { id: "p1", name: "선각 A동 검사" };
    PHm._shareInviteLink();
    PHm._memProject = { id: "p2", name: "기관실 B구역" };
    PHm._shareInviteLink();
    const bothSame = callsM.length === 2 && callsM[0].text === callsM[1].text;
    ok(bothSame, "뮤테이션 적용 시 서로 다른 프로젝트인데 문구가 똑같아짐(⑤가 깨짐을 확인) → " + JSON.stringify(callsM.map((c) => c.text)));
  }
}

/* ══ ⑥ 기존 복사 버튼 회귀 — _copyInviteLink 그대로 동작 ══════════════════════ */
{
  const writeCalls = [];
  const { PH, registry, toastCalls } = makeSandbox(projectHubSrc, { clipboardImpl: (t) => { writeCalls.push(t); return Promise.resolve(); } });
  registry["pm-invite-link"].value = "https://example.com/i?t=copy-test";
  PH._copyInviteLink();
  await flush();
  ok(writeCalls[0] === "https://example.com/i?t=copy-test", "⑥ 기존 복사 버튼 로직(_copyInviteLink)이 그대로 동작 → " + JSON.stringify(writeCalls));
  ok(toastCalls.some((t) => /복사했습니다/.test(t)), "⑥ 복사 완료 알림도 그대로 → " + JSON.stringify(toastCalls));
}

/* ══ ⑦ 터치타깃 ≥44×44 + 375×812 겹침 0(구조 증명) ══════════════════════════ */
{
  const shareBtnRuleMatch = styleCss.match(/\.pm-share-btn\s*\{([^}]*)\}/);
  ok(!!shareBtnRuleMatch, "사전조건 — .pm-share-btn CSS 규칙 존재");
  const rule = shareBtnRuleMatch ? shareBtnRuleMatch[1] : "";
  const minH = parseFloat((rule.match(/min-height\s*:\s*([\d.]+)px/) || [])[1] || "0");
  const minW = parseFloat((rule.match(/min-width\s*:\s*([\d.]+)px/) || [])[1] || "0");
  ok(minH >= 44, "⑦a min-height ≥44px, 실제 " + minH);
  ok(minW >= 44, "⑦b min-width ≥44px, 실제 " + minW);

  // 모달 z-index/포지션 — 열려 있으면 화면 전체를 덮으므로 하단 고정 UI(mobile-dock z-index 140)와
  // 애초에 겹칠 수 없다(구조 증명, p34/p41/p42/p46 이 검증하는 대상과 별개의 레이어).
  const gateRule = (styleCss.match(/\.admin-gate\s*\{([^}]*)\}/) || [])[1] || "";
  const gateZ = parseFloat((gateRule.match(/z-index\s*:\s*([\d.]+)/) || [])[1] || "0");
  const gatePos = /position\s*:\s*fixed/.test(gateRule);
  const gateInset0 = /inset\s*:\s*0/.test(gateRule);
  const dockZ = parseFloat((styleCss.match(/\.mobile-dock\{[^}]*z-index\s*:\s*([\d.]+)/) || [])[1] || "0");
  ok(gatePos && gateInset0, "⑦c #proj-members-modal(.admin-gate)이 position:fixed; inset:0 로 전체 화면을 덮는다");
  ok(gateZ > dockZ, "⑦d 모달 z-index(" + gateZ + ") > .mobile-dock z-index(" + dockZ + ") → 열려 있는 동안 하단 UI 위를 완전히 덮는다");
  ok(/id="proj-members-modal" class="admin-gate/.test(indexHtml), "⑦e #proj-members-modal 이 실제로 .admin-gate 클래스를 쓴다(위 구조 증명이 이 모달에 적용됨)");
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
