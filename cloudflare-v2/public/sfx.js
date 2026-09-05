"use strict";
/**
 * 효과음.
 *
 * 음원 파일이 없다. 소리를 그때그때 **계산해서** 만든다(Web Audio).
 * 그렇게 한 이유:
 *  · 교실 와이파이. 배경 그림 하나가 이미 2.1MB 다. 여기에 mp3 를 더 얹고 싶지 않았다.
 *  · 캐시 사고가 없다. 파일이 없으니 옛 소리가 남을 일도 없다.
 *  · 음높이·길이를 코드로 만지니, 마음에 안 들면 숫자 하나만 고치면 된다.
 *
 * 지키는 규칙 —
 *  ① **소리는 절대 게임을 막지 않는다.** 오디오가 안 되는 기기(무음 스위치, 옛 브라우저,
 *     권한 거부)에서도 수업은 그대로 굴러가야 한다. 그래서 이 파일의 모든 진입점은
 *     try 로 감싸고, 실패하면 조용히 아무 일도 안 한 것처럼 넘어간다.
 *  ② **첫 소리는 사람이 화면을 건드린 뒤에야 난다.** 브라우저 규칙이다. 그래서
 *     AudioContext 를 미리 만들지 않고, 첫 클릭·터치·키 입력 때 만들어 깨운다(unlock).
 *  ③ **끄면 꺼진 채로 기억한다.** 25명이 동시에 소리를 내면 교실이 아수라장이 된다.
 *     학생 화면은 기본 꺼짐, 선생님 화면은 기본 켜짐이다(setDefault 로 정한다).
 */
