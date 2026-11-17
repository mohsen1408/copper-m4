"use server";

// The server actions the Refund Console page calls (Module 4): read the
// refunds, and let a staff member approve or reject a pending one.
// The model never calls these. Only a person on the console can decide a
// refund that's over the auto-refund limit.
import {
  decidePendingRefund,
  getAutoRefundLimit,
  getRefundStatuses,
  listRefunds,
  type RefundRow,
  type RefundUpdate,
  setAutoRefundLimit,
} from "@/lib/copper/refunds";
import { refundStore } from "@/lib/copper/refund-store";

export type RefundQueue = {
  limitUsd: number;
  refunds: RefundRow[];
  /** Where the data lives: the Supabase tables, or memory (demo). */
  where: "supabase" | "memory";
};

/** Every refund and the current auto-refund limit. */
export async function loadRefundQueue(): Promise<RefundQueue> {
  const [limitUsd, refunds] = await Promise.all([
    getAutoRefundLimit(),
    listRefunds(),
  ]);
  return { limitUsd, refunds, where: refundStore().where };
}

/** A staff member's decision on a pending refund. */
export async function decideRefund(
  refundId: string,
  decision: "approved" | "rejected",
) {
  return decidePendingRefund(refundId, decision);
}

/** A staff member changes the auto-refund limit. */
export async function updateRefundLimit(value: number) {
  return setAutoRefundLimit(value);
}

/** The chat asks whether its pending refunds have been decided yet. */
export async function checkRefunds(
  refundIds: string[],
): Promise<RefundUpdate[]> {
  return getRefundStatuses(refundIds.slice(0, 20));
}
