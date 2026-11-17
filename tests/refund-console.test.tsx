// Module 4: the Refund Console shows refunds waiting for a person and lets
// staff approve or reject them.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefundStore } from "@/lib/copper/refunds";

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
  };
});

beforeEach(() => resetRefundStore());
afterEach(cleanup);

describe("Refund Console", () => {
  it("lists the pending refund and the automatic decision, with the $50 limit", async () => {
    const { RefundConsole } =
      await import("@/components/copper/refund-console");
    render(<RefundConsole />);
    const pending = await screen.findByTestId("pending-refunds");
    expect(within(pending).getByText(/Waiting for review \(1\)/)).toBeVisible();
    expect(within(pending).getByText(/1008 Copper Notes/)).toBeVisible();
    const decided = screen.getByTestId("decided-refunds");
    expect(within(decided).getByText("Automatic")).toBeVisible();
    expect(screen.getAllByText(/\$50/).length).toBeGreaterThan(0);
  });

  it("Approve moves the refund to Recent decisions, decided by staff", async () => {
    const { RefundConsole } =
      await import("@/components/copper/refund-console");
    render(<RefundConsole />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Approve refund for order 1008",
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("pending-refunds")).getByText(
          "Nothing to review right now.",
        ),
      ).toBeVisible(),
    );
    expect(
      within(screen.getByTestId("decided-refunds")).getByText("Staff"),
    ).toBeVisible();
  });
});
