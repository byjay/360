/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p57-deploy-url.test.mjs)
 *
 * 마스터 원문(2026-09-21): "배포되면 주소를 보이게 하고 주소 링크도 바로 복사 가능하게 해."
 * 대상: 프로젝트 허브 카드(12_ProjectHub.js) — 배포된(published) 카드에만 뷰어 주소를 노출하고
 * 복사·공유 버튼을 둔다. SoT: 주소 노출 게이트는 "배포됨" 배지와 동일하게 p.published 를 쓴다.
 * 주소 파생: p.subdomain(실 DB 값)이 있으면 서브도메인 URL, 없으면 사이트 루트(location.origin) —
 * 둘 다 실행 시점 값에서만 파생하고 도메인·ID 를 하드코딩하지 않는다(src/index.tsx baseDomainOf 대응).
 *
 *  ① 배포된 카드에 주소가 표시된다
 *  ② 미배포 카드에는 주소 영역이 없다
 *  ③ 주소가 실제 값(subdomain/host)에서 파생된다 — 하드코딩 0
 *  ④ 복사 버튼 동작 + 복사 후 알림(조용한 실패 0)
 *  ⑤ 공유 버튼 — navigator.share 없으면 복사로 폴백, AbortError(취소)는 오류 아님
 *  ⑥ togglePublish() 이후 즉시 반영(await this.load() 로 재렌더 — 새로고침 불필요)
 *  ⑦ 주소 노출 게이트가 "배포됨" 배지와 동일한 소스(p.published)를 쓴다
 *  ⑧ 모바일(375×812) 카드 높이 추정치 ≤ 화면의 30%, 새 주소 행이 겹침 없이 정적 흐름에 있다
 *
 * 실제 소스(12_ProjectHub.js/style.css)를 그대로 로드해 평가한다(목 아님).
 * ②③⑥에 뮤테이션 케이스가 붙는다(작업지시서 지정).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const projectHubSrc = rd("public/js/modules/12_ProjectHub.js");
const styleCssRaw = rd("public/css/style.css");
const styleCss = styleCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ══════════════════════════════════════════════════════════════════
 * 헬퍼 — 12_ProjectHub.js 를 실제 소스로 로드(목 구현 아님)
 * ══════════════════════════════════════════════════════════════════ */
function makeSandbox(src, { shareImpl, clipboardImpl, loc } = {}) {
  const toastCalls = [];
  const sandbox = {
    console, Promise, Date,
    document: { getElementById: () => ({ value: "", select() {} }), createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {} }) },
    location: loc || { hostname: "scan.seastar.work", protocol: "https:", origin: "https://scan.seastar.work" },
    navigator: Object.assign(
      {},
      shareImpl ? { share: shareImpl } : {},
      clipboardImpl ? { clipboard: { writeText: clipboardImpl } } : {}
    ),
    Prompt: { toast: (t) => toastCalls.push(t) }
  };
  sandbox.document.body = { appendChild() {}, removeChild() {} };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PH = ProjectHub;", sandbox);
  return { PH: sandbox.__PH, toastCalls };
}

/** render() 안의 "const deployUrl = ...;" 게이트 표현식을 소스에서 추출해 그대로 실행(진짜 동작 검증). */
function extractGateExpr(src) {
  const m = src.match(/const deployUrl = (.+?);/);
  return m ? m[1] : null;
}
function evalGate(PH, gateExpr, p) {
  const fn = new Function("p", "return (" + gateExpr + ");");
  return fn.call(PH, p);
}

