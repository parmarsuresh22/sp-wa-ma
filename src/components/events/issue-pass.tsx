'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { contactSearchFilter } from '@/lib/contacts/search-filter';
import { money } from '@/lib/events/types';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { Label, Section, api, field, postJson, type EventView, type TypeStats } from './shared';

interface ContactHit {
  id: string;
  name: string | null;
  phone: string | null;
}

type Payment = 'free' | 'paid' | 'request';

/**
 * Give someone passes from the portal: a contact of this WhatsApp
 * number or a new number (saved as a contact). The passes — or, for
 * "ask to pay", the payment QR — go out on WhatsApp straight away.
 */
export function IssuePass({ event, stats, onIssued }: { event: EventView; stats: TypeStats[]; onIssued: () => void }) {
  const t = useTranslations('Events');
  const supabase = useMemo(() => createClient(), []);
  const types = event.pass_types.filter((p) => p.active);

  const [mode, setMode] = useState<'contact' | 'new'>('contact');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [picked, setPicked] = useState<ContactHit | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');
  const [payment, setPayment] = useState<Payment>('free');
  const [saving, setSaving] = useState(false);

  const type = types.find((p) => p.id === typeId) ?? null;
  const left = type ? Math.max(0, type.capacity - (stats.find((s) => s.pass_type_id === type.id)?.held ?? 0)) : 0;
  const count = Math.max(1, Number(quantity) || 1);
  const total = type ? type.price * count : 0;
  // A free type has nothing to pay or to ask for.
  const choice: Payment = type && type.price > 0 ? payment : 'free';

  useEffect(() => {
    if (mode !== 'contact' || picked) return;
    const term = query.trim();
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        // Only contacts of this event's WhatsApp number.
        let q = supabase
          .from('contacts')
          .select('id, name, phone, conversations!inner(channel_id)')
          .eq('conversations.channel_id', event.channel_id)
          .eq('is_group', false)
          .not('phone', 'is', null)
          .neq('phone', '');
        const filter = term.length >= 2 ? contactSearchFilter(term) : null;
        if (filter) q = q.or(filter);
        const { data } = await q.order('name').limit(20);
        if (cancelled) return;
        setHits(((data as ContactHit[] | null) ?? []).map((c) => ({ id: c.id, name: c.name, phone: c.phone })));
      },
      term ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [event.channel_id, mode, picked, query, supabase]);

  const ready = !!type && (mode === 'contact' ? !!picked : newPhone.replace(/\D/g, '').length >= 10);

  const submit = async () => {
    if (!type) return;
    setSaving(true);
    try {
      const res = await api<{ message_error: string | null }>(
        `/api/events/${event.id}/orders`,
        postJson('POST', {
          pass_type_id: type.id,
          quantity: count,
          payment: choice,
          ...(mode === 'contact' ? { contact_id: picked?.id } : { new_contact: { name: newName, phone: newPhone } }),
        }),
      );
      if (res.message_error) toast.error(t('notSent', { error: res.message_error }), { duration: 10000 });
      else toast.success(choice === 'request' ? t('paymentQrSent') : t('passesSent', { count }));
      setPicked(null);
      setQuery('');
      setNewName('');
      setNewPhone('');
      setQuantity('1');
      onIssued();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 9000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t('issueWho')} hint={t('issueWhoHint')}>
        <div className="flex gap-1.5">
          {(['contact', 'new'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs',
                mode === m ? 'border-primary bg-primary/15 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`issueMode.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'contact' ? (
          picked ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{picked.name || picked.phone}</p>
                <p className="text-xs text-muted-foreground">{picked.phone}</p>
              </div>
              <button type="button" aria-label={t('change')} onClick={() => setPicked(null)} className="text-muted-foreground hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('contactSearch')} />
              <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {hits.length === 0 ? (
                  <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t('noContacts')}</li>
                ) : (
                  hits.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setPicked(c)} className="block w-full px-3 py-2 text-left hover:bg-muted">
                        <span className="block truncate text-sm text-foreground">{c.name || c.phone}</span>
                        <span className="block text-xs text-muted-foreground">{c.phone}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Label text={t('guestName')}>
              <Input value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} />
            </Label>
            <Label text={t('guestPhone')}>
              <Input value={newPhone} inputMode="tel" maxLength={20} onChange={(e) => setNewPhone(e.target.value)} placeholder="9876543210" />
            </Label>
          </div>
        )}
      </Section>

      <Section title={t('issueWhat')}>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Label text={t('passType')}>
            <select className={cn(field, 'w-full')} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.price > 0 ? money(p.price) : t('free')}
                </option>
              ))}
            </select>
          </Label>
          <Label text={t('quantity')}>
            <input type="number" min={1} max={50} className={cn(field, 'w-full')} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Label>
        </div>
        {type && <p className={cn('text-xs', count > left ? 'text-red-400' : 'text-muted-foreground')}>{t('placesLeft', { left })}</p>}

        {type && type.price > 0 && (
          <div className="space-y-2">
            {(['free', 'paid', 'request'] as const).map((p) => (
              <label key={p} className="flex items-start gap-2 text-sm text-foreground">
                <input type="radio" name="payment" className="mt-0.5 size-4 accent-primary" checked={payment === p} onChange={() => setPayment(p)} />
                <span>
                  {t(`pay.${p}`, { amount: money(total) })}
                  <span className="block text-xs text-muted-foreground">{t(`payHint.${p}`)}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Section>

      <Button type="button" disabled={!ready || saving || count > left} onClick={submit}>
        {saving && <Loader2 className="size-4 animate-spin" />}
        {choice === 'request' ? t('sendPaymentQr') : t('issueAndSend', { count })}
      </Button>
    </div>
  );
}
