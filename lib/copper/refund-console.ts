"use server";

// The server actions the Refund Console page calls (Module 4): read the
// refunds, and let a staff member approve or reject a pending one.
// The model never calls these. Only a person on the console can decide a
// refund that's over the auto-refund limit.
import {
  decidePendingRefund,
  getAutoRefundLimit,
  listRefunds,
  type RefundRow,
} from "@/lib/copper/refunds";

export type RefundQueue = { limitUsd: number; refunds: RefundRow[] };

/** Every refund and the current auto-refund limit. */
export async function loadRefundQueue(): Promise<RefundQueue> {
  return { limitUsd: getAutoRefundLimit(), refunds: listRefunds() };
}

/** A staff member's decision on a pending refund. */
export async function decideRefund(
  refundId: string,
  decision: "approved" | "rejected",
) {
  return decidePendingRefund(refundId, decision);
}
