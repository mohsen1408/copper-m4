// Module 4: the refund rules live in code (lib/copper/refunds.ts), so these
// checks need no AI. They prove the limit and the policy windows hold no
// matter what anyone types in the chat.
import { beforeEach, describe, expect, it } from "vitest";
import {
  decidePendingRefund,
  decideRefund,
  getAutoRefundLimit,
  getOrders,
  getRefundStatuses,
  listRefunds,
  type Order,
  requestRefund,
  resetRefundStore,
  setAutoRefundLimit,
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
  it("approves a refund at or under the limit automatically", async () => {
    expect(decideRefund(order({ amount_usd: 50 }), [], 50, NOW)).toEqual({
      allowed: true,
      status: "approved",
    });
  });

  it("sends a refund over the limit to a person", async () => {
    expect(decideRefund(order({ amount_usd: 50.01 }), [], 50, NOW)).toEqual({
      allowed: true,
      status: "pending",
    });
  });

  it("refuses a device after 30 days and an annual plan after 14", async () => {
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

  it("never refunds a monthly Copper Plus plan for a partial month", async () => {
    const monthly = order({ kind: "plus_monthly", amount_usd: 7.99 });
    expect(decideRefund(monthly, [], 50, NOW)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/partial months/),
    });
  });
});

describe("requestRefund and the data", () => {
  it("reads the limit from settings ($50)", async () => {
    expect(await getAutoRefundLimit()).toBe(50);
  });

  it("approves order 1001 ($24) automatically and records it", async () => {
    const result = await requestRefund(
      { email: "Sam@Example.com", orderId: "#1001", reason: "Broken" },
      NOW,
    );
    expect(result).toMatchObject({ status: "approved", amountUsd: 24 });
    expect((await listRefunds())[0]).toMatchObject({
      order_id: "1001",
      status: "approved",
      decided_by: "auto",
    });
  });

  it("puts order 1002 ($149) in the pending queue", async () => {
    expect(
      await requestRefund(
        { email: "sam@example.com", orderId: "1002", reason: "Too big" },
        NOW,
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("refuses a second refund on the same order", async () => {
    const ask = async () =>
      await requestRefund(
        { email: "sam@example.com", orderId: "1001", reason: "x" },
        NOW,
      );
    await ask();
    expect(await ask()).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/already has a refund/),
    });
  });

  it("refuses an order that belongs to someone else", async () => {
    expect(
      await requestRefund(
        { email: "riley@example.com", orderId: "1001", reason: "x" },
        NOW,
      ),
    ).toMatchObject({ status: "refused" });
  });

  it("refuses orders outside their window (1004, 1005) and monthly plans (1006)", async () => {
    for (const [email, orderId] of [
      ["jordan@example.com", "1004"],
      ["riley@example.com", "1005"],
      ["riley@example.com", "1006"],
    ]) {
      expect(
        (await requestRefund({ email, orderId, reason: "x" }, NOW)).status,
      ).toBe("refused");
    }
  });
});

describe("getOrders", () => {
  it("finds a customer's orders by email, with any refund", async () => {
    const result = await getOrders({ email: "casey@example.com" });
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.orders.map((o) => [o.id, o.refund_status])).toEqual([
      ["1007", "approved"],
      ["1008", "pending"],
    ]);
  });

  it("finds nothing for an unknown email or order", async () => {
    expect((await getOrders({ email: "nobody@example.com" })).status).toBe(
      "not_found",
    );
    expect(
      (await getOrders({ email: "sam@example.com", orderId: "1005" })).status,
    ).toBe("not_found");
  });
});

describe("decidePendingRefund: the staff decision", () => {
  it("lets staff approve or reject a pending refund, once", async () => {
    const pending = (await listRefunds()).find((r) => r.status === "pending")!;
    expect(await decidePendingRefund(pending.id, "rejected", NOW)).toEqual({
      ok: true,
    });
    expect(
      (await listRefunds()).find((r) => r.id === pending.id),
    ).toMatchObject({
      status: "rejected",
      decided_by: "staff",
    });
    expect(
      await decidePendingRefund(pending.id, "approved", NOW),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("setAutoRefundLimit: staff change the limit", () => {
  it("at $0, even a $24 refund waits for a person", async () => {
    expect(await setAutoRefundLimit(0)).toEqual({ ok: true, limitUsd: 0 });
    expect(
      (
        await requestRefund(
          { email: "sam@example.com", orderId: "1001", reason: "x" },
          NOW,
        )
      ).status,
    ).toBe("pending");
  });

  it("refuses a negative, missing or huge limit and keeps $50", async () => {
    for (const value of [-1, Number.NaN, 5000]) {
      expect((await setAutoRefundLimit(value)).ok).toBe(false);
    }
    expect(await getAutoRefundLimit()).toBe(50);
  });

  it("reports staff decisions so the chat can tell the customer", async () => {
    const pending = (await listRefunds()).find((r) => r.status === "pending")!;
    await decidePendingRefund(pending.id, "approved", NOW);
    expect(await getRefundStatuses([pending.id])).toEqual([
      expect.objectContaining({ refundId: pending.id, status: "approved" }),
    ]);
  });
});
