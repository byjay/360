// tests/_lib/fake-snapshot.mjs — 가짜 D1(p48·p61·p63 의 "저장소만 대체" 하네스)에 배포 스냅샷 저장소를 붙이는 단일 지점.
//
// [WO 20261012-viewlink] 서버가 열람 링크 읽기를 배포 스냅샷(pub_snapshots · pub_snapshot_deps, migrations/0044)으로 바꿨다.
//   하네스마다 같은 SQL 흉내를 따로 쓰면 갈라진다 → 여기 한 곳에서만 흉내낸다. 핸들러·SQL 은 실 소스 그대로이고
//   이 모듈은 그 SQL 이 읽고 쓰는 **행**만 state 에 보관한다(captureSnapshot 의 실제 batch 를 그대로 실행).
//   반환 undefined = "이 질의는 스냅샷 저장소 질의가 아님" → 호출부의 기존 가짜가 처리한다.

const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();
const has = (q, s) => q.indexOf(s) >= 0;

function store(state) {
  if (!state.__snap) state.__snap = { heads: {}, deps: {} };
  return state.__snap;
}

/** first() 질의 */
export function snapFirst(state, sql, a) {
  const q = norm(sql), S = store(state);
  if (has(q, "FROM pub_snapshots WHERE project_id = ?")) return S.heads[a[0]] || null;
  if (has(q, "SELECT row_json FROM pub_snapshot_deps WHERE project_id = ? AND dep_id = ?")) {
    const r = (S.deps[a[0]] || {})[a[1]]; return r ? { row_json: r } : null;
  }
  if (has(q, "FROM pub_snapshot_deps WHERE project_id = ? AND instr(row_json, ?) > 0")) {
    return Object.values(S.deps[a[0]] || {}).some((j) => j.indexOf(a[1]) >= 0) ? { x: 1 } : null;
  }
  return undefined;
}

/** all() 질의 — decks 는 state.decks 를 쓴다(하네스 공통 필드: project_id·deployment_id·deleted·level_no·created_at). */
export function snapAll(state, sql, a) {
  const q = norm(sql), S = store(state);
  if (has(q, "SELECT dep_id FROM pub_snapshot_deps WHERE project_id = ?")) return { results: Object.keys(S.deps[a[0]] || {}).map((dep_id) => ({ dep_id })) };
  if (has(q, "FROM decks d LEFT JOIN deployments dp")) {
    const deps = state.deployments || {};
    const rows = (state.decks || []).filter((d) => d.project_id === a[0] && !d.deleted).map((d, i) => Object.assign({ id: d.id || ("dk_fake_" + i) }, d, {
      deployment_title: (deps[d.deployment_id] || {}).title || null, deployment_file_name: (deps[d.deployment_id] || {}).file_name || null }));
    return { results: rows };
  }
  return undefined;
}

/** run() 질의 */
export function snapRun(state, sql, a) {
  const q = norm(sql), S = store(state);
  if (has(q, "DELETE FROM pub_snapshot_deps WHERE project_id = ?")) { S.deps[a[0]] = {}; return { success: true }; }
  if (has(q, "INSERT INTO pub_snapshot_deps")) { (S.deps[a[0]] = S.deps[a[0]] || {})[a[1]] = a[2]; return { success: true }; }
  if (has(q, "INSERT INTO pub_snapshots")) { S.heads[a[0]] = { decks_json: a[1], original_deployment_id: a[2], created_at: a[3] }; return { success: true }; }
  return undefined;
}

/** D1 batch — 실 D1 처럼 문장을 순서대로 실행(가짜 저장소에서는 원자성까지 흉내내지 않는다). */
export async function snapBatch(stmts) {
  const out = [];
  for (const st of stmts || []) out.push(await st.run());
  return out;
}
