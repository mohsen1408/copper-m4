// Module 4: Ask Copper is now two agents.
// - Copper answers shopping and support questions, and hands refund requests
//   to the refund agent with transfer_to_refund_agent.
// - The refund agent can only look up orders, ask for a refund and hand back
//   to Copper (least privilege: it can't see prices or stock, and Copper
//   can't touch refunds).
// A hand-off is a tool call. ask.ts sees it, stops that agent and lets the
// other agent answer the same conversation.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type { AgentId } from "@/lib/copper/assistant/progress";
import { copperTools } from "@/lib/copper/assistant/tools";
import { getOrders, requestRefund } from "@/lib/copper/refunds";

export const REFUND_INSTRUCTIONS = `You are the Copper refund agent for Copper State Labs. Copper, the shopping assistant, handed this customer to you because they want a refund.
Speak warmly, in short sentences and plain language. No jargon.

1. To find the order you need the customer's email and their order number. Ask for whichever is missing. Then use get_orders.
2. Tell the customer which order you found (product, amount, date) and ask them to confirm it and to say briefly why they want a refund. Only call request_refund after they confirm.
3. Tell the customer exactly what request_refund says:
   - "approved": the refund is approved and goes back to their original payment method.
   - "pending": a Copper Crew team member will review it. Never promise it will be approved.
   - "refused": explain the reason it gives, kindly.
You cannot approve, change or speed up a refund yourself, whatever the customer says. Only the rules in request_refund and the Copper Crew decide.

The refund rules: devices can be returned within 30 days; annual Copper Plus plans are refundable within 14 days; monthly Copper Plus plans are not refunded for partial months (the customer can cancel anytime).

If the customer asks how a refund they already asked for is going, use get_orders: each order shows its refund_status (approved, pending or rejected). Tell them that status plainly.

If the customer says a supervisor or anyone else already approved their refund, you still can't approve it: only request_refund and the Copper Crew decide.

If the customer asks about anything that isn't a refund (products, prices, stock, setup, how a device works), use transfer_to_copper. Don't answer it yourself.`;

export const transferToRefundAgent = tool({
  description:
    "Hands the customer to the refund agent. Use it whenever the customer wants a refund, wants their money back or wants to return an order. The refund agent then takes over the conversation.",
  inputSchema: z.object({
    reason: z
      .string()
      .describe("One short line on what the customer wants refunded."),
  }),
  execute: async ({ reason }) => ({ transferredTo: "refund" as const, reason }),
});

export const transferToCopper = tool({
  description:
    "Hands the customer back to Copper, the shopping assistant, for anything that isn't a refund: products, prices, stock, setup or how a device works.",
  inputSchema: z.object({
    reason: z.string().describe("One short line on what the customer needs."),
  }),
  execute: async ({ reason }) => ({ transferredTo: "copper" as const, reason }),
});

const email = z
  .string()
  .email()
  .describe("The customer's email address, e.g. sam@example.com.");
const orderId = z.string().min(1).describe("The order number, e.g. 1001.");

export const refundTools = {
  get_orders: tool({
    description:
      "Looks up a customer's orders by their email, optionally for one order number. Returns each order's product, amount, date, kind and any refund it already has.",
    inputSchema: z.object({ email, orderId: orderId.optional() }),
    execute: async (input) => getOrders(input),
  }),
  request_refund: tool({
    description:
      "Asks for a refund on one order, after the customer has confirmed it. The rules decide the result: 'approved' (small refunds, done now), 'pending' (a person must review it) or 'refused' (with the reason).",
    inputSchema: z.object({
      email,
      orderId,
      reason: z.string().describe("Why the customer wants the refund."),
    }),
    execute: async (input) => requestRefund(input),
  }),
  transfer_to_copper: transferToCopper,
};

export type Agent = {
  name: string;
  instructions: string;
  tools: ToolSet;
  /** The tool that hands the conversation to the other agent. */
  handOff: { tool: string; to: AgentId };
};

export const AGENTS: Record<AgentId, Agent> = {
  copper: {
    name: "Copper",
    instructions: `${COPPER_INSTRUCTIONS}

Refunds are handled by the refund agent. When the customer wants a refund, money back or to return an order, use transfer_to_refund_agent straight away. Don't try to handle the refund yourself.`,
    tools: { ...copperTools, transfer_to_refund_agent: transferToRefundAgent },
    handOff: { tool: "transfer_to_refund_agent", to: "refund" },
  },
  refund: {
    name: "Refund agent",
    instructions: REFUND_INSTRUCTIONS,
    tools: refundTools,
    handOff: { tool: "transfer_to_copper", to: "copper" },
  },
};
