// Module 4: staff can change the auto-refund limit on the Refund Console, and
// the chat tells the customer when staff decide their pending refund.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLive } from "@/lib/ai/live";
import type { Progress } from "@/lib/copper/assistant/progress";
import {
  decidePendingRefund,
  getAutoRefundLimit,
  listRefunds,
  requestRefund,
  resetRefundStore,
} from "@/lib/copper/refunds";

// The server actions run as plain functions in the test.
vi.mock("@/lib/copper/refund-console", async () => {
  const refunds = await import("@/lib/copper/refunds");
  return {
    loadRefundQueue: async () => ({
      limitUsd: await refunds.getAutoRefundLimit(),
      refunds: await refunds.listRefunds(),
      where: "memory",
    }),
    decideRefund: async (id: string, decision: "approved" | "rejected") =>
      refunds.decidePendingRefund(id, decision),
    updateRefundLimit: async (value: number) =>
      refunds.setAutoRefundLimit(value),
    checkRefunds: async (ids: string[]) => refunds.getRefundStatuses(ids),
  };
});

beforeEach(() => resetRefundStore());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/copper/assistant/ask");
  vi.resetModules();
});

describe("Refund Console: the limit", () => {
  it("staff set the limit to $0 and it's saved", async () => {
    const { RefundConsole } =
      await import("@/components/copper/refund-console");
    render(<RefundConsole />);
    const card = await screen.findByTestId("refund-limit");
    expect(within(card).getByText(/Auto-refund limit: \$50/)).toBeVisible();
    fireEvent.change(within(card).getByLabelText("New limit (USD)"), {
      target: { value: "0" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save limit" }));
    await waitFor(() =>
      expect(within(card).getByText(/Auto-refund limit: \$0/)).toBeVisible(),
    );
    expect(await getAutoRefundLimit()).toBe(0);
  });

  it("a negative limit is refused with a message", async () => {
    const { RefundConsole } =
      await import("@/components/copper/refund-console");
    render(<RefundConsole />);
    const card = await screen.findByTestId("refund-limit");
    fireEvent.change(within(card).getByLabelText("New limit (USD)"), {
      target: { value: "-5" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Save limit" }));
    expect(await within(card).findByRole("status")).toHaveTextContent(
      /\$0 or more/,
    );
    expect(await getAutoRefundLimit()).toBe(50);
  });
});

describe("Ask Copper: the customer hears the decision", () => {
  it("shows an update in the chat when staff approve the pending refund", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    // The refund agent asks for a $149 refund, which waits for a person.
    const askCopper = vi.fn().mockImplementation(async () => {
      const output = await requestRefund({
        email: "sam@example.com",
        orderId: "1002",
        reason: "Scratched",
      });
      const live = createLive<Progress>();
      live.done({
        steps: [
          {
            type: "tool",
            id: "call-1",
            name: "request_refund",
            state: "done",
            agent: "refund",
            output,
          },
        ],
        reply: "A team member will review it.",
        status: "done",
        agent: "refund",
      });
      return { progress: live.live };
    });
    vi.doMock("@/lib/copper/assistant/ask", () => ({ askCopper }));
    const { AskCopper } = await import("@/components/copper/ask-copper");
    render(<AskCopper aiConfigured docked />);
    const chat = within(await screen.findByTestId("ask-copper"));
    fireEvent.change(chat.getByLabelText("Your question"), {
      target: { value: "Refund order 1002, sam@example.com" },
    });
    fireEvent.click(chat.getByRole("button", { name: /send/i }));
    await chat.findByText("A team member will review it.");

    // Staff approve it on the console.
    const pending = (await listRefunds()).find(
      (r) => r.order_id === "1002" && r.status === "pending",
    )!;
    await decidePendingRefund(pending.id, "approved");
    await vi.advanceTimersByTimeAsync(6000);

    const notice = await chat.findByTestId("refund-notice");
    expect(notice).toHaveTextContent(/approved your refund of \$149/);
    expect(notice).toHaveTextContent(/order 1002/);

    // The update is part of the conversation the model sees next time.
    fireEvent.change(chat.getByLabelText("Your question"), {
      target: { value: "Thanks!" },
    });
    fireEvent.click(chat.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(askCopper).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(askCopper.mock.calls[1][0].messages)).toMatch(
      /approved your refund/,
    );
    expect(askCopper.mock.calls[1][0].agent).toBe("refund");
  });
});
