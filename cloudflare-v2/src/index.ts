import { handleAdmin } from "./admin";
import { handleAuth, handleAuthPages } from "./auth";
import { handleDiagnose } from "./diagnose";
import { fail } from "./http";
import { handleQuizSets } from "./quizsets";
import { RoomDO } from "./room";
import { handleRooms } from "./rooms";

export { RoomDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    // 브라우저가 지나가는 네오버스 로그인 길. JSON 이 아니라 이동과 화면으로 답한다.
    if (path.startsWith("/auth/")) return handleAuthPages(request, env, path);
    if (path.startsWith("/api/auth/")) return handleAuth(request, env, path);
    if (path.startsWith("/api/admin/")) return handleAdmin(request, env, path);
    if (path === "/api/diagnose") return handleDiagnose(request, env);
    if (path.startsWith("/api/quizsets")) return handleQuizSets(request, env, path);
    if (path.startsWith("/api/rooms")) return handleRooms(request, env, path);
    if (path.startsWith("/api/")) return fail("아직 만들지 않은 기능입니다.", 404);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
