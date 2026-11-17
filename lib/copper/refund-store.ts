// Module 4: where orders, refunds and the auto-refund limit are kept.
// - With Supabase set up (NEXT_PUBLIC_SUPABASE_URL and
//   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY), they live in the `orders`,
//   `refunds` and `settings` tables (supabase/migrations/…_refunds.sql), so the
//   chat and the Refund Console see the same data on every server.
// - Without it (and in tests), they're kept in memory, seeded from
//   data/orders.json, and reset when the server restarts.
// The refund rules don't live here: see lib/copper/refunds.ts.
import seed from "@/lib/copper/data/orders.json";
import { createStatelessClient } from "@/lib/supabase/server";

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

export type RefundDecisionPatch = Pick<
  Refund,
  "status" | "decided_by" | "decided_at"
>;

/** Thrown when the data can't be read or saved right now. */
export class RefundStoreError extends Error {
  constructor() {
    super("Refunds can't be reached right now. Please try again soon.");
  }
}

export type RefundStore = {
  where: "supabase" | "memory";
  orders(): Promise<Order[]>;
  refunds(): Promise<Refund[]>;
  /** Saves a new refund. False if the order already has an open refund. */
  addRefund(refund: Refund): Promise<boolean>;
  /** Decides a pending refund. False if it isn't pending (or doesn't exist). */
  decidePending(id: string, patch: RefundDecisionPatch): Promise<boolean>;
  limit(): Promise<number>;
  setLimit(value: number): Promise<void>;
};

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

type MemoryData = {
  orders: Order[];
  refunds: Refund[];
  limit: number;
};

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, now: number) =>
  new Date(now - days * DAY).toISOString();

function seedData(now: number): MemoryData {
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
    limit: seed.settings.auto_refund_limit_usd,
  };
}

// Kept on globalThis so the chat and the Refund Console share one copy, even
// after the dev server reloads a file.
const holder = globalThis as unknown as {
  copperRefundData?: MemoryData;
  copperRefundMemoryOnly?: boolean;
};
const data = () => (holder.copperRefundData ??= seedData(Date.now()));

const memoryStore: RefundStore = {
  where: "memory",
  orders: async () => structuredClone(data().orders),
  refunds: async () => structuredClone(data().refunds),
  addRefund: async (refund) => {
    const open = data().refunds.some(
      (r) => r.order_id === refund.order_id && r.status !== "rejected",
    );
    if (open) return false;
    data().refunds.push({ ...refund });
    return true;
  },
  decidePending: async (id, patch) => {
    const refund = data().refunds.find((r) => r.id === id);
    if (!refund || refund.status !== "pending") return false;
    Object.assign(refund, patch);
    return true;
  },
  limit: async () => data().limit,
  setLimit: async (value) => {
    data().limit = value;
  },
};

/** Starts over with the made-up data in memory, and stays in memory (tests). */
export function resetRefundStore(now = Date.now()) {
  holder.copperRefundData = seedData(now);
  holder.copperRefundMemoryOnly = true;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

type Client = NonNullable<ReturnType<typeof createStatelessClient>>;

const toOrder = (row: Record<string, unknown>): Order => ({
  ...(row as Order),
  amount_usd: Number(row.amount_usd),
});
const toRefund = (row: Record<string, unknown>): Refund => ({
  ...(row as Refund),
  amount_usd: Number(row.amount_usd),
});

function supabaseStore(db: Client): RefundStore {
  const fail = (error: unknown) => {
    if (error) throw new RefundStoreError();
  };
  return {
    where: "supabase",
    orders: async () => {
      const { data, error } = await db.from("orders").select("*");
      fail(error);
      return (data ?? []).map(toOrder);
    },
    refunds: async () => {
      const { data, error } = await db.from("refunds").select("*");
      fail(error);
      return (data ?? []).map(toRefund);
    },
    addRefund: async (refund) => {
      const { error } = await db.from("refunds").insert(refund);
      // 23505: the unique index says this order already has an open refund.
      if (error?.code === "23505") return false;
      fail(error);
      return true;
    },
    decidePending: async (id, patch) => {
      // Only a refund that's still pending changes, so two staff clicking at
      // once can't decide it twice.
      const { data, error } = await db
        .from("refunds")
        .update(patch)
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      fail(error);
      return (data ?? []).length > 0;
    },
    limit: async () => {
      const { data, error } = await db
        .from("settings")
        .select("value")
        .eq("key", "auto_refund_limit_usd")
        .single();
      fail(error);
      return Number(data?.value);
    },
    setLimit: async (value) => {
      const { error } = await db
        .from("settings")
        .update({ value })
        .eq("key", "auto_refund_limit_usd");
      fail(error);
    },
  };
}

/** Supabase when it's set up, otherwise memory. */
export function refundStore(): RefundStore {
  if (holder.copperRefundMemoryOnly) return memoryStore;
  const db = createStatelessClient();
  return db ? supabaseStore(db) : memoryStore;
}
