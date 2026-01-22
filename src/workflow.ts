import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { ChatAgent, Env } from "./agent";

interface SummaryWorkflowParams {
    agentId: string;
}

interface WorkflowEnv extends Env {
    AI: Ai;
}

export class SummaryWorkflow extends WorkflowEntrypoint<WorkflowEnv, SummaryWorkflowParams> {
    async run(event: WorkflowEvent<SummaryWorkflowParams>, step: WorkflowStep): Promise<void> {
        const agentId = event.payload.agentId;

        const messages = await step.do("fetch-recent-messages", async () => {
            const id = this.env.CHAT_AGENT.idFromName(agentId);
            const stub = this.env.CHAT_AGENT.get(id);
            const agent = stub as unknown as ChatAgent;
            return agent.getMessagesForSummary();
        });

        if (!messages || messages.length === 0) {
            console.log("No messages to summarize");
            return;
        }

        const conversationText = messages
            .map(m => `${m.role}: ${m.content}`)
            .join("\n");

        const summary = await step.do("generate-summary", async () => {
            const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: [
                    {
                        role: "system",
                        content: `You are a memory summarization assistant. Analyze the conversation and extract key facts about the user that should be remembered for future conversations.

Focus on:
- User preferences and interests
- Important personal details they've shared
- Recurring topics or themes
- Communication style preferences

Output a concise summary (max 200 words) of the most important facts to remember. Use bullet points.`
                    },
                    {
                        role: "user",
                        content: `Summarize the key facts about the user from this conversation:\n\n${conversationText}`
                    }
                ],
                max_tokens: 300
            }) as { response: string };

            return response.response;
        });

        await step.do("update-profile", async () => {
            const id = this.env.CHAT_AGENT.idFromName(agentId);
            const stub = this.env.CHAT_AGENT.get(id);
            const agent = stub as unknown as ChatAgent;
            agent.updateProfileSummary(summary);
            console.log("Profile summary updated");
        });
    }
}
