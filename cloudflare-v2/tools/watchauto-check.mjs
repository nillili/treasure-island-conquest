/**
 * 감시 런처가 그물이 끊겨도 살아 있는지 본다.
 *
 *   node tools/watchauto-check.mjs
 *
 * 2026-09-01 에 이걸로 물렸다. login() 의 fetch 에 catch 가 없어서, 무선이 잠깐
 * 끊기면 예외가 위로 올라가 런처가 통째로 죽었다 — 하루에 79번. systemd 가 10초 뒤
 * 되살리긴 하지만, 그 사이 붙어 있던 watch.mjs 도 함께 끊긴다. 수업 중이었다면
 * 그 10초는 기록이 비고, 다시 붙기까지 더 걸린다.
 *
 * 검사 방법은 흉내가 아니라 진짜다. 가짜 서버를 띄워 런처를 붙인 뒤, 서버를 꺼서
 * 그물을 끊고, 그래도 런처가 살아 있는지 본다.
 *
 * 고친 것이 진짜인지 보려면 watch-auto.mjs 의 login() 에서 try/catch 를 빼 보라.
 * 이 검사가 실패해야 맞다.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SURVIVE_MS = 14000; // POLL_MS(5초) 를 두 번 넘게 돌아야 findRoom → login 이 실제로 걸린다

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let hits = 0;
const sockets = new Set();

const server = createServer((req, res) => {
  hits += 1;
  if (req.url?.startsWith("/api/auth/login")) {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=fake-check-cookie; Path=/" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, rooms: [] }));
});
server.on("connection", (s) => {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});

await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./watch-auto.mjs", import.meta.url))],
  {
    stdio: "ignore",
    env: {
      ...process.env,
      WATCH_BASE: `http://127.0.0.1:${port}`,
      WATCH_ID: "검사용",
      WATCH_PW: "검사용",
    },
  },
);

const fail = (why) => {
  child.kill("SIGKILL");
  server.close();
  for (const s of sockets) s.destroy();
  console.error(`❌ ${why}`);
  process.exit(1);
};

// 런처가 실제로 대기 고리에 들어갔는지 먼저 확인한다. 안 들어갔으면 검사 자체가 헛것이다.
for (let waited = 0; hits < 2; waited += 200) {
  if (waited > 15000) fail("런처가 가짜 서버에 붙지 못했습니다 — 검사가 성립하지 않습니다.");
  if (child.exitCode !== null) fail(`런처가 붙기도 전에 죽었습니다 (exit ${child.exitCode}).`);
  await sleep(200);
}
console.log(`· 런처가 가짜 서버에 붙었습니다 (요청 ${hits}번). 이제 그물을 끊습니다.`);

// 그물을 끊는다. 열린 연결까지 끊어야 fetch 가 실제로 예외를 던진다.
server.close();
for (const s of sockets) s.destroy();

await sleep(SURVIVE_MS);

if (child.exitCode !== null) {
  console.error(`❌ 그물이 끊기자 런처가 죽었습니다 (exit ${child.exitCode}).`);
  console.error("   login() 의 fetch 예외가 위로 새고 있습니다. try/catch 를 확인하세요.");
  process.exit(1);
}

child.kill("SIGKILL");
console.log(`✅ 그물을 ${SURVIVE_MS / 1000}초 끊어도 런처는 살아 있습니다.`);
process.exit(0); // app.js 의 타이머가 계속 돌아 저절로 끝나지 않는다
