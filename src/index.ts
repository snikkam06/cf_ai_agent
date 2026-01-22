import { ChatAgent, Env } from "./agent";
import { SummaryWorkflow } from "./workflow";

export { ChatAgent, SummaryWorkflow };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // Handle WebSocket upgrade for chat
        if (url.pathname === "/ws" || url.pathname === "/ws/") {
            const upgradeHeader = request.headers.get("Upgrade");
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
                return new Response("Expected WebSocket upgrade", { status: 426 });
            }

            const sessionId = url.searchParams.get("session") || "default";

            // Get the Durable Object instance for this session
            const id = env.CHAT_AGENT.idFromName(sessionId);
            const stub = env.CHAT_AGENT.get(id);

            // Forward the WebSocket request to the Durable Object
            return stub.fetch(request);
        }

        // Health check endpoint
        if (url.pathname === "/api/health") {
            return new Response(JSON.stringify({ status: "ok" }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Serve static assets
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("Not Found", { status: 404 });
    }
} satisfies ExportedHandler<Env>;
