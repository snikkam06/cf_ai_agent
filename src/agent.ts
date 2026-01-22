import { DurableObject } from "cloudflare:workers";

export interface Env {
    CHAT_AGENT: DurableObjectNamespace<ChatAgent>;
    AI: Ai;
    SUMMARY_WORKFLOW: {
        create(options: { id: string; params: { agentId: string } }): Promise<void>;
    };
    ASSETS?: Fetcher;
}

interface Message {
    id: number;
    role: string;
    content: string;
    timestamp: number;
}

interface Profile {
    id: number;
    summary: string;
    updated_at: number | null;
    message_count_since_update: number;
}

interface ChatMessage {
    type: "user_message" | "system";
    text?: string;
}

interface StreamChunk {
    type: "chunk" | "done" | "error" | "history" | "connected";
    content?: string;
    error?: string;
    messages?: Array<{ role: string; content: string }>;
}

const SYSTEM_PROMPT = `You are a helpful, friendly AI assistant in a real-time chat application.

Key behaviors:
- Be concise but thorough in your responses
- Remember context from earlier in the conversation
- If profile memory is provided, use it to personalize responses
- Ask clarifying questions when the user's intent is unclear
- Be conversational and engaging

You are powered by Llama 3.3 running on Cloudflare Workers AI.`;

const MESSAGES_TO_KEEP = 30;
const MESSAGES_BEFORE_SUMMARY = 8;

export class ChatAgent extends DurableObject<Env> {
    private messageCountSinceUpdate = 0;
    private initialized = false;
    private sqlStorage: SqlStorage;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sqlStorage = ctx.storage.sql;
    }

    private ensureInitialized(): void {
        if (this.initialized) return;
        this.initializeDatabase();
        const profile = this.getProfile();
        this.messageCountSinceUpdate = profile?.message_count_since_update ?? 0;
        this.initialized = true;
    }

    private initializeDatabase(): void {
        this.sqlStorage.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);

        this.sqlStorage.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY DEFAULT 1,
        summary TEXT DEFAULT '',
        updated_at INTEGER,
        message_count_since_update INTEGER DEFAULT 0
      )
    `);

        const existing = this.sqlStorage.exec("SELECT COUNT(*) as count FROM profile").toArray();
        if (existing.length === 0 || (existing[0] as { count: number }).count === 0) {
            this.sqlStorage.exec("INSERT INTO profile (id, summary, message_count_since_update) VALUES (1, '', 0)");
        }
    }

    async fetch(request: Request): Promise<Response> {
        this.ensureInitialized();

        const url = new URL(request.url);

        // Internal API for workflow to get messages
        if (url.pathname === "/getMessages") {
            const messages = this.getRecentMessages(MESSAGES_TO_KEEP);
            return new Response(JSON.stringify(messages), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Internal API for workflow to update profile
        if (url.pathname === "/updateProfile" && request.method === "POST") {
            const body = await request.json() as { summary: string };
            this.updateProfileSummary(body.summary);
            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Handle WebSocket upgrade
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.ctx.acceptWebSocket(server);

        const history = this.getRecentMessages(10);
        if (history.length > 0) {
            server.send(JSON.stringify({
                type: "history",
                messages: history.map(m => ({ role: m.role, content: m.content }))
            } as StreamChunk));
        }

        server.send(JSON.stringify({ type: "connected" } as StreamChunk));

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        this.ensureInitialized();

        if (typeof message !== "string") {
            return;
        }

        try {
            const data: ChatMessage = JSON.parse(message);

            if (data.type === "user_message" && data.text) {
                await this.handleUserMessage(ws, data.text);
            }
        } catch (error) {
            console.error("Error processing message:", error);
            ws.send(JSON.stringify({
                type: "error",
                error: "Failed to process message"
            } as StreamChunk));
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
        console.log(`WebSocket closed: ${code} - ${reason} - wasClean: ${wasClean}`);
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        console.error("WebSocket error:", error);
    }

    private async handleUserMessage(ws: WebSocket, text: string): Promise<void> {
        this.storeMessage("user", text);
        this.messageCountSinceUpdate++;
        this.updateMessageCount(this.messageCountSinceUpdate);

        const recentMessages = this.getRecentMessages(MESSAGES_TO_KEEP);
        const profile = this.getProfile();

        const messages = this.buildPromptMessages(recentMessages, profile);

        try {
            const stream = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages,
                stream: true,
                max_tokens: 1024,
            });

            let fullResponse = "";
            const reader = (stream as ReadableStream).getReader();
            const decoder = new TextDecoder();

            let buffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");

                // Keep the last line in the buffer as it might be incomplete
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;

                    const jsonStr = line.slice(6).trim();
                    if (jsonStr === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            ws.send(JSON.stringify({
                                type: "chunk",
                                content: parsed.response
                            } as StreamChunk));
                        }
                    } catch (e) {
                        console.error("Error parsing JSON chunk:", e);
                    }
                }
            }

            this.storeMessage("assistant", fullResponse);
            ws.send(JSON.stringify({ type: "done" } as StreamChunk));

            if (this.messageCountSinceUpdate >= MESSAGES_BEFORE_SUMMARY) {
                await this.triggerSummaryWorkflow();
            }

        } catch (error) {
            console.error("AI call failed:", error);
            ws.send(JSON.stringify({
                type: "error",
                error: "Failed to generate response"
            } as StreamChunk));
        }
    }

    private buildPromptMessages(
        recentMessages: Message[],
        profile: Profile | null
    ): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        let systemContent = SYSTEM_PROMPT;
        if (profile?.summary) {
            systemContent += `\n\nProfile Memory (key facts about this user):\n${profile.summary}`;
        }
        messages.push({ role: "system", content: systemContent });

        for (const msg of recentMessages) {
            messages.push({ role: msg.role, content: msg.content });
        }

        return messages;
    }

    private storeMessage(role: string, content: string): void {
        const timestamp = Date.now();
        this.sqlStorage.exec(
            "INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)",
            role, content, timestamp
        );
    }

    private getRecentMessages(limit: number): Message[] {
        const cursor = this.sqlStorage.exec(
            "SELECT id, role, content, timestamp FROM messages ORDER BY id DESC LIMIT ?",
            limit
        );
        const messages = cursor.toArray() as unknown as Message[];
        return messages.reverse();
    }

    private getProfile(): Profile | null {
        const cursor = this.sqlStorage.exec("SELECT * FROM profile WHERE id = 1");
        const results = cursor.toArray() as unknown as Profile[];
        return results.length > 0 ? results[0] : null;
    }

    private updateMessageCount(count: number): void {
        this.sqlStorage.exec(
            "UPDATE profile SET message_count_since_update = ? WHERE id = 1",
            count
        );
    }

    private async triggerSummaryWorkflow(): Promise<void> {
        try {
            const agentId = this.ctx.id.toString();
            await this.env.SUMMARY_WORKFLOW.create({
                id: `summary-${agentId}-${Date.now()}`,
                params: { agentId }
            });
            console.log("Summary workflow triggered");
        } catch (error) {
            console.error("Failed to trigger workflow:", error);
        }
    }

    private updateProfileSummary(summary: string): void {
        const now = Date.now();
        this.sqlStorage.exec(
            "UPDATE profile SET summary = ?, updated_at = ?, message_count_since_update = 0 WHERE id = 1",
            summary, now
        );
        this.messageCountSinceUpdate = 0;
    }
}
