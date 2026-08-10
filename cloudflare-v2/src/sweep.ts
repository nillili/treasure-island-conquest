/**
 * 어제 이전에 만든 방을 자동으로 닫는다.
 *
 * 상주하는 데몬이 없다. 워커는 요청이 올 때만 깨어나므로,
 * **선생님이 들어오는 순간이 유일한 청소 기회**다. 그래서 로그인·가입과
 * 선생님 홈에서 한 번씩 돌린다(만료 세션을 로그인 때 함께 치우는 것과 같은 방식).
 *
 * 방 하나하나에는 이미 "3시간 조용하면 스스로 닫는다"는 알람이 걸려 있다.
 * 그런데 그 알람은 DO 가 살아 있어야 도는 것이라, 어쩌다 놓친 방이 D1 목록에
 * 'ready' 로 남아 있을 수 있다. 이 청소가 그것까지 걷어 간다.
 *
 * 기준은 **날짜**다(하루가 지나면). 한국 시각으로 오늘 0시보다 먼저 만들어진 방을 닫는다.
 * 만든 사람이 누구인지는 보지 않는다 — 어제 방은 어차피 아무도 안 쓴다.
 */

/** 워커는 UTC 로 돈다. 한국은 UTC+9 이고 서머타임이 없어서 이렇게 곧장 계산할 수 있다. */
const KST_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** 한국 시각으로 오늘 0시. 이보다 먼저 만들어진 방이 청소 대상이다. */
export function startOfTodayKST(now: number = Date.now()): number {
  return Math.floor((now + KST_OFFSET) / DAY) * DAY - KST_OFFSET;
}

/**
 * 한 번에 손대는 방 수. 선생님이 로그인을 기다리는 동안 도는 일이라 짧아야 한다.
 * 남은 것은 다음 로그인이 가져간다 — 하루에 20개를 넘길 일은 없다.
 */
const SWEEP_LIMIT = 20;

/** 닫은 방번호를 돌려준다. 닫을 게 없으면 빈 배열이고, 이때는 SELECT 한 번으로 끝난다. */
export async function sweepStaleRooms(env: Env): Promise<string[]> {
  const cutoff = startOfTodayKST();
  const { results } = await env.DB.prepare(
    "SELECT code FROM rooms WHERE status != 'closed' AND created_at < ? LIMIT ?",
  )
    .bind(cutoff, SWEEP_LIMIT)
    .all<{ code: string }>();
  if (!results.length) return [];

  const closed: string[] = [];
  for (const r of results) {
    try {
      // 아직 붙어 있는 학생에게 알리고 방 안을 비운다. 방이 이미 사라졌으면 아무 일도 안 한다.
      await env.ROOM.getByName(r.code).closeNow();
      closed.push(r.code);
    } catch {
      /* 이 방은 D1 에서만 닫는다 — 아래 UPDATE 가 받아 준다 */
    }
  }

  // DO 호출이 실패한 방까지 목록에서는 확실히 내린다.
  await env.DB.prepare(
    "UPDATE rooms SET status = 'closed', closed_at = ? WHERE status != 'closed' AND created_at < ?",
  )
    .bind(Date.now(), cutoff)
    .run();

  return closed;
}
