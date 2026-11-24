import type { Metadata } from 'next';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { PROBLEM_TEXT, eventWhen, loadEvent, loadOrderByToken } from '@/lib/events/service';
import { money, type ProofProblem } from '@/lib/events/types';
import { ReviewActions } from './review-actions';

export const metadata: Metadata = {
  title: 'Payment to check',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * The page behind the link sent to an event's approval number: the
 * order, the screenshot and what did not match, with Approve and
 * Reject. No sign-in — the long random token in the address is the
 * permission, and it reaches only this one order.
 */
export default async function PassReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = supabaseAdmin();
  const order = await loadOrderByToken(db, token);
  const event = order ? await loadEvent(db, order.account_id, order.event_id) : null;

  if (!order || !event) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center p-6 text-center">
        <p className="text-sm text-muted-foreground">This link is not valid.</p>
      </main>
    );
  }

  const { day, time } = eventWhen(event);
  const type = event.pass_types.find((p) => p.id === order.pass_type_id)?.name ?? 'Pass';
  const reading = order.proof.reading ?? null;
  const problems = order.proof.problems ?? [];
  const picture = order.proof_url && /^https:\/\//.test(order.proof_url) ? order.proof_url : null;
  const rows: [string, string][] = [
    ['Event', `${event.name} · ${day}, ${time}`],
    ['From', `${order.customer_name ?? 'Customer'} (${order.phone_key})`],
    ['Passes', `${order.quantity} × ${type}`],
    ['Amount to receive', money(order.amount)],
    ...(order.payment_ref ? ([['Reference number', order.payment_ref]] as [string, string][]) : []),
    ...(reading?.amount != null ? ([['Amount on the screenshot', money(reading.amount)]] as [string, string][]) : []),
    ...(reading?.payee_upi || reading?.payee_name
      ? ([['Paid to', reading.payee_upi || reading.payee_name || '']] as [string, string][])
      : []),
    ...(reading?.paid_on ? ([['Payment date', reading.paid_on]] as [string, string][]) : []),
  ];

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">Payment to check</h1>
        <p className="text-sm text-muted-foreground">Order {order.code}</p>
      </div>

      <dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 px-3 py-2">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-right text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      {problems.length > 0 ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p className="font-medium">Please look at:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{PROBLEM_TEXT[p as ProofProblem] ?? p}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          Amount, payee, reference number and date all match the order.
        </p>
      )}

      {picture && (
        <a href={picture} target="_blank" rel="noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picture} alt="Payment screenshot" className="mx-auto max-h-[70vh] rounded-xl border border-border" />
        </a>
      )}

      <p className="text-xs text-muted-foreground">
        Check your bank or UPI app for this payment before approving. A screenshot can be edited; your bank statement cannot.
      </p>

      <ReviewActions token={token} status={order.status} />
    </main>
  );
}
