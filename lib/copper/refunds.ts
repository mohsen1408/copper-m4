// Module 4: orders and refunds, and the business rules for refunds.
// The rules live here, in code, not in the refund agent's prompt: the model
// can ask for a refund, but only this file decides whether it's approved
// automatically, waits for a person, or is refused. No message can change that.
//
// The data is kept in memory, seeded from data/orders.json (made-up orders),
// so the demo works with no database. This is the only file that knows where
// orders and refunds are kept, so moving them to Supabase later means changing
// only the store below.
import seed from "@/lib/copper/data/orders.json";

export type OrderKind = "device" | "plus_monthly" | "plus_annual";

export type Order = {
  id: string;
  customer_email: string;
  product: string;
  amount_usd: number;
  kind: OrderKind;
  ordered_at: string;
};

export type RefundStatus = "approved" | "pending" | "rejected";

export type Refund = {
  id: string;
  order_id: string;
  amount_usd: number;
  reason: string;
  status: RefundStatus;
  /** "auto" when the rule approved it, "staff" when a person decided. */
  decided_by: "auto" | "staff" | null;
  created_at: string;
  decided_at: string | null;
};

type Store = {
  orders: Order[];
  refunds: Refund[];
  settings: { auto_refund_limit_usd: number };
  nextId: number;
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, now: number) =>
  new Date(now - days * DAY).toISOString();

/** A fresh copy of the made-up data, with dates counted back from now. */
export function seedStore(now = Date.now()): Store {
  return {
    orders: seed.orders.map(({ days_ago, ...order }) => ({
      ...order,
      kind: order.kind as OrderKind,
      ordered_at: daysAgo(days_ago, now),
    })),
    refunds: seed.refunds.map(({ days_ago, ...refund }) => ({
      ...refund,
      status: refund.status as RefundStatus,
      decided_by: refund.decided_by as Refund["decided_by"],
      created_at: daysAgo(days_ago, now),
      decided_at: refund.status === "pending" ? null : daysAgo(days_ago, now),
    })),
    settings: { ...seed.settings },
    nextId: seed.refunds.length + 1,
  };
}

// Kept on globalThis so the chat and the Refund Console share one copy, even
// after the dev server reloads a file.
const holder = globalThis as unknown as { copperRefundStore?: Store };
function store(): Store {
  return (holder.copperRefundStore ??= seedStore());
}

/** Starts over with the made-up data (used by tests). */
export function resetRefundStore(now = Date.now()) {
  holder.copperRefundStore = seedStore(now);
}

export function getAutoRefundLimit(): number {
  return store().settings.auto_refund_limit_usd;
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
    return {
      allowed: false,
      reason:
        "This order already has a refund (approved or waiting for review).",
    };
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

const refundOf = (orderId: string) =>
  store()
    .refunds.filter((r) => r.order_id === orderId)
    .at(-1);

export type OrderSummary = Pick<
  Order,
  "id" | "product" | "amount_usd" | "kind" | "ordered_at"
> & { refund_status: RefundStatus | null };

export type OrdersResult =
  | { status: "found"; orders: OrderSummary[] }
  | { status: "not_found"; message: string };

/** get_orders: a customer's orders, found by their email (and an order number, if given). */
export function getOrders(input: {
  email: string;
  orderId?: string;
}): OrdersResult {
  const orders = store().orders.filter(
    (o) =>
      sameEmail(o.customer_email, input.email) &&
      (!input.orderId || o.id === input.orderId.replace(/\D/g, "")),
  );
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
      refund_status: refundOf(id)?.status ?? null,
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
export function requestRefund(
  input: { email: string; orderId: string; reason: string },
  now = Date.now(),
): RefundRequestResult {
  const data = store();
  const orderId = input.orderId.replace(/\D/g, "");
  const order = data.orders.find(
    (o) => o.id === orderId && sameEmail(o.customer_email, input.email),
  );
  if (!order) {
    return {
      status: "refused",
      orderId,
      message: "No order matches that email and order number.",
    };
  }
  const decision = decideRefund(
    order,
    data.refunds,
    data.settings.auto_refund_limit_usd,
    now,
  );
  if (!decision.allowed) {
    return { status: "refused", orderId, message: decision.reason };
  }
  const at = new Date(now).toISOString();
  const refund: Refund = {
    id: `r-${data.nextId++}`,
    order_id: order.id,
    amount_usd: order.amount_usd,
    reason: input.reason.trim() || "No reason given",
    status: decision.status,
    decided_by: decision.status === "approved" ? "auto" : null,
    created_at: at,
    decided_at: decision.status === "approved" ? at : null,
  };
  data.refunds.push(refund);
  return {
    status: decision.status,
    refundId: refund.id,
    orderId: order.id,
    product: order.product,
    amountUsd: order.amount_usd,
    message:
      decision.status === "approved"
        ? `Refund of $${order.amount_usd} approved. It goes back to the original payment method.`
        : `Refunds over $${data.settings.auto_refund_limit_usd} need a person to review them. A Copper Crew team member will approve or reject it.`,
  };
}

export type RefundRow = Refund & {
  product: string;
  customer_email: string;
};

/** Every refund, newest first, with its order's product and customer. */
export function listRefunds(): RefundRow[] {
  const data = store();
  return data.refunds
    .map((r) => {
      const order = data.orders.find((o) => o.id === r.order_id)!;
      return {
        ...r,
        product: order.product,
        customer_email: order.customer_email,
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** A staff member approves or rejects a pending refund. */
export function decidePendingRefund(
  refundId: string,
  decision: "approved" | "rejected",
  now = Date.now(),
): { ok: true } | { ok: false; message: string } {
  const refund = store().refunds.find((r) => r.id === refundId);
  if (!refund) return { ok: false, message: "That refund doesn't exist." };
  if (refund.status !== "pending") {
    return { ok: false, message: "That refund has already been decided." };
  }
  refund.status = decision;
  refund.decided_by = "staff";
  refund.decided_at = new Date(now).toISOString();
  return { ok: true };
}
