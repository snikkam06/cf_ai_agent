import { Agent, AgentNamespace } from "agents";

export interface Env {
    CHAT_AGENT: AgentNamespace<ChatAgent>;
    AI: Ai;
    SUMMARY_WORKFLOW: {
        create(options: { id: string; params: { agentId: string } }): Promise<void>;
    };
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

export class ChatAgent extends Agent<Env> {
    private messageCountSinceUpdate = 0;
    private initialized = false;

    private ensureInitialized(): void {
        if (this.initialized) return;
        this.initializeDatabase();
        const profile = this.getProfile();
        this.messageCountSinceUpdate = profile?.message_count_since_update ?? 0;
        this.initialized = true;
    }

    private initializeDatabase(): void {
        this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `;

        this.sql`
      CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY DEFAULT 1,
        summary TEXT DEFAULT '',
        updated_at INTEGER,
        message_count_since_update INTEGER DEFAULT 0
      )
    `;

        const existing = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM profile`;
        if (existing.length === 0 || existing[0].count === 0) {
            this.sql`INSERT INTO profile (id, summary, message_count_since_update) VALUES (1, '', 0)`;
        }
    }

    async onConnect(connection: WebSocket): Promise<void> {
        this.ensureInitialized();
        console.log("Client connected to ChatAgent");

        const history = this.getRecentMessages(10);
        if (history.length > 0) {
            connection.send(JSON.stringify({
                type: "history",
                messages: history.map(m => ({ role: m.role, content: m.content }))
            } as StreamChunk));
        }

        connection.send(JSON.stringify({ type: "connected" } as StreamChunk));
    }

    async onMessage(connection: WebSocket, message: string): Promise<void> {
        this.ensureInitialized();
        try {
            const data: ChatMessage = JSON.parse(message);

            if (data.type === "user_message" && data.text) {
                await this.handleUserMessage(connection, data.text);
            }
        } catch (error) {
            console.error("Error processing message:", error);
            connection.send(JSON.stringify({
                type: "error",
                error: "Failed to process message"
            } as StreamChunk));
        }
    }

    private async handleUserMessage(connection: WebSocket, text: string): Promise<void> {
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

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split("\n").filter(line => line.startsWith("data: "));

                for (const line of lines) {
                    const jsonStr = line.slice(6);
                    if (jsonStr === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (parsed.response) {
                            fullResponse += parsed.response;
                            connection.send(JSON.stringify({
                                type: "chunk",
                                content: parsed.response
                            } as StreamChunk));
                        }
                    } catch {
                        // Skip malformed JSON chunks
                    }
                }
            }

            this.storeMessage("assistant", fullResponse);
            connection.send(JSON.stringify({ type: "done" } as StreamChunk));

            if (this.messageCountSinceUpdate >= MESSAGES_BEFORE_SUMMARY) {
                await this.triggerSummaryWorkflow();
            }

        } catch (error) {
            console.error("AI call failed:", error);
            connection.send(JSON.stringify({
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
        this.sql`INSERT INTO messages (role, content, timestamp) VALUES (${role}, ${content}, ${timestamp})`;
    }

    private getRecentMessages(limit: number): Message[] {
        const messages = this.sql<Message>`
      SELECT id, role, content, timestamp 
      FROM messages 
      ORDER BY id DESC 
      LIMIT ${limit}
    `;
        return messages.reverse();
    }

    private getProfile(): Profile | null {
        const results = this.sql<Profile>`SELECT * FROM profile WHERE id = 1`;
        return results.length > 0 ? results[0] : null;
    }

    private updateMessageCount(count: number): void {
        this.sql`UPDATE profile SET message_count_since_update = ${count} WHERE id = 1`;
    }

    private async triggerSummaryWorkflow(): Promise<void> {
        try {
            const agentId = this.name;
            await this.env.SUMMARY_WORKFLOW.create({
                id: `summary-${agentId}-${Date.now()}`,
                params: { agentId }
            });
            console.log("Summary workflow triggered");
        } catch (error) {
            console.error("Failed to trigger workflow:", error);
        }
    }

    getMessagesForSummary(): Message[] {
        return this.getRecentMessages(MESSAGES_TO_KEEP);
    }

    updateProfileSummary(summary: string): void {
        const now = Date.now();
        this.sql`UPDATE profile SET summary = ${summary}, updated_at = ${now}, message_count_since_update = 0 WHERE id = 1`;
        this.messageCountSinceUpdate = 0;
    }
}
