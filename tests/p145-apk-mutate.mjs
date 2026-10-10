// [WO 20261010-apk] p145 뮤테이션 증명 — 고친 부분을 하나씩 되돌리면 p145 가 EXIT=1 이어야 한다(가짜 초록 방지).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "p145-apk-install-cdp.mjs");
const MUTS = ["native-standalone", "vendor-filter", "android-only", "sha-display", "back-confirm", "gate-allow"];
let bad = 0;
for (const m of MUTS) {
  const r = spawnSync(process.execPath, [T], { env: { ...process.env, MUT: m }, encoding: "utf8" });
  const fails = (r.stdout.match(/^ {2}FAIL .*/gm) || []).map((l) => l.trim().slice(0, 90));
  const caught = r.status === 1 && fails.length > 0;
  console.log((caught ? "  CAUGHT " : "  MISSED ") + m + " EXIT=" + r.status + " — " + (fails[0] || r.stdout.split("\n").slice(-3).join(" | ")));
  if (!caught) bad++;
}
console.log(bad ? `\nMUTATION MISSED ${bad}` : "\nALL MUTATIONS CAUGHT");
process.exit(bad ? 1 : 0);
