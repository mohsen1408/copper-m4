// Module 4: the refund rules live in code (lib/copper/refunds.ts), so these
// checks need no AI. They prove the limit and the policy windows hold no
// matter what anyone types in the chat.
import { beforeEach, describe, expect, it } from "vitest";
import {
  decidePendingRefund,
  decideRefund,
  getAutoRefundLimit,
  getOrders,
  listRefunds,
  type Order,
  requestRefund,
  resetRefundStore,
} from "@/lib/copper/refunds";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "9001",
  customer_email: "test@example.com",
  product: "Copper Home",
  amount_usd: 149,
  kind: "device",
  ordered_at: new Date(NOW - 3 * DAY).toISOString(),
  ...overrides,
});

beforeEach(() => resetRefundStore(NOW));

describe("decideRefund: the rules", () => {
  it("approves a refund at or under the limit automatically", () => {
    expect(decideRefund(order({ amount_usd: 50 }), [], 50, NOW)).toEqual({
      allowed: true,
      status: "approved",
    });
  });

  it("sends a refund over the limit to a person", () => {
    expect(decideRefund(order({ amount_usd: 50.01 }), [], 50, NOW)).toEqual({
      allowed: true,
      status: "pending",
    });
  });

  it("refuses a device after 30 days and an annual plan after 14", () => {
    const oldDevice = order({
      ordered_at: new Date(NOW - 31 * DAY).toISOString(),
    });
    const oldPlan = order({
      kind: "plus_annual",
      amount_usd: 79,
      ordered_at: new Date(NOW - 15 * DAY).toISOString(),
    });
    expect(decideRefund(oldDevice, [], 50, NOW)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/30 days/),
    });
    expect(decideRefund(oldPlan, [], 50, NOW)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/14 days/),
    });
  });

  it("never refunds a monthly Copper Plus plan for a partial month", () => {
    const monthly = order({ kind: "plus_monthly", amount_usd: 7.99 });
    expect(decideRefund(monthly, [], 50, NOW)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/partial months/),
    });
  });
});

describe("requestRefund and the data", () => {
  it("reads the limit from settings ($50)", () => {
    expect(getAutoRefundLimit()).toBe(50);
  });

  it("approves order 1001 ($24) automatically and records it", () => {
    const result = requestRefund(
      { email: "Sam@Example.com", orderId: "#1001", reason: "Broken" },
      NOW,
    );
    expect(result).toMatchObject({ status: "approved", amountUsd: 24 });
    expect(listRefunds()[0]).toMatchObject({
      order_id: "1001",
      status: "approved",
      decided_by: "auto",
    });
  });

  it("puts order 1002 ($149) in the pending queue", () => {
    expect(
      requestRefund(
        { email: "sam@example.com", orderId: "1002", reason: "Too big" },
        NOW,
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("refuses a second refund on the same order", () => {
    const ask = () =>
      requestRefund(
        { email: "sam@example.com", orderId: "1001", reason: "x" },
        NOW,
      );
    ask();
    expect(ask()).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/already has a refund/),
    });
  });

  it("refuses an order that belongs to someone else", () => {
    expect(
      requestRefund(
        { email: "riley@example.com", orderId: "1001", reason: "x" },
        NOW,
      ),
    ).toMatchObject({ status: "refused" });
  });

  it("refuses orders outside their window (1004, 1005) and monthly plans (1006)", () => {
    for (const [email, orderId] of [
      ["jordan@example.com", "1004"],
      ["riley@example.com", "1005"],
      ["riley@example.com", "1006"],
    ]) {
      expect(requestRefund({ email, orderId, reason: "x" }, NOW).status).toBe(
        "refused",
      );
    }
  });
});

describe("getOrders", () => {
  it("finds a customer's orders by email, with any refund", () => {
    const result = getOrders({ email: "casey@example.com" });
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.orders.map((o) => [o.id, o.refund_status])).toEqual([
      ["1007", "approved"],
      ["1008", "pending"],
    ]);
  });

  it("finds nothing for an unknown email or order", () => {
    expect(getOrders({ email: "nobody@example.com" }).status).toBe("not_found");
    expect(
      getOrders({ email: "sam@example.com", orderId: "1005" }).status,
    ).toBe("not_found");
  });
});

describe("decidePendingRefund: the staff decision", () => {
  it("lets staff approve or reject a pending refund, once", () => {
    const pending = listRefunds().find((r) => r.status === "pending")!;
    expect(decidePendingRefund(pending.id, "rejected", NOW)).toEqual({
      ok: true,
    });
    expect(listRefunds().find((r) => r.id === pending.id)).toMatchObject({
      status: "rejected",
      decided_by: "staff",
    });
    expect(decidePendingRefund(pending.id, "approved", NOW)).toMatchObject({
      ok: false,
    });
  });
});