/* ══ ① 배포된 카드에 주소 표시 / ⑦ SoT(배지와 동일 소스) ══════════════════════ */
{
  const gateExpr = extractGateExpr(projectHubSrc);
  ok(!!gateExpr, "사전조건 — render() 안에서 deployUrl 게이트 표현식을 찾았다 → " + gateExpr);
  ok(/^p\.published\s*\?/.test(gateExpr || ""), "⑦ 주소 게이트가 p.published 로 시작 — 배지(p.published ? …)와 동일 소스");

  const { PH } = makeSandbox(projectHubSrc);
  const published = { id: "p1", name: "선각 A동", published: true, subdomain: "hulla" };
  const url = evalGate(PH, gateExpr, published);
  ok(!!url && /^https?:\/\//.test(url), "① 배포된 카드 → 주소 문자열 생성됨 → " + url);
  ok(url.indexOf("hulla") !== -1, "① 주소에 프로젝트의 실제 subdomain 값이 들어간다 → " + url);
}

/* ══ ② 미배포 카드에는 주소 없음, 뮤테이션: published 게이트 제거 ══════════════ */
{
  const gateExpr = extractGateExpr(projectHubSrc);
  const { PH } = makeSandbox(projectHubSrc);
  const unpublished = { id: "p2", name: "기관실", published: false, subdomain: "engine" };
  const url = evalGate(PH, gateExpr, unpublished);
  ok(url === "", "② 미배포 프로젝트는 deployUrl 이 빈 문자열(주소 영역 미출력) → " + JSON.stringify(url));

  console.log("\n[뮤테이션ⓑ] published 게이트를 제거하면 ②가 실패해야 함");
  const needle = "const deployUrl = p.published ? this._deployUrl(p) : \"\";";
  const mutated = projectHubSrc.replace(needle, "const deployUrl = this._deployUrl(p);");
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const gateExprM = extractGateExpr(mutated);
    const { PH: PHm } = makeSandbox(mutated);
    const urlM = evalGate(PHm, gateExprM, unpublished);
    ok(urlM !== "", "뮤테이션 적용 시 미배포 카드에도 주소가 생김(②가 깨짐을 확인) → " + JSON.stringify(urlM));
  }
}

/* ══ ③ 실제 값(subdomain/host) 파생 — 하드코딩 0, 뮤테이션: 고정 문자열로 교체 ══════ */
{
  const { PH } = makeSandbox(projectHubSrc);
  const urlA = PH._deployUrl({ subdomain: "alpha" });
  const urlB = PH._deployUrl({ subdomain: "bravo" });
  ok(urlA !== urlB, "③a 서로 다른 subdomain → 서로 다른 주소 → " + urlA + " / " + urlB);
  ok(urlA.indexOf("alpha") !== -1 && urlB.indexOf("bravo") !== -1, "③b 각 주소에 해당 프로젝트의 실제 subdomain 값이 들어간다");

  const { PH: PH2 } = makeSandbox(projectHubSrc, { loc: { hostname: "sub.otherdomain.dev", protocol: "https:", origin: "https://sub.otherdomain.dev" } });
  const urlC = PH2._deployUrl({ subdomain: "alpha" });
  ok(urlC !== urlA, "③c 접속 호스트가 다르면(otherdomain.dev) 같은 subdomain 이어도 다른 주소(하드코딩 도메인 아님) → " + urlC);

  console.log("\n[뮤테이션ⓐ] subdomain 분기를 고정 문자열로 바꾸면 ③이 실패해야 함");
  const needle = 'if (p.subdomain) return loc.protocol + "//" + p.subdomain + "." + base;';
  const mutated = projectHubSrc.replace(needle, 'if (p.subdomain) return "https://scan.seastar.work";');
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PH: PHm } = makeSandbox(mutated);
    const uA = PHm._deployUrl({ subdomain: "alpha" });
    const uB = PHm._deployUrl({ subdomain: "bravo" });
    ok(uA === uB, "뮤테이션 적용 시 서로 다른 subdomain 인데 주소가 동일해짐(③이 깨짐을 확인) → " + uA + " / " + uB);
  }
}

/* ══ ④ 복사 버튼 동작 + 알림 ══════════════════════════════════════════ */
{
  const writeCalls = [];
  const clipboardImpl = (t) => { writeCalls.push(t); return Promise.resolve(); };
  const { PH, toastCalls } = makeSandbox(projectHubSrc, { clipboardImpl });
  PH._copyDeployUrl("https://hulla.seastar.work/");
  ok(writeCalls[0] === "https://hulla.seastar.work/", "④a 클립보드에 실제 주소가 복사됨 → " + JSON.stringify(writeCalls));
  await new Promise((r) => setTimeout(r, 10));
  ok(toastCalls.some((t) => /복사했습니다/.test(t)), "④b 복사 후 알림 표시(조용한 실패 0) → " + JSON.stringify(toastCalls));
}

