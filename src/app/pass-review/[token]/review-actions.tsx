'use client';

import { useState } from 'react';

const DONE_TEXT: Record<string, string> = {
  issued: 'Approved. The passes have been sent to the customer.',
  rejected: 'Rejected. The customer has been told no pass was issued.',
  cancelled: 'This request was cancelled.',
};

/** Approve / Reject for the approval link. The decision is a POST, never the page load itself. */
export function ReviewActions({ token, status }: { token: string; status: string }) {
  const [state, setState] = useState(status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/events/review/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string; message_error?: string | null };
      if (data.status) setState(data.status);
      if (!res.ok) setError(data.error ?? 'Something went wrong, please try again');
      else if (data.message_error) setWarning(`Saved, but the WhatsApp message could not be sent: ${data.message_error}`);
    } catch {
      setError('No connection, please try again');
    } finally {
      setBusy(null);
    }
  };

  if (state !== 'review' && state !== 'awaiting_payment') {
    return (
      <div className="space-y-2">
        <p className="rounded-xl border border-border bg-card p-4 text-center text-sm font-medium text-foreground">
          {DONE_TEXT[state] ?? 'This payment was already decided.'}
        </p>
        {warning && <p className="text-xs text-amber-300">{warning}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => decide('approve')}
          className="h-12 rounded-xl bg-emerald-600 text-base font-semibold text-white disabled:opacity-60"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => decide('reject')}
          className="h-12 rounded-xl bg-red-600 text-base font-semibold text-white disabled:opacity-60"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </div>
  );
}
