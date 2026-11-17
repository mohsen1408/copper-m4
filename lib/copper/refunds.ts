// Module 4: the business rules for refunds, and what the refund agent's tools
// and the Refund Console call.
// The rules live here, in code, not in the refund agent's prompt: the model
// can ask for a refund, but only this file decides whether it's approved
// automatically, waits for a person, or is refused. No message can change that.
// Where the data is kept (Supabase, or memory) is lib/copper/refund-store.ts.
import { randomUUID } from "node:crypto";
import {
  type Order,
  type OrderKind,
  type Refund,
  type RefundStatus,
  refundStore,
} from "@/lib/copper/refund-store";

export {
  type Order,
  type OrderKind,
  type Refund,
  type RefundStatus,
  resetRefundStore,
} from "@/lib/copper/refund-store";

const DAY = 24 * 60 * 60 * 1000;

export async function getAutoRefundLimit(): Promise<number> {
  return refundStore().limit();
}

/** The highest limit staff can set, so a typo can't auto-approve everything. */
export const MAX_AUTO_REFUND_LIMIT_USD = 1000;

/**
 * Staff change the auto-refund limit on the Refund Console. 0 sends every
 * refund to a person. Only new requests use the new limit.
 */
export async function setAutoRefundLimit(
  value: number,
): Promise<{ ok: true; limitUsd: number } | { ok: false; message: string }> {
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: "The limit must be a number, $0 or more." };
  }
  if (value > MAX_AUTO_REFUND_LIMIT_USD) {
    return {
      ok: false,
      message: `The limit can't be more than $${MAX_AUTO_REFUND_LIMIT_USD}.`,
    };
  }
  const limitUsd = Math.round(value * 100) / 100;
  await refundStore().setLimit(limitUsd);
  return { ok: true, limitUsd };
}

// ---------------------------------------------------------------------------
// The rules (Product Bible Section 9, plus the auto-refund limit)
// ---------------------------------------------------------------------------

/** How many days after the order a refund can be asked for, by kind. */
export const REFUND_WINDOW_DAYS: Record<OrderKind, number | null> = {
  device: 30, // Returns Policy: 30-day return window for devices
  plus_annual: 14, // Copper Plus Terms: annual plans refundable within 14 days
  plus_monthly: null, // Copper Plus Terms: monthly plans are not refunded for partial months
};

export type RefundDecision =
  | { allowed: true; status: "approved" | "pending" }
  | { allowed: false; reason: string };

const ALREADY_REFUNDED =
  "This order already has a refund (approved or waiting for review).";

/** Decides what happens to a refund request. Pure: no data is changed. */
export function decideRefund(
  order: Order,
  existing: Refund[],
  limitUsd: number,
  now = Date.now(),
): RefundDecision {
  if (
    existing.some((r) => r.order_id === order.id && r.status !== "rejected")
  ) {
    return { allowed: false, reason: ALREADY_REFUNDED };
  }
  const window = REFUND_WINDOW_DAYS[order.kind];
  if (window === null) {
    return {
      allowed: false,
      reason:
        "Monthly Copper Plus plans are not refunded for partial months. The customer can cancel anytime so they aren't charged again.",
    };
  }
  const days = (now - new Date(order.ordered_at).getTime()) / DAY;
  if (days > window) {
    return {
      allowed: false,
      reason:
        order.kind === "device"
          ? "Devices can be returned within 30 days of the order. This order is older than that."
          : "Annual Copper Plus plans are refundable within 14 days. This order is older than that.",
    };
  }
  return {
    allowed: true,
    status: order.amount_usd <= limitUsd ? "approved" : "pending",
  };
}

// ---------------------------------------------------------------------------
// What the refund agent's tools and the Refund Console call
// ---------------------------------------------------------------------------

const sameEmail = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const digits = (orderId: string) => orderId.replace(/\D/g, "");

/** The newest refund for an order, if it has one. */
const latestRefund = (refunds: Refund[], orderId: string) =>
  refunds
    .filter((r) => r.order_id === orderId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);

export type OrderSummary = Pick<
  Order,
  "id" | "product" | "amount_usd" | "kind" | "ordered_at"
> & { refund_status: RefundStatus | null };

export type OrdersResult =
  | { status: "found"; orders: OrderSummary[] }
  | { status: "not_found"; message: string };

