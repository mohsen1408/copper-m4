"use client";

// The Refund Console (Module 4): refunds waiting for a person, with Approve
// and Reject buttons, and the recent decisions. It reloads every few seconds,
// so a refund asked for in the chat beside it shows up on its own.
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd } from "@/lib/copper/catalog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  decideRefund,
  loadRefundQueue,
  type RefundQueue,
  updateRefundLimit,
} from "@/lib/copper/refund-console";
import type { RefundRow } from "@/lib/copper/refunds";

const RELOAD_MS = 5000;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function RefundConsole() {
  const [queue, setQueue] = useState<RefundQueue | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [limitDraft, setLimitDraft] = useState("");
  const [limitMessage, setLimitMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const reload = useCallback(async () => {
    try {
      setQueue(await loadRefundQueue());
      setLoadError("");
    } catch {
      setLoadError(
        "Couldn't load the refunds. If you use Supabase, check that the refunds tables exist (supabase/migrations). Then press Refresh or reload the page.",
      );
    }
  }, []);

  useEffect(() => {
    // Load once now, then every few seconds.
    const first = setTimeout(reload, 0);
    const timer = setInterval(reload, RELOAD_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [reload]);

  function decide(refund: RefundRow, decision: "approved" | "rejected") {
    startTransition(async () => {
      const result = await decideRefund(refund.id, decision);
      setError(result.ok ? "" : result.message);
      await reload();
    });
  }

  function saveLimit(event: React.FormEvent) {
    event.preventDefault();
    const value = limitDraft.trim() === "" ? NaN : Number(limitDraft);
    startTransition(async () => {
      const result = await updateRefundLimit(value);
      if (result.ok) {
        setLimitDraft("");
        setLimitMessage(
          `Saved. New requests use ${formatUsd(result.limitUsd)}.`,
        );
      } else {
        setLimitMessage(result.message);
      }
      await reload();
    });
  }

  if (!queue) {
    return (
      <p
        role={loadError ? "alert" : undefined}
        className={
          loadError
            ? "text-destructive mt-6 text-sm"
            : "text-muted-foreground mt-6 text-sm"
        }
      >
        {error || "Loading refunds…"}
      </p>
    );
  }

  const pending = queue.refunds.filter((r) => r.status === "pending");
  const decided = queue.refunds.filter((r) => r.status !== "pending");

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Refunds of {formatUsd(queue.limitUsd)} or less are approved
          automatically. Anything over that waits here for a person.
        </p>
        <Button variant="outline" size="sm" onClick={reload}>
          <RefreshCwIcon /> Refresh
        </Button>
      </div>
      <Card data-testid="refund-limit">
        <CardHeader>
          <CardTitle>Auto-refund limit: {formatUsd(queue.limitUsd)}</CardTitle>
          <CardDescription>
            The rule in code approves refunds at or under this amount. Set it to
            $0 to send every refund to a person.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveLimit} className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="refund-limit">New limit (USD)</Label>
              <Input
                id="refund-limit"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={limitDraft}
                onChange={(event) => {
                  setLimitDraft(event.target.value);
                  setLimitMessage("");
                }}
                placeholder={String(queue.limitUsd)}
                className="w-32"
              />
            </div>
            <Button type="submit" disabled={isPending}>
              Save limit
            </Button>
          </form>
          {limitMessage && (
            <p className="text-muted-foreground mt-2 text-sm" role="status">
              {limitMessage}
            </p>
          )}
        </CardContent>
      </Card>

      {(loadError || error) && (
        <p role="alert" className="text-destructive text-sm">
          {loadError || error}
        </p>
      )}

      <Card data-testid="pending-refunds">
        <CardHeader>
          <CardTitle>Waiting for review ({pending.length})</CardTitle>
          <CardDescription>
            Over the {formatUsd(queue.limitUsd)} limit, so the refund agent
            couldn&apos;t approve them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing to review right now.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">
                        #{r.order_id} {r.product}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {r.customer_email} · {when(r.created_at)}
                      </div>
                    </TableCell>
                    <TableCell>{formatUsd(r.amount_usd)}</TableCell>
                    <TableCell className="max-w-40 whitespace-normal">
                      {r.reason}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-end gap-1.5">
                        <Button
                          size="sm"
                          disabled={isPending}
                          onClick={() => decide(r, "approved")}
                          aria-label={`Approve refund for order ${r.order_id}`}
                        >
                          <CheckIcon /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPending}
                          onClick={() => decide(r, "rejected")}
                          aria-label={`Reject refund for order ${r.order_id}`}
                        >
                          <XIcon /> Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="decided-refunds">
        <CardHeader>
          <CardTitle>Recent decisions</CardTitle>
          <CardDescription>
            &quot;Automatic&quot; means the rule in code approved it;
            &quot;Staff&quot; means a person decided.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {decided.length === 0 ? (
            <p className="text-muted-foreground text-sm">No decisions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Decided by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {decided.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      #{r.order_id} {r.product}
                    </TableCell>
                    <TableCell>{formatUsd(r.amount_usd)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.status === "approved" ? "default" : "destructive"
                        }
                      >
                        {r.status === "approved" ? "Approved" : "Rejected"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.decided_by === "auto" ? "Automatic" : "Staff"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        {queue.where === "supabase"
          ? "Data: the orders, refunds and settings tables in Supabase (made-up orders)."
          : "Demo data: made-up orders kept in memory, so they reset when the server restarts."}{" "}
        Try asking the chat: &quot;I want a refund on order 1001, my email is
        sam@example.com&quot;.
      </p>
    </div>
  );
}
