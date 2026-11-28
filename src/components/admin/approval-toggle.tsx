'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

/**
 * One switch for the whole platform: does a customer's WhatsApp Web
 * number wait for the admin, or is it approved the moment it is asked
 * for? The plan's number limit applies either way.
 */
export function NumberApprovalToggle() {
  const [required, setRequired] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let gone = false;
    fetch('/api/admin8085/number-approval', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { required?: boolean }) => {
        if (!gone && typeof d.required === 'boolean') setRequired(d.required);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const flip = async () => {
    if (required === null) return;
    const next = !required;
    setSaving(true);
    try {
      const res = await fetch('/api/admin8085/number-approval', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setRequired(next);
      toast.success(next ? 'Approval is required again' : 'Numbers are now approved automatically');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <h2 className="text-sm font-semibold">Approval for WhatsApp Web numbers</h2>
        <p className="text-xs text-muted-foreground">
          {required === false
            ? 'Off: a customer who asks for a number gets it at once and goes straight to the QR code. The limit of their plan still applies.'
            : 'On: a customer who asks for a number waits until you approve the request below.'}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={required === true}
        aria-label="Approval required for WhatsApp Web numbers"
        disabled={required === null || saving}
        onClick={() => void flip()}
        className={
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ' +
          (required === false ? 'bg-muted-foreground/40' : 'bg-primary')
        }
      >
        <span
          className={
            'inline-flex size-5 items-center justify-center rounded-full bg-white transition-transform ' +
            (required === false ? 'translate-x-1' : 'translate-x-6')
          }
        >
          {(required === null || saving) && <Loader2 className="size-3 animate-spin text-black/60" />}
        </span>
      </button>
      <span className="w-24 text-xs font-semibold">{required === null ? '' : required ? 'Required' : 'Not required'}</span>
    </section>
  );
}
