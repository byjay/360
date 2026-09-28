// [WO 20260928 격리수정] tests/ 여러 파일(p42-cdp-real, p59, p60, p62, p65)이 각자
// http.createServer(...).listen(0, ...) 로 OS 임의 포트를 받는다. Windows 이 머신의 TCP
// 동적 포트 범위는 1024~14999(netsh int ipv4 show dynamicport tcp 실측)인데, 이 범위 안에
// WHATWG Fetch 명세의 "bad port"(예: 10080)가 다수 포함돼 있다 — undici(Node 내장 fetch)와
// Chrome(puppeteer navigate)가 모두 이 포트로의 접속을 ERR_UNSAFE_PORT / "bad port" 로 거부한다.
// 재현: node --test tests/ 반복 실행 시 p60(ERR_UNSAFE_PORT at :10080)·p62(fetch failed: bad port)
// 가 간헐적으로 실패 — 원인은 port:0 이 우연히 bad port 를 뽑는 것(고정 포트가 아니라 "나쁜
// 무작위 포트"가 근본원인). 이 헬퍼로 bad port 가 뽑히면 서버를 닫고 재시도해 항상 안전한
// 포트만 반환한다. 목록 출처: node_modules/undici/lib/web/fetch/constants.js (badPorts) —
// https://fetch.spec.whatwg.org/#block-bad-port. 브라우저(Chrome)도 동일 계열 목록을 쓴다.
const BAD_PORTS = new Set([
  "1", "7", "9", "11", "13", "15", "17", "19", "20", "21", "22", "23", "25", "37", "42", "43", "53", "69", "77", "79",
  "87", "95", "101", "102", "103", "104", "109", "110", "111", "113", "115", "117", "119", "123", "135", "137",
  "139", "143", "161", "179", "389", "427", "465", "512", "513", "514", "515", "526", "530", "531", "532",
  "540", "548", "554", "556", "563", "587", "601", "636", "989", "990", "993", "995", "1719", "1720", "1723",
  "2049", "3659", "4045", "4190", "5060", "5061", "6000", "6566", "6665", "6666", "6667", "6668", "6669", "6679",
  "6697", "10080",
]);

/**
 * server.listen(0, host) 를 감싸 bad port 가 뽑히면 자동 재시도한다.
 * @param {import('node:http').Server} server
 * @param {string} [host]
 * @returns {Promise<import('node:http').Server>} 안전한 포트에 바인딩된 동일 server
 */
export function listenSafePort(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    let settled = false;
    function attempt() {
      const onError = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      server.once("error", onError);
      server.listen(0, host, () => {
        server.removeListener("error", onError);
        const port = server.address().port;
        if (BAD_PORTS.has(String(port))) {
          server.close(() => attempt());
          return;
        }
        if (!settled) {
          settled = true;
          resolve(server);
        }
      });
    }
    attempt();
  });
}
