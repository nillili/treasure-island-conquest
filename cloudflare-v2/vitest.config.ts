import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 경로에 한글이 있어 URL.pathname 을 그대로 쓰면 %EB.. 로 인코딩된다. fileURLToPath 로 푼다.
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// 테스트를 실제 Workers 런타임 안에서 돌린다. DO·D1 을 흉내가 아니라 진짜로 쓴다.
const migrations = await readD1Migrations(here("./migrations"));

// 엑셀 원본은 이진 파일이라 import 로 못 가져온다. base64 로 실어 보낸다.
const base64 = (rel: string) => readFileSync(here(rel)).toString("base64");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SIGNUP_CODE: "테스트가입코드",
          // 선생님이 실제로 쓰는 파일. 골든 기준이다.
          FIXTURE_XLSX: base64("../sample/보물섬점령전_DB.xlsx"),
          // 같은 파일의 정리 전 모습(퀴즈 + 숨긴 탭 2개). 시트 고르기를 확인한다.
          FIXTURE_MULTISHEET: base64("./test/fixtures/multisheet.xlsx"),
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
