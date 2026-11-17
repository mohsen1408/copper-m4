"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { AGENTS } from "@/lib/copper/assistant/agents";
import type {
  AgentId,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** Who answered last time (Module 4). The conversation stays with them. */
  agent?: AgentId;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

/** At most this many hand-offs per question, so two agents can't ping-pong forever. */
const MAX_HAND_OFFS = 2;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

export async function askCopper({
  messages,
  useTools,
  agent = "copper",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  // Without tools there are no agents to hand off to: it's always Copper.
  const first: AgentId = useTools ? agent : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  /** One agent answers. Returns who to hand off to, or null when it's done. */
  async function answerAs(id: AgentId): Promise<AgentId | null> {
    const current = AGENTS[id];
    let handOff: AgentId | null = null;
    // Without tools, send no instructions either: "always use your tools"
    // with no tools makes the model answer with nothing.
    const result = callStream(
      id === "copper"
        ? { module: 2, feature: "ask-copper" }
        : { module: 4, feature: "refund-agent" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        ...(useTools && {
          instructions: current.instructions,
          tools: current.tools,
          // A hand-off ends this agent's turn; the other agent answers next.
          stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(current.handOff.tool)],
        }),
      },
    );
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName === current.handOff.tool)
            handOff = current.handOff.to;
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handOff;
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      let next: AgentId | null = first;
      for (let hops = 0; next; hops++) {
        progress.agent = next;
        const handOff = await answerAs(next);
        next = handOff && hops < MAX_HAND_OFFS ? handOff : null;
        // Keep each agent's words in their own paragraph.
        if (next && progress.reply.trim()) progress.reply += "\n\n";
        update(snapshot());
      }
      progress.reply = progress.reply.trim();
      progress.status = "done";
      if (!progress.reply) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}
