import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// 테스트마다 D1·DO 를 완전히 비우고 스키마를 다시 올린다.
// 이렇게 하지 않으면 앞 테스트가 만든 선생님·방·퀴즈가 뒤 테스트에 남아
// 서로 간섭하고, 정작 진짜 버그를 가린다.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
