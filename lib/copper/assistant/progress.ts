// What Ask Copper is doing, step by step, as it streams in: Gemini's thinking
// summaries, each tool call (with what went in and what came out), and the
// reply. The panel draws this as it changes.

export type ThinkingStep = { type: "thinking"; text: string };

export type ToolStep = {
  type: "tool";
  id: string;
  name: string;
  /** "calling" until the tool's result comes back. */
  state: "calling" | "done" | "error";
  input?: unknown;
  output?: unknown;
};

export type Step = ThinkingStep | ToolStep;

/** Who is answering: Copper, or the refund agent Copper handed off to (Module 4). */
export type AgentId = "copper" | "refund";

export type Progress = {
  steps: Step[];
  reply: string;
  status: "working" | "done" | "error";
  /** The agent answering at the end. The next question goes to the same agent. */
  agent?: AgentId;
};

/** Every tool call in an answer, in order. */
export function toolCallsOf(progress: Progress) {
  return progress.steps
    .filter((step): step is ToolStep => step.type === "tool")
    .map(({ name, input, output }) => ({ name, input, output }));
}

/**
 * The tools Copper can use, and what each one does in plain English. The chat
 * panel lists these, so it lives here (and not in tools.ts, which reads the
 * database and can't be imported by a client component).
 */
export const TOOL_LABELS: Record<string, string> = {
  get_products: "Listing the products",
  get_prices: "Looking up prices",
  calculate_cost: "Working out the cost",
  check_availability: "Checking stock",
  search_docs: "Searching the documents",
  transfer_to_refund_agent: "Handing you to the refund agent",
  get_orders: "Looking up your orders",
  request_refund: "Asking for the refund",
  transfer_to_copper: "Handing you back to Copper",
};

/** Each agent's name and tools, for the chat panel (Module 4). */
export const AGENT_INFO: Record<AgentId, { name: string; tools: string[] }> = {
  copper: {
    name: "Copper",
    tools: [
      "get_products",
      "get_prices",
      "calculate_cost",
      "check_availability",
      "search_docs",
      "transfer_to_refund_agent",
    ],
  },
  refund: {
    name: "Refund agent",
    tools: ["get_orders", "request_refund", "transfer_to_copper"],
  },
};