/** get_orders: a customer's orders, found by their email (and an order number, if given). */
export async function getOrders(input: {
  email: string;
  orderId?: string;
}): Promise<OrdersResult> {
  const store = refundStore();
  const [allOrders, refunds] = await Promise.all([
    store.orders(),
    store.refunds(),
  ]);
  const orders = allOrders
    .filter(
      (o) =>
        sameEmail(o.customer_email, input.email) &&
        (!input.orderId || o.id === digits(input.orderId)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (orders.length === 0) {
    return {
      status: "not_found",
      message:
        "No order matches that email and order number. Ask the customer to check both.",
    };
  }
  return {
    status: "found",
    orders: orders.map(({ id, product, amount_usd, kind, ordered_at }) => ({
      id,
      product,
      amount_usd,
      kind,
      ordered_at,
      refund_status: latestRefund(refunds, id)?.status ?? null,
    })),
  };
}

export type RefundRequestResult =
  | {
      status: "approved" | "pending";
      refundId: string;
      orderId: string;
      product: string;
      amountUsd: number;
      message: string;
    }
  | { status: "refused"; orderId: string; message: string };

/** request_refund: asks for a refund. The rules above decide the outcome. */
export async function requestRefund(
  input: { email: string; orderId: string; reason: string },
  now = Date.now(),
): Promise<RefundRequestResult> {
  const store = refundStore();
  const orderId = digits(input.orderId);
  const [orders, refunds, limitUsd] = await Promise.all([
    store.orders(),
    store.refunds(),
    store.limit(),
  ]);
  const order = orders.find(
    (o) => o.id === orderId && sameEmail(o.customer_email, input.email),
  );
  if (!order) {
    return {
      status: "refused",
      orderId,
      message: "No order matches that email and order number.",
    };
  }
  const decision = decideRefund(order, refunds, limitUsd, now);
  if (!decision.allowed) {
    return { status: "refused", orderId, message: decision.reason };
  }
  const at = new Date(now).toISOString();
  const refund: Refund = {
    id: `r-${randomUUID().slice(0, 8)}`,
    order_id: order.id,
    amount_usd: order.amount_usd,
    reason: input.reason.trim() || "No reason given",
    status: decision.status,
    decided_by: decision.status === "approved" ? "auto" : null,
    created_at: at,
    decided_at: decision.status === "approved" ? at : null,
  };
  // The store refuses a second open refund too, in case two requests for the
  // same order arrive at the same moment.
  if (!(await store.addRefund(refund))) {
    return { status: "refused", orderId, message: ALREADY_REFUNDED };
  }
  return {
    status: decision.status,
    refundId: refund.id,
    orderId: order.id,
    product: order.product,
    amountUsd: order.amount_usd,
    message:
      decision.status === "approved"
        ? `Refund of $${order.amount_usd} approved. It goes back to the original payment method.`
        : `Refunds over $${limitUsd} need a person to review them. A Copper Crew team member will approve or reject it.`,
  };
}

export type RefundRow = Refund & {
  product: string;
  customer_email: string;
};

/** Every refund, newest first, with its order's product and customer. */
export async function listRefunds(): Promise<RefundRow[]> {
  const store = refundStore();
  const [orders, refunds] = await Promise.all([
    store.orders(),
    store.refunds(),
  ]);
  return refunds
    .map((r) => {
      const order = orders.find((o) => o.id === r.order_id);
      return {
        ...r,
        product: order?.product ?? "Unknown order",
        customer_email: order?.customer_email ?? "",
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export type RefundUpdate = {
  refundId: string;
  orderId: string;
  product: string;
  amountUsd: number;
  status: RefundStatus;
};

/** The current status of some refunds, so the chat can tell the customer. */
export async function getRefundStatuses(
  refundIds: string[],
): Promise<RefundUpdate[]> {
  return (await listRefunds())
    .filter((r) => refundIds.includes(r.id))
    .map((r) => ({
      refundId: r.id,
      orderId: r.order_id,
      product: r.product,
      amountUsd: r.amount_usd,
      status: r.status,
    }));
}

/** A staff member approves or rejects a pending refund. */
export async function decidePendingRefund(
  refundId: string,
  decision: "approved" | "rejected",
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; message: string }> {
  const decided = await refundStore().decidePending(refundId, {
    status: decision,
    decided_by: "staff",
    decided_at: new Date(now).toISOString(),
  });
  return decided
    ? { ok: true }
    : {
        ok: false,
        message: "That refund doesn't exist or has already been decided.",
      };
}
