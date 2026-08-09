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
}

/** 화면이 못 누른 이유로 분기할 수 있게 code 를 함께 보낸다. */
export interface ErrorMessage {
  t: "error";
  code: string;
  msg: string;
  serverNow: number;
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
