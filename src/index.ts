import { ChatAgent, Env } from "./agent";
import { SummaryWorkflow } from "./workflow";
import { routeAgentRequest } from "agents";

export { ChatAgent, SummaryWorkflow };

interface ExtendedEnv extends Env {
    ASSETS?: Fetcher;
}

export default {
    async fetch(request: Request, env: ExtendedEnv): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/ws" || url.pathname === "/ws/") {
            const sessionId = url.searchParams.get("session") || "default";

            const response = await routeAgentRequest(request, env, {
                prefix: sessionId,
            });

            if (response) {
                return response;
            }

            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/api/health") {
            return new Response(JSON.stringify({ status: "ok" }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not Found", { status: 404 });
    }
} satisfies ExportedHandler<ExtendedEnv>;
