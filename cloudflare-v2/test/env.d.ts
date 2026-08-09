// 테스트에서만 쓰는 바인딩. vitest.config.ts 의 miniflare.bindings 로 들어온다.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    FIXTURE_XLSX: string; // base64
    FIXTURE_MULTISHEET: string; // base64
  }
}
