"use strict";
/**
 * 방과의 연결 — WebSocket 이 기본, 안 되면 폴링으로 내려간다.
 *
 * 학교 방화벽이 WebSocket 을 막는 경우가 있다. 폴백이 없으면 그 반은 통째로 못 한다.
 * 서버는 두 길이 같은 handleAction 을 지나므로, 폴백으로 내려가도 규칙이 달라지지 않는다.
 *
 * 살아있음 확인은 문자열 "PING" 하나다. 서버가 자동으로 "PONG" 을 돌려주며
 * 이때 방(Durable Object)은 잠에서 깨지 않는다.
 */
const NET = {
  code: null,
  hello: null,
  onMessage: null,
  onStatus: null,

  ws: null,
  mode: "ws", // "ws" | "poll"
  stopped: false,
  backoff: 500,
  fails: 0,
  firstFailAt: 0,
  lastPong: 0,
  timers: { reconnect: 0, ping: 0, poll: 0, open: 0 },
};

function netClearTimers() {
  for (const key of Object.keys(NET.timers)) {
    clearTimeout(NET.timers[key]);
    NET.timers[key] = 0;
  }
}

function netStatus(kind, text) {
  if (NET.onStatus) NET.onStatus(kind, text);
}

/** 방에 붙는다. 끊기면 알아서 다시 붙고, 다시 붙는 것이 곧 전체 재동기화다. */
function netConnect(code, hello, onMessage, onStatus) {
  netClose();
  Object.assign(NET, {
    code, hello, onMessage, onStatus,
    stopped: false, mode: "ws", backoff: 500, fails: 0, firstFailAt: 0,
  });
  netOpen();
}

function netClose() {
  NET.stopped = true;
  netClearTimers();
  if (NET.ws) {
    try { NET.ws.close(); } catch { /* 이미 닫힘 */ }
    NET.ws = null;
  }
}

function netOpen() {
  if (NET.stopped) return;
  if (NET.mode === "poll") return netPollLoop();

  const url = `${location.origin.replace(/^http/, "ws")}/api/rooms/${NET.code}/ws`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return netFailed();
  }
  NET.ws = ws;
  netStatus("connecting", "연결 중…");

  // 3초 안에 안 열리면 이 자리에서는 안 되는 것이다. 폴백을 준비한다.
  NET.timers.open = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      try { ws.close(); } catch { /* 무시 */ }
    }
  }, 3000);

  ws.onopen = () => {
    clearTimeout(NET.timers.open);
    NET.backoff = 500;
    NET.fails = 0;
    NET.lastPong = Date.now();
    ws.send(JSON.stringify(NET.hello));
    netStatus("ok", "연결됨");
    netPingLoop();
  };

  ws.onmessage = (event) => {
    if (event.data === "PONG") { NET.lastPong = Date.now(); return; }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    NET.onMessage(msg);
  };

  ws.onclose = () => { if (NET.ws === ws) netFailed(); };
  ws.onerror = () => { /* onclose 가 이어서 온다 */ };
}

function netPingLoop() {
  clearTimeout(NET.timers.ping);
  NET.timers.ping = setTimeout(() => {
    if (NET.stopped || NET.mode !== "ws") return;
    // 25초 동안 답이 없으면 죽은 연결이다. 스스로 끊고 다시 붙는다.
    if (Date.now() - NET.lastPong > 25000) {
      try { NET.ws.close(); } catch { /* 무시 */ }
      return;
    }
    try { NET.ws.send("PING"); } catch { /* 곧 onclose */ }
    netPingLoop();
  }, 20000);
}

function netFailed() {
  NET.ws = null;
  netClearTimers();
  if (NET.stopped) return;

  const now = Date.now();
  if (!NET.firstFailAt || now - NET.firstFailAt > 30000) { NET.firstFailAt = now; NET.fails = 0; }
  NET.fails++;

  // 30초 안에 세 번 끊기면 이 자리에서는 WebSocket 이 안 되는 것이다. 폴링으로 내려간다.
  if (NET.fails >= 3) {
    NET.mode = "poll";
    netStatus("slow", "연결: 느림");
    return netPollLoop();
  }

  netStatus("down", "다시 연결 중…");
  NET.timers.reconnect = setTimeout(netOpen, NET.backoff + Math.random() * 250);
  NET.backoff = Math.min(NET.backoff * 2, 8000);
}

// ── 폴백 ─────────────────────────────────────────────────────────────────

async function netRpc(body) {
  const res = await fetch(`/api/rooms/${NET.code}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function netPollLoop() {
  clearTimeout(NET.timers.poll);
  NET.timers.poll = setTimeout(async () => {
    if (NET.stopped || NET.mode !== "poll") return;
    try {
      const out = await netRpc({ ...NET.hello, playerId: APP.playerId || undefined });
      if (out && out.reply) NET.onMessage(out.reply);
      else if (out && out.t === "error") NET.onMessage(out);
      netStatus("slow", "연결: 느림");
    } catch {
      netStatus("down", "서버에 연결하지 못했어요");
    }
    netPollLoop();
  }, 3000);
}

/**
 * 서버에 한 마디 보낸다.
 * WebSocket 이면 그대로, 폴백이면 같은 내용을 POST 로 보낸다.
 */
async function netSend(msg) {
  if (NET.mode === "ws" && NET.ws && NET.ws.readyState === WebSocket.OPEN) {
    NET.ws.send(JSON.stringify(msg));
    return;
  }
  const out = await netRpc({ ...msg, playerId: APP.playerId || undefined });
  if (out && out.reply) NET.onMessage(out.reply);
  else if (out && out.t === "error") NET.onMessage(out);
}

// 탭을 다시 열면 곧바로 상태를 맞춘다. 노트북 덮개를 닫았다 여는 일이 수업 중 계속 있다.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || NET.stopped) return;
  if (NET.mode === "ws" && (!NET.ws || NET.ws.readyState !== WebSocket.OPEN)) netOpen();
  else netSend({ t: "sync" });
});
