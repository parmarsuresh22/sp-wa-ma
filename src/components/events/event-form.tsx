'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { localParts } from '@/lib/appointments/time';
import { cn } from '@/lib/utils';
import { Label, Section, api, field, postJson, type EventView } from './shared';

interface TypeDraft {
  key: string;
  id?: string;
  name: string;
  price: string;
  capacity: string;
}

let draftKey = 0;
const nextKey = () => `t${++draftKey}`;

/**
 * Create or change an event: what it is, its pass types, and how paid
 * passes are paid and approved.
 */
export function EventForm({
  channelId,
  event,
  onSaved,
  onCancel,
}: {
  channelId: string;
  event: EventView | null;
  onSaved: (event: EventView) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('Events');
  const tz = event?.timezone ?? 'Asia/Kolkata';
  const start = event ? localParts(new Date(event.starts_at), tz) : null;
  const until = event?.apply_until ? localParts(new Date(event.apply_until), tz) : null;

  const [name, setName] = useState(event?.name ?? '');
  const [date, setDate] = useState(start?.date ?? '');
  const [time, setTime] = useState(start?.time ?? '');
  const [venue, setVenue] = useState(event?.venue ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [types, setTypes] = useState<TypeDraft[]>(() =>
    event
      ? event.pass_types
          .filter((p) => p.active)
          .map((p) => ({ key: nextKey(), id: p.id, name: p.name, price: String(p.price), capacity: String(p.capacity) }))
      : [{ key: nextKey(), name: '', price: '0', capacity: '' }],
  );
  const [untilDate, setUntilDate] = useState(until?.date ?? '');
  const [maxPerPhone, setMaxPerPhone] = useState(String(event?.max_per_phone ?? 5));
  const [chatBooking, setChatBooking] = useState(event?.chat_booking ?? true);
  const [upiId, setUpiId] = useState(event?.upi_id ?? '');
  const [upiName, setUpiName] = useState(event?.upi_name ?? '');
  const [holdMinutes, setHoldMinutes] = useState(String(event?.hold_minutes ?? 30));
  const [autoIssue, setAutoIssue] = useState(event?.auto_issue ?? false);
  const [notifyPhone, setNotifyPhone] = useState(event?.notify_phone ?? '');
  const [reminderHours, setReminderHours] = useState(String(event?.reminder_hours ?? 0));
  const [status, setStatus] = useState(event?.status ?? 'open');
  const [saving, setSaving] = useState(false);

  const anyPaid = types.some((p) => Number(p.price) > 0);
  const patchType = (key: string, change: Partial<TypeDraft>) =>
    setTypes((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        channel_id: channelId,
        name,
        date,
        time,
        timezone: tz,
        venue,
        description,
        pass_types: types.map((p) => ({ id: p.id, name: p.name, price: Number(p.price || 0), capacity: Number(p.capacity || 0) })),
        apply_until_date: untilDate,
        max_per_phone: Number(maxPerPhone),
        chat_booking: chatBooking,
        upi_id: upiId,
        upi_name: upiName,
        hold_minutes: Number(holdMinutes),
        auto_issue: autoIssue,
        notify_phone: notifyPhone,
        reminder_hours: Number(reminderHours),
        status,
      };
      const res = event
        ? await api<{ event: EventView }>(`/api/events/${event.id}`, postJson('PATCH', body))
        : await api<{ event: EventView }>('/api/events', postJson('POST', body));
      toast.success(t('saved'));
      onSaved(res.event);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Section title={t('formAbout')}>
        <Label text={t('name')}>
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
        </Label>
        <div className="grid grid-cols-2 gap-3">
          <Label text={t('date')}>
            <input type="date" className={cn(field, 'w-full')} value={date} onChange={(e) => setDate(e.target.value)} />
          </Label>
          <Label text={t('time')}>
            <input type="time" className={cn(field, 'w-full')} value={time} onChange={(e) => setTime(e.target.value)} />
          </Label>
        </div>
        <Label text={t('venue')}>
          <Input value={venue} maxLength={300} onChange={(e) => setVenue(e.target.value)} />
        </Label>
        <Label text={t('details')}>
          <Textarea value={description} maxLength={1000} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder={t('detailsPlaceholder')} />
        </Label>
      </Section>

      <Section title={t('formTypes')} hint={t('formTypesHint')}>
        {types.map((p) => (
          <div key={p.key} className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_7rem_7rem_auto]">
            <Label text={t('typeName')}>
              <Input value={p.name} maxLength={60} onChange={(e) => patchType(p.key, { name: e.target.value })} placeholder={t('typeNamePlaceholder')} />
            </Label>
            <button
              type="button"
              aria-label={t('removeType')}
              disabled={types.length === 1}
              onClick={() => setTypes((rows) => rows.filter((r) => r.key !== p.key))}
              className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-40 sm:order-last"
            >
              <X className="size-4" />
            </button>
            <Label text={t('typePrice')}>
              <input type="number" min={0} step="1" inputMode="decimal" className={cn(field, 'w-full')} value={p.price} onChange={(e) => patchType(p.key, { price: e.target.value })} />
            </Label>
            <Label text={t('typeCapacity')}>
              <input type="number" min={1} step="1" inputMode="numeric" className={cn(field, 'w-full')} value={p.capacity} onChange={(e) => patchType(p.key, { capacity: e.target.value })} />
            </Label>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" disabled={types.length >= 12} onClick={() => setTypes((rows) => [...rows, { key: nextKey(), name: '', price: '0', capacity: '' }])}>
          <Plus className="size-4" />
          {t('addType')}
        </Button>
      </Section>

      <Section title={t('formRules')}>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={chatBooking} onChange={(e) => setChatBooking(e.target.checked)} />
          <span>
            {t('chatBooking')}
            <span className="block text-xs text-muted-foreground">{t('chatBookingHint')}</span>
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Label text={t('applyUntil')}>
            <input type="date" className={cn(field, 'w-full')} value={untilDate} onChange={(e) => setUntilDate(e.target.value)} />
          </Label>
          <Label text={t('maxPerPhone')}>
            <input type="number" min={1} max={50} className={cn(field, 'w-full')} value={maxPerPhone} onChange={(e) => setMaxPerPhone(e.target.value)} />
          </Label>
          <Label text={t('reminder')}>
            <select className={cn(field, 'w-full')} value={reminderHours} onChange={(e) => setReminderHours(e.target.value)}>
              <option value="0">{t('reminderNone')}</option>
              {[2, 6, 12, 24, 48].map((h) => (
                <option key={h} value={h}>
                  {t('reminderHours', { hours: h })}
                </option>
              ))}
            </select>
          </Label>
        </div>
        {event && (
          <Label text={t('status')}>
            <select className={cn(field, 'w-full sm:w-64')} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">{t('statusOpen')}</option>
              <option value="closed">{t('statusClosed')}</option>
              <option value="cancelled">{t('statusCancelled')}</option>
            </select>
          </Label>
        )}
      </Section>

      <Section title={t('formPayment')} hint={anyPaid ? t('formPaymentHint') : t('formPaymentFree')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label text={t('upiId')}>
            <Input value={upiId} maxLength={120} autoCapitalize="none" onChange={(e) => setUpiId(e.target.value)} placeholder="name@okaxis" />
          </Label>
          <Label text={t('upiName')}>
            <Input value={upiName} maxLength={80} onChange={(e) => setUpiName(e.target.value)} placeholder={t('upiNamePlaceholder')} />
          </Label>
          <Label text={t('holdMinutes')}>
            <input type="number" min={5} max={1440} className={cn(field, 'w-full')} value={holdMinutes} onChange={(e) => setHoldMinutes(e.target.value)} />
          </Label>
          <Label text={t('notifyPhone')}>
            <Input value={notifyPhone} inputMode="tel" maxLength={20} onChange={(e) => setNotifyPhone(e.target.value)} placeholder="9876543210" />
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">{t('notifyPhoneHint')}</p>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={autoIssue} onChange={(e) => setAutoIssue(e.target.checked)} />
          <span>
            {t('autoIssue')}
            <span className="block text-xs text-muted-foreground">{t('autoIssueHint')}</span>
          </span>
        </label>
      </Section>

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={saving} onClick={save}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {event ? t('saveChanges') : t('createEvent')}
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
