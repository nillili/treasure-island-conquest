/**
 * 화면과 방 사이에 오가는 말.
 *
 * 규칙 하나만 지키면 화면이 서버와 어긋나지 않는다.
 *   stateRev 는 **정본이 바뀐 메시지**(state · patch · turn)에만 붙는다.
 *   화면은 받은 값이  = 내 rev  → 이미 반영함(무시)
 *                    = 내 rev+1 → 적용
 *                    > 내 rev+1 → 놓친 게 있다 → sync
 * quiz · result · error · presence · pong 은 정본을 바꾸지 않으므로 순번을 달지 않는다.
 * serverNow 는 모든 메시지에 붙는다(화면이 자기 시계와의 차이를 보정한다).
 */
import type { CellType, Team } from "./game";

export type ClientMessage =
  | { t: "hello"; role: "student" | "teacher"; playerId?: string; name?: string }
  | { t: "pick"; cell: number; actionId: string }
  | { t: "answer"; cell: number; choice: number; actionId: string }
  /** 공격칸으로 얻은 권리를 써서 상대 땅 하나를 가져온다. 고르는 범위는 판 전체다. */
  | { t: "steal"; cell: number; actionId: string }
  | { t: "cancel"; actionId: string }
  | { t: "cmd"; cmd: string; actionId: string; [key: string]: unknown }
  | { t: "peek"; cell: number }
  | { t: "sync" };

export interface PublicCell {
  /** 임자 없는 칸은 종류를 감춘다. 선생님 화면에는 그대로 보낸다. */
  t: CellType | "?";
  o: Team | null;
}

export interface PublicPlayer {
  id: string;
  name: string;
  team: Team;
  pos: number | null;
}

export interface Scores {
  H: { territory: number; bonus: number; total: number };
  C: { territory: number; bonus: number; total: number };
}

export interface LogEntry {
  at: number;
  name: string;
  team: Team;
  cell: number;
  ok: boolean;
  gain: number;
  type: CellType;
  /** 실제로 받은 보물 보너스. 그 팀이 이미 받은 칸이면 0 이다. */
  bonus: number;
  /** 공격으로 실제 빼앗은 상대 칸. 빼앗을 땅이 없었으면 null. */
  stolen: number | null;
}

/**
 * 3D 무대에 올릴 연출 종류. **서버는 이 키만 정하고 한국어 문구와 그림은 화면이 고른다.**
 * 문구를 다듬는다고 서버 프로토콜을 건드리지 않기 위해서다.
 *
 * 종류를 여섯으로 쪼갠 이유는 하나다 — **연출은 정본이 실제로 바꾼 것만 말해야 한다.**
 * 보너스를 안 줬으면 +2 라고 하지 않고, 빼앗은 땅이 없으면 빼앗았다고 하지 않는다.
 * 교사가 보드와 연출 중 어느 쪽을 믿어야 할지 모르게 되는 순간 이 기능은 없느니만 못하다.
 */
export type FxKind =
  | "treasure-bonus" // 📦 실제로 +2 를 받았다
  | "treasure-claim" // 📦 보물칸이지만 그 팀이 이미 받은 칸이라 점령만 했다
  | "attack-steal" // 💥 상대 땅을 실제로 빼앗았다
  | "attack-claim" // 💥 공격칸인데 빼앗을 상대 땅이 없었다
  | "storm"; // ⛈️ 폭풍 — 다음 턴 쉼

export interface TurnFx {
  turnKey: string; // "H:3" — 같은 턴을 두 번 뜨지 않게 하는 열쇠이기도 하다
  round: number;
  /** 일반 칸을 차지한 사람 수. 이름은 쓰지 않는다. */
  normal: number;
  /** 연출 종류 → 그 일을 한 사람들. 없는 종류는 키 자체가 없다. */
  names: Partial<Record<FxKind, string[]>>;
}

/** 화면이 못 누른 이유로 분기할 수 있게 code 를 함께 보낸다. */
export interface ErrorMessage {
  t: "error";
  code: string;
  msg: string;
  serverNow: number;
}

/**
 * 끝난 판에 남는 이상 징후. 관제 화면이 "오류 여부" 로 읽는다.
 * 사람 이름은 담지 않는다 — 몇 명인지까지만 센다.
 */
export interface GameIssue {
  kind: "server-error" | "short" | "empty" | "no-answer" | "stalled" | "offline";
  level: "warn" | "error";
  detail: string;
}

export const ERROR_CODES = {
  needHello: "need-hello",
  notOwner: "not-owner",
  noRoom: "no-room",
  noPlayer: "no-player",
  notRunning: "not-running",
  notMyTurn: "not-my-turn",
  skipping: "skipping",
  alreadyPlayed: "already-played",
  timeUp: "time-up",
  tooFar: "too-far",
  cellBusy: "cell-busy",
  noQuiz: "no-quiz",
  noAttempt: "no-attempt",
  roomFull: "room-full",
  conflict: "action-conflict",
} as const;