/* ══ ⑤ 공유 폴백 + AbortError 무시 ═══════════════════════════════════ */
{
  const writeCalls = [];
  const { PH, toastCalls } = makeSandbox(projectHubSrc, { clipboardImpl: (t) => { writeCalls.push(t); return Promise.resolve(); } });
  PH._shareDeployUrl("https://hulla.seastar.work/", "선각 A동");
  await new Promise((r) => setTimeout(r, 10));
  ok(writeCalls[0] === "https://hulla.seastar.work/", "⑤a navigator.share 미지원 → 클립보드 복사로 폴백 → " + JSON.stringify(writeCalls));

  const shareImpl = () => Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  const { PH: PH2, toastCalls: toast2 } = makeSandbox(projectHubSrc, { shareImpl });
  PH2._shareDeployUrl("https://hulla.seastar.work/", "선각 A동");
  await new Promise((r) => setTimeout(r, 10));
  ok(toast2.length === 0, "⑤b AbortError(취소) 는 오류 알림을 띄우지 않는다 → " + JSON.stringify(toast2));
}

/* ══ ⑥ togglePublish 직후 즉시 반영, 뮤테이션: await this.load() 제거 ══════════ */
{
  const m = projectHubSrc.match(/async togglePublish\(p, btn\) \{[\s\S]*?\n    \},/);
  ok(!!m, "사전조건 — togglePublish() 함수 블록을 찾았다");
  const body = m ? m[0] : "";
  ok(/p\.published = willPublish;[\s\S]*?await this\.load\(\);/.test(body), "⑥a 배포 플래그 갱신 직후 await this.load() 로 재렌더(새로고침 불필요)");
  ok(/async load\(\)[\s\S]*?this\.render\(\)/.test(projectHubSrc), "⑥b load() 는 실제로 render() 를 호출한다(재조회→즉시 화면 반영 경로 성립)");

  console.log("\n[뮤테이션ⓒ] togglePublish 의 await this.load() 를 제거하면 ⑥이 실패해야 함");
  const needle = `        p.published = willPublish;
        Prompt && Prompt.toast && Prompt.toast(willPublish ? "'" + p.name + "' 배포 완료 — 뷰어가 열람할 수 있습니다." : "'" + p.name + "' 배포 취소 — 뷰어에게 비공개.", 2800);
        await this.load();`;
  const mutated = projectHubSrc.replace(needle, `        p.published = willPublish;
        Prompt && Prompt.toast && Prompt.toast(willPublish ? "'" + p.name + "' 배포 완료 — 뷰어가 열람할 수 있습니다." : "'" + p.name + "' 배포 취소 — 뷰어에게 비공개.", 2800);`);
  if (mutated === projectHubSrc) { console.log("  FAIL 뮤테이션 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mM = mutated.match(/async togglePublish\(p, btn\) \{[\s\S]*?\n    \},/);
    const bodyM = mM ? mM[0] : "";
    ok(!/p\.published = willPublish;[\s\S]*?await this\.load\(\);/.test(bodyM), "뮤테이션 적용 시 즉시반영 호출이 사라짐(⑥이 깨짐을 확인)");
  }
}

/* ══ ⑧ 모바일 375×812 카드 높이 추정 ≤30%, 겹침 0(구조 증명) ══════════════════ */
{
  function ruleBody(src, plainSelector) {
    const escaped = plainSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "\\s*\\{([^}]*)\\}");
    const m2 = src.match(re);
    return m2 ? m2[1] : null;
  }
  function numProp(body, prop) {
    if (!body) return null;
    const m2 = body.match(new RegExp(prop + "\\s*:\\s*([0-9.]+)px"));
    return m2 ? parseFloat(m2[1]) : null;
  }
  function strProp(body, prop) {
    if (!body) return null;
    const m2 = body.match(new RegExp(prop + "\\s*:\\s*([a-zA-Z-]+)"));
    return m2 ? m2[1] : null;
  }

  const urlRowBody = ruleBody(styleCss, ".hub-card-url");
  ok(!!urlRowBody, "사전조건 — .hub-card-url CSS 규칙 존재");
  const urlBtnBody = ruleBody(styleCss, ".hub-card-url-copy, .hub-card-url-share");
  ok(!!urlBtnBody, "사전조건 — .hub-card-url-copy/.hub-card-url-share CSS 규칙 존재");

  // 정적 흐름 배치 증명 — position 미지정(기본 static) → 하단 고정 UI/썸네일과 좌표상 겹칠 수 없다.
  const urlRowPosition = strProp(urlRowBody, "position");
  ok(!urlRowPosition || urlRowPosition === "static" || urlRowPosition === "relative", "⑧a .hub-card-url 이 절대/고정 배치가 아니다(정적 흐름) → position=" + urlRowPosition);

  const marginTop = numProp(urlRowBody, "margin-top") ?? 0;
  const paddingTop = numProp(urlRowBody, "padding-top") ?? 0;
  const btnMinHeight = numProp(urlBtnBody, "min-height") ?? 0;
  ok(btnMinHeight >= 44, "⑧b 복사/공유 버튼 터치타깃 min-height ≥44 → " + btnMinHeight);

  // p38 과 동일한 방식으로 모바일(720px) 블록에서 기존 요소 치수를 뽑아 카드 전체 높이를 추정한다.
  function findMediaBlockContaining(css, needle) {
    const marker = "@media (max-width: 720px) {";
    let idx = 0;
    while (true) {
      const start = css.indexOf(marker, idx);
      if (start === -1) return null;
      let depth = 0, i = start + marker.length - 1, end = -1;
      for (; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) return null;
      const block = css.slice(start, end + 1);
      if (block.includes(needle)) return block;
      idx = end + 1;
    }
  }
  const mobileBlock = findMediaBlockContaining(styleCss, ".hub-card-actions");
  ok(!!mobileBlock, "사전조건 — 720px 모바일 블록 존재(p38 과 동일 소스)");
  const thumbHeight = numProp(ruleBody(mobileBlock, ".hub-card-thumb"), "height") ?? 0;
  const bodyPad = (ruleBody(mobileBlock, ".hub-card-body") || "").match(/padding\s*:\s*([0-9.]+)px\s+([0-9.]+)px\s+([0-9.]+)px/);
  const bodyPadTop = bodyPad ? parseFloat(bodyPad[1]) : 0;
  const bodyPadBottom = bodyPad ? parseFloat(bodyPad[3]) : 0;
  const nameFontSize = numProp(ruleBody(mobileBlock, ".hub-card-name"), "font-size") ?? 0;
  const nameMarginBottom = numProp(ruleBody(mobileBlock, ".hub-card-name"), "margin-bottom") ?? 0;
  const metaFontSize = numProp(ruleBody(mobileBlock, ".hub-card-meta"), "font-size") ?? 0;
  const actMinHeight = numProp((mobileBlock.match(/\.hub-card-act\s*\{([^}]*)\}/) || [])[1], "height") ?? 0;

  const estimatedCardHeight =
    thumbHeight +
    bodyPadTop + bodyPadBottom +
    nameFontSize * 1.3 + nameMarginBottom +
    metaFontSize * 1.3 +
    actMinHeight + 8 +
    marginTop + paddingTop + btnMinHeight; // [WO 20260921] 신규 주소 행

  const budget = 812 * 0.3;
  ok(estimatedCardHeight > 0 && estimatedCardHeight <= budget, "⑧c 주소 행 포함 모바일 추정 카드 높이(" + estimatedCardHeight.toFixed(1) + "px) ≤ 화면 30%(" + budget.toFixed(1) + "px)");
}

console.log(failed === 0 ? "\n[ALL PASS]" : "\n[" + failed + " FAILED]");
process.exit(failed === 0 ? 0 : 1);
