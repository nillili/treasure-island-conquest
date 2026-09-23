/**
 * Node 에서 src/*.ts 를 바로 읽기 위한 로더 훅.
 *
 * src 는 워커용이라 `import { x } from "./xlsx"` 처럼 확장자를 뺀다(번들러가 붙여 준다).
 * Node 의 --experimental-strip-types 는 타입만 벗길 뿐 확장자는 안 붙여 주므로,
 * 상대 경로에 확장자가 없으면 .ts 를 붙여 다시 찾는다. 그 밖에는 손대지 않는다.
 *
 *   node --experimental-strip-types --import ./tools/ts-register.mjs 스크립트.mjs
 */
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\\.[a-zA-Z0-9]+$/.test(specifier)) {
    try { return await next(specifier + ".ts", context); } catch {}
  }
  return next(specifier, context);
}`),
);
