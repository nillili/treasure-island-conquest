import { handleAuth } from "./auth";
import { handleDiagnose } from "./diagnose";
import { fail } from "./http";
import { handleQuizSets } from "./quizsets";
import { RoomDO } from "./room";
import { handleRooms } from "./rooms";

export { RoomDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path.startsWith("/api/auth/")) return handleAuth(request, env, path);
    if (path === "/api/diagnose") return handleDiagnose(request, env);
    if (path.startsWith("/api/quizsets")) return handleQuizSets(request, env, path);
    if (path.startsWith("/api/rooms")) return handleRooms(request, env, path);
    if (path.startsWith("/api/")) return fail("아직 만들지 않은 기능입니다.", 404);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