(function () {
  const KEY = "treasure.sfx"; // localStorage — 껐다 켠 상태를 기억한다

  const S = {
    ctx: null,
    master: null,
    on: null,        // null = 아직 안 정함(setDefault 가 채운다)
    volume: 0.7,
    ready: false,    // 소리를 낼 수 있는 상태인가(제스처 후)
  };

  /* ── 바닥 공사 ─────────────────────────────────────────────────────────── */

  function ctx() {
    if (S.ctx) return S.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    S.ctx = new AC();
    S.master = S.ctx.createGain();
    S.master.gain.value = S.volume;
    S.master.connect(S.ctx.destination);
    return S.ctx;
  }

  /**
   * 울림. 이 파일에서 제일 중요한 부분이다.
   *
   * 처음 만든 소리는 "이게 뭐지" 싶게 들렸다. 길이가 짧아서만이 아니었다 —
   * **울림이 없었다.** 아무 공간도 없는 곳에서 난 소리는 아무리 예쁜 음이어도
   * 전자음처럼 얄팍하게 들린다. 교실은 벽이 있는 방이고, 게임 소리는 방에서 나야 한다.
   *
   * 방 울림을 흉내 내려면 그 방에서 손뼉을 친 녹음(임펄스 응답)이 필요한데,
   * 그건 파일이다. 파일을 안 쓰기로 했으니 **잡음을 지수로 깎아서** 만들어 쓴다.
   * 진짜 홀 울림만큼 곱지는 않지만, 소리에 몸통을 주기에는 충분하다.
   */
  function reverb() {
    if (S.verb) return S.verb;
    const c = S.ctx;
    const dur = 1.6;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        // 뒤로 갈수록 빨리 잦아든다. 지수를 키우면 좁은 방, 줄이면 큰 홀이 된다.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.4);
      }
    }
    const conv = c.createConvolver();
    conv.buffer = buf;
    const wet = c.createGain();
    wet.gain.value = 0.9; // 울림 총량. 소리마다 얼마나 보낼지는 verb 값으로 따로 정한다.
    conv.connect(wet);
    wet.connect(S.master);
    S.verb = conv;
    return conv;
  }

  /**
   * 소리를 깨운다. 사용자가 화면을 건드린 순간에 부른다.
   *
   * 브라우저는 클릭 전에 만든 AudioContext 를 "suspended" 로 잠가 둔다. 이걸 안 풀면
   * 첫 정답 소리가 통째로 사라지고, 그 다음부터만 들린다 — 제일 중요한 순간에 조용하다.
   */
  function unlock() {
    try {
      const c = ctx();
      if (!c) return;
      if (c.state === "suspended") c.resume();
      S.ready = c.state === "running" || c.state === "suspended";
    } catch (_) { /* 소리는 게임을 막지 않는다 */ }
  }

  /* ── 소리를 만드는 연장 ────────────────────────────────────────────────── */

  /** 음 하나. from→to 로 음높이를 미끄러뜨릴 수 있다. */
  function tone(t0, o) {
    const c = S.ctx;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.type || "sine";
    const from = o.from, to = o.to == null ? o.from : o.to;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + o.dur);

    const peak = (o.gain == null ? 0.3 : o.gain);
    const atk = o.attack == null ? 0.006 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    // 지수 감쇠라야 종·마림바처럼 들린다. 직선으로 줄이면 뚝 끊기는 전자음이 된다.
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    let out = g;
    if (o.lp) { // 부드럽게 깎기
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = o.lp;
      g.connect(f);
      out = f;
    }
    osc.connect(g);
    out.connect(S.master);
    // 마른 소리와 울림을 같이 낸다. verb 는 "얼마나 방으로 보낼까" 다.
    if (o.verb) {
      const send = c.createGain();
      send.gain.value = o.verb;
      out.connect(send);
      send.connect(reverb());
    }
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.02);
  }

  /** 잡음 한 줌. 폭풍·타격처럼 음높이가 없는 소리에 쓴다. */
  function noise(t0, o) {
    const c = S.ctx;
    const n = Math.floor(c.sampleRate * o.dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    const src = c.createBufferSource();
    src.buffer = buf;

    const g = c.createGain();
    const peak = o.gain == null ? 0.2 : o.gain;
    const atk = o.attack == null ? 0.01 : o.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    let head = src;
    if (o.filter) {
      const f = c.createBiquadFilter();
      f.type = o.filter.type || "bandpass";
      f.Q.value = o.filter.Q == null ? 1 : o.filter.Q;
      f.frequency.setValueAtTime(o.filter.from, t0);
      if (o.filter.mid != null) {
        f.frequency.exponentialRampToValueAtTime(o.filter.mid, t0 + o.dur * 0.45);
        f.frequency.exponentialRampToValueAtTime(o.filter.to, t0 + o.dur);
      } else if (o.filter.to != null) {
        f.frequency.exponentialRampToValueAtTime(o.filter.to, t0 + o.dur);
      }
      src.connect(f);
      head = f;
    }
    head.connect(g);
    g.connect(S.master);
    if (o.verb) {
      const send = c.createGain();
      send.gain.value = o.verb;
      g.connect(send);
      send.connect(reverb());
    }
    src.start(t0);
    src.stop(t0 + o.dur + 0.02);
  }

  /* ── 소리 목록 ─────────────────────────────────────────────────────────── */
  /*
   * 음높이는 실제 음이름을 쓴다(A4=440 기준). 숫자를 눈으로 읽을 수 있어야
   * "조금 더 밝게" 같은 주문을 고칠 수 있다.
   */
  const N = {
    C5: 523.25, E5: 659.25, G5: 784.0, A5: 880.0, B5: 987.77,
    C6: 1046.5, D6: 1174.7, E6: 1318.5, G6: 1568.0, C7: 2093.0,
  };

  const DEFS = {
    /**
     * 정답 — 세 걸음 올라가고, 마지막 음을 길게 남긴다.
     *
     * 처음엔 두 음 0.4초였는데 "이게 뭐지" 싶게 지나갔다. 소리가 끝나기 전에
     * 아이가 "아 맞았구나" 를 느낄 틈이 있어야 한다. 마지막 음의 여운이 그 틈이다.
     */
    correct(t) {
      const arp = [N.G5, N.C6, N.E6];
      arp.forEach((f, i) => {
        const at = t + i * 0.085;
        const last = i === arp.length - 1;
        tone(at, { type: "triangle", from: f, dur: last ? 0.78 : 0.30, gain: 0.30, verb: 0.30 });
        tone(at, { type: "sine", from: f * 2, dur: last ? 0.46 : 0.18, gain: 0.09, verb: 0.20 });
      });
    },

    /** 오답 — 두 걸음 내려앉는다. 낮게 남는 울림이 "아쉽다" 를 만든다. 혼내지는 않는다. */
    wrong(t) {
      tone(t, { type: "sawtooth", from: 233, to: 220, dur: 0.26, gain: 0.20, lp: 820, attack: 0.015, verb: 0.18 });
      tone(t + 0.17, { type: "sawtooth", from: 175, to: 164, dur: 0.58, gain: 0.19, lp: 700, attack: 0.015, verb: 0.28 });
      tone(t + 0.17, { type: "sine", from: 87, dur: 0.66, gain: 0.15, verb: 0.18 });
    },

    /** 보물 — 위로 흩어지는 반짝임. 이 게임에서 제일 기분 좋은 순간이니 제일 길다. */
    treasure(t) {
      const arp = [N.C6, N.E6, N.G6, N.C7];
      arp.forEach((f, i) => {
        const at = t + i * 0.075;
        const last = i === arp.length - 1;
        tone(at, { type: "sine", from: f, dur: last ? 0.92 : 0.50, gain: 0.26, attack: 0.004, verb: 0.42 });
        tone(at, { type: "triangle", from: f * 1.004, dur: last ? 0.50 : 0.28, gain: 0.08, verb: 0.30 });
      });
      // 꼬리에 뿌리는 가루. 음을 흩어 놓아야 "반짝" 으로 들린다.
      for (let i = 0; i < 9; i++) {
        tone(t + 0.30 + i * 0.075, {
          type: "sine", from: 1700 + Math.random() * 2200, dur: 0.32, gain: 0.065, attack: 0.003, verb: 0.50,
        });
      }
    },

    /** 폭풍 — 낮게 깔리는 바람에 천둥 한 번. 한 판 쉬는 벌이니 길고 무겁게. */
    storm(t) {
      noise(t, {
        dur: 1.60, gain: 0.20, attack: 0.25, verb: 0.35,
        filter: { type: "bandpass", from: 380, mid: 1400, to: 220, Q: 0.8 },
      });
      tone(t, { type: "sine", from: 75, to: 40, dur: 1.75, gain: 0.24, attack: 0.20, verb: 0.25 });
      tone(t + 0.40, { type: "sawtooth", from: 132, to: 88, dur: 1.00, gain: 0.07, lp: 380, verb: 0.30 });
      noise(t + 0.15, {
        dur: 0.55, gain: 0.14, attack: 0.005, verb: 0.50,
        filter: { type: "lowpass", from: 900, to: 180, Q: 0.5 },
      });
    },

    /** 공격권 — 때리고, 금속이 남아 운다. 뒤에 "가져올 칸 고르기" 가 이어진다. */
    attack(t) {
      noise(t, { dur: 0.10, gain: 0.28, attack: 0.001, verb: 0.35, filter: { type: "highpass", from: 1300, Q: 0.7 } });
      tone(t, { type: "sine", from: 180, to: 42, dur: 0.40, gain: 0.40, attack: 0.001, verb: 0.20 });
      tone(t + 0.01, { type: "square", from: 340, to: 210, dur: 0.16, gain: 0.10, lp: 1900, verb: 0.30 });
      tone(t + 0.03, { type: "triangle", from: 520, to: 430, dur: 0.78, gain: 0.10, verb: 0.55 });
      tone(t + 0.03, { type: "triangle", from: 790, to: 660, dur: 0.60, gain: 0.06, verb: 0.50 });
    },

    /** 내 차례 — 종 하나가 길게 운다. 고개를 들고 화면을 보게 하는 소리다. */
    myturn(t) {
      tone(t, { type: "sine", from: N.A5, dur: 1.32, gain: 0.28, attack: 0.012, verb: 0.45 });
      tone(t, { type: "sine", from: N.A5 * 1.5, dur: 0.95, gain: 0.10, attack: 0.012, verb: 0.40 });
      tone(t, { type: "sine", from: N.A5 * 3, dur: 0.50, gain: 0.045, attack: 0.010, verb: 0.35 });
      tone(t + 0.005, { type: "triangle", from: N.A5 * 2, dur: 0.26, gain: 0.05, verb: 0.30 });
    },

    /** 남은 시간 — 째깍. 이것만은 짧아야 한다. 여러 번 울리는 소리다. */
    tick(t) {
      tone(t, { type: "square", from: 1350, dur: 0.042, gain: 0.10, attack: 0.001, lp: 2600, verb: 0.15 });
    },

    /** 땅 점령 — 말뚝을 박고, 박힌 자리가 잠깐 운다. */
    claim(t) {
      tone(t, { type: "triangle", from: 560, to: 720, dur: 0.14, gain: 0.22, attack: 0.003, verb: 0.30 });
      noise(t, { dur: 0.05, gain: 0.07, attack: 0.001, verb: 0.25, filter: { type: "highpass", from: 2100 } });
      tone(t + 0.02, { type: "sine", from: 720, dur: 0.44, gain: 0.10, attack: 0.005, verb: 0.45 });
    },

    /** 게임 끝 — 팡파르. 점수판을 보는 동안 화음이 길게 남는다. */
    gameover(t) {
      const seq = [N.C5, N.E5, N.G5, N.C6];
      seq.forEach((f, i) => {
        tone(t + i * 0.15, { type: "triangle", from: f, dur: 0.36, gain: 0.26, verb: 0.35 });
        tone(t + i * 0.15, { type: "square", from: f * 2, dur: 0.20, gain: 0.05, lp: 3200, verb: 0.25 });
      });
      // 마지막에 화음을 통째로 쌓아 길게 남긴다.
      const last = t + 0.60;
      for (const f of seq) tone(last, { type: "triangle", from: f, dur: 1.90, gain: 0.15, attack: 0.025, verb: 0.50 });
      tone(last, { type: "sine", from: N.C5 / 2, dur: 2.00, gain: 0.12, attack: 0.030, verb: 0.40 });
    },
  };

  /* ── 바깥에서 쓰는 것 ──────────────────────────────────────────────────── */

  /**
   * 소리를 낸다. 이름이 없거나 오디오가 안 되면 조용히 넘어간다.
   * 게임 코드에서는 결과를 보지 않는다 — 소리가 안 났다고 할 일이 달라지지 않는다.
   */
  function play(name) {
    try {
      if (S.on === false) return;
      const def = DEFS[name];
      if (!def) return;
      const c = ctx();
      if (!c) return;
      if (c.state === "suspended") c.resume();
      if (c.state !== "running") return; // 아직 안 깨어났다. 억지로 내지 않는다.
      def(c.currentTime + 0.02); // 아주 살짝 미뤄야 첫 파형이 잘리지 않는다
    } catch (_) { /* 소리는 게임을 막지 않는다 */ }
  }

  /** 켜기/끄기. 기억한다. */
  function setEnabled(on) {
    S.on = !!on;
    try { localStorage.setItem(KEY, S.on ? "1" : "0"); } catch (_) {}
    if (S.on) unlock();
    return S.on;
  }

  /**
   * 기본값을 정한다. 사용자가 한 번이라도 껐다 켠 적이 있으면 그 선택이 이긴다.
   * 선생님 화면은 켬, 학생 화면은 끔 — 25명이 동시에 울리면 수업이 안 된다.
   */
  function setDefault(on) {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (_) {}
    S.on = saved === null ? !!on : saved === "1";
    return S.on;
  }

  function setVolume(v) {
    S.volume = Math.max(0, Math.min(1, v));
    if (S.master) S.master.gain.value = S.volume;
    return S.volume;
  }

  // 첫 접촉에 깨운다. 한 번이면 되니 once 로 붙인다.
  for (const ev of ["pointerdown", "touchstart", "keydown"]) {
    window.addEventListener(ev, unlock, { once: true, passive: true });
  }

  window.SFX = {
    play, unlock, setEnabled, setDefault, setVolume,
    get enabled() { return S.on !== false; },
    get volume() { return S.volume; },
    names: Object.keys(DEFS),
  };
})();
