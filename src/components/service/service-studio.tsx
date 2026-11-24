'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Camera, Eye, ImagePlus, Loader2, MessageCircle, Pencil, Phone, Plus, Settings2, Trash2, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { useKeyedPage } from '@/hooks/use-page-size';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import {
  MAX_VISIT_IMAGES,
  addDays,
  addMonths,
  indianDate,
  localDay,
  type ServiceCustomer,
  type ServiceSettings,
  type ServiceVisit,
} from '@/lib/service/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ListPager } from '@/components/ui/list-pager';
import { cn } from '@/lib/utils';

interface ServiceData {
  business: ServiceSettings | null;
  customers: ServiceCustomer[];
  visits: ServiceVisit[];
  today: string;
}

const PAGE_SIZE = 10;
const field =
  'h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 text-xs text-muted-foreground">
      <span className="mb-1 block">{text}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-card sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/** Service records and next-visit reminders for one WhatsApp Web number. */
export function ServiceStudio() {
  const t = useTranslations('Service');
  const { canEditSettings, canSendMessages } = useAuth();
  const { channels } = useChannels();
  // WhatsApp Web numbers only.
  const list = useMemo(() => (channels ?? []).filter((c) => c.provider === 'waha'), [channels]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel = list.find((c) => c.id === channelId) ?? list[0] ?? null;
  const fromId = channel?.id ?? null;

  const [data, setData] = useState<ServiceData | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useKeyedPage(`${fromId}|${search}`);
  const [entry, setEntry] = useState<{ customer?: ServiceCustomer; visit?: ServiceVisit } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ kind: 'customer' | 'visit'; id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const [openingChat, setOpeningChat] = useState<string | null>(null);

  // Straight to this customer's chat on this number, inside the portal.
  const openChat = async (c: ServiceCustomer) => {
    setOpeningChat(c.id);
    try {
      const { data: found } = await createClient()
        .from('conversations')
        .select('id')
        .eq('contact_id', c.contact_id)
        .eq('channel_id', c.channel_id)
        .limit(1);
      const id = (found as { id: string }[] | null)?.[0]?.id ?? null;
      if (id) router.push(`/inbox?c=${id}`);
      else toast.error(t('noChat'));
    } catch {
      toast.error(t('noChat'));
    } finally {
      setOpeningChat(null);
    }
  };

  const load = useCallback(async () => {
    if (!fromId) return;
    try {
      setData(await api<ServiceData>(`/api/service?channel_id=${fromId}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [fromId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const ready = !!data && (!data.business || data.business.channel_id === fromId);
  const today = data?.today ?? '';

  // Per customer: the last visit, and the nearest next visit from today on.
  const rows = useMemo(() => {
    if (!data) return [];
    const byCustomer = new Map<string, { last: string; next: string; overdue: string }>();
    for (const v of data.visits) {
      const cur = byCustomer.get(v.customer_id) ?? { last: '', next: '', overdue: '' };
      if (v.visit_date > cur.last) cur.last = v.visit_date;
      if (v.next_visit >= today && (!cur.next || v.next_visit < cur.next)) cur.next = v.next_visit;
      byCustomer.set(v.customer_id, cur);
    }
    const q = search.trim().toLowerCase();
    return data.customers
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone_key.includes(q.replace(/\D/g, '') || '\u0000'))
      .map((c) => ({ c, ...(byCustomer.get(c.id) ?? { last: '', next: '' }) }))
      .sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999') || a.c.name.localeCompare(b.c.name));
  }, [data, search, today]);

  const stats = useMemo(() => {
    if (!data) return { reminders: 0, customers: 0, dueToday: 0 };
    const tz = data.business?.timezone ?? 'Asia/Kolkata';
    const sentToday = (at: string | null) => !!at && localDay(new Date(at), tz).date === today;
    return {
      reminders: data.visits.reduce((n, v) => n + (sentToday(v.rem0_sent_at) ? 1 : 0) + (sentToday(v.rem1_sent_at) ? 1 : 0), 0),
      customers: data.customers.length,
      dueToday: data.visits.filter((v) => v.next_visit === today).length,
    };
  }, [data, today]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/api/service/${removing.kind === 'customer' ? 'customers' : 'visits'}/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      if (removing.kind === 'customer') setHistory(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dueBadge = (next: string) => {
    if (!next) return <span className="text-muted-foreground">-</span>;
    if (next === today) return <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-300">{t('today')}</span>;
    if (next === addDays(today, 1))
      return <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">{t('tomorrow')}</span>;
    return <span className="font-medium text-foreground">{indianDate(next)}</span>;
  };

  const historyCustomer = data?.customers.find((c) => c.id === history) ?? null;

  return (
    <div className="min-w-0">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {!channels ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : !fromId ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noWebNumber')}
        </p>
      ) : (
        <>
          {list.length > 1 && (
            <div className="mt-5 w-full sm:w-72">
              <Label text={t('number')}>
                <select
                  className={field}
                  value={fromId}
                  onChange={(e) => {
                    setChannelId(e.target.value);
                    setData(null);
                    setSearch('');
                  }}
                >
                  {list.map((c) => (
                    <option key={c.id} value={c.id}>
                      {channelLabel(c)}
                      {c.display_phone && c.label ? ` · ${c.display_phone}` : ''}
                    </option>
                  ))}
                </select>
              </Label>
            </div>
          )}

          {failed && !data ? (
            <div className="py-16 text-center">
              <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
              <Button className="mt-3" variant="outline" onClick={() => void load()}>
                {t('retry')}
              </Button>
            </div>
          ) : !ready || !data ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : !data.business ? (
            <div className="mx-auto mt-6 max-w-md rounded-xl border border-border bg-card p-5">
              <h2 className="text-base font-semibold text-foreground">{t('setupTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('setupHint')}</p>
              {canEditSettings ? (
                <div className="mt-4">
                  <BusinessForm channelId={fromId} business={null} onSaved={load} />
                </div>
              ) : (
                <p className="mt-4 text-sm text-amber-300">{t('setupAdminOnly')}</p>
              )}
            </div>
          ) : (
            <>
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold text-foreground">{data.business.business_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{data.business.address}</p>
                </div>
                <div className="flex items-center gap-2">
                  {canSendMessages && (
                    <Button onClick={() => setEntry({})}>
                      <Plus className="size-4" />
                      {t('addEntry')}
                    </Button>
                  )}
                  {canEditSettings && (
                    <Button variant="outline" size="icon" aria-label={t('settings')} title={t('settings')} onClick={() => setSettingsOpen(true)}>
                      <Settings2 className="size-4" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-4">
                {(
                  [
                    [t('statDueToday'), stats.dueToday, t('statDueTodayHint'), 'text-red-300'],
                    [t('statReminders'), stats.reminders, t('statRemindersHint'), 'text-primary'],
                    [t('statCustomers'), stats.customers, t('statCustomersHint'), 'text-foreground'],
                  ] as [string, number, string, string][]
                ).map(([label, value, hint, tone]) => (
                  <div key={label} className="rounded-xl border border-border bg-card p-3 text-center sm:p-4">
                    <p className="text-[11px] font-medium text-muted-foreground sm:text-xs">{label}</p>
                    <p className={cn('mt-0.5 text-xl font-bold sm:text-2xl', tone)}>{value}</p>
                    <p className="text-[10px] text-muted-foreground">{hint}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 sm:max-w-xs">
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} />
              </div>

              <ListPager className="mt-3" page={page} pageSize={PAGE_SIZE} total={rows.length} onChange={setPage} />
              {rows.length === 0 ? (
                <p className="mt-3 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  {data.customers.length === 0 ? t('empty') : t('noMatch')}
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ c, next, last }) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2.5">
                      <div className="min-w-0 flex-1 basis-40">
                        <p className="truncate text-sm font-semibold text-foreground">{c.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          +{c.phone_key}
                          {c.area ? ` · ${c.area}` : ''}
                        </p>
                      </div>
                      <div className="whitespace-nowrap text-xs">
                        <span className="text-muted-foreground">{t('next')}: </span>
                        {dueBadge(next)}
                      </div>
                      <div className="hidden whitespace-nowrap text-[11px] text-muted-foreground md:block">
                        {t('last')}: {indianDate(last)}
                      </div>
                      <div className="ml-auto flex shrink-0 items-center gap-1.5">
                        <a
                          href={`tel:+${c.phone_key}`}
                          aria-label={t('call')}
                          title={t('call')}
                          className="flex size-8 items-center justify-center rounded-md border border-border text-foreground hover:bg-muted"
                        >
                          <Phone className="size-4" />
                        </a>
                        <button
                          type="button"
                          aria-label={t('whatsapp')}
                          title={t('whatsapp')}
                          disabled={openingChat === c.id}
                          onClick={() => void openChat(c)}
                          className="flex size-8 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60"
                        >
                          {openingChat === c.id ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
                        </button>
                        <Button variant="outline" size="sm" onClick={() => setHistory(c.id)}>
                          <Eye className="size-4" />
                          <span className="hidden sm:inline">{t('view')}</span>
                        </Button>
                        {canSendMessages && (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setEntry({ customer: c })}>
                              <Plus className="size-4" />
                              <span className="hidden sm:inline">{t('entry')}</span>
                            </Button>
                            <button
                              type="button"
                              aria-label={t('removeCustomer')}
                              title={t('removeCustomer')}
                              onClick={() => setRemoving({ kind: 'customer', id: c.id, label: c.name })}
                              className="flex size-8 items-center justify-center rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <ListPager className="mt-3" page={page} pageSize={PAGE_SIZE} total={rows.length} onChange={setPage} />
            </>
          )}
        </>
      )}

      {entry && data?.business && fromId && (
        <Modal title={entry.visit ? t('editVisit') : t('newEntry')} onClose={() => setEntry(null)}>
          <EntryForm
            channelId={fromId}
            data={data}
            customer={entry.customer}
            visit={entry.visit}
            onSaved={async () => {
              setEntry(null);
              await load();
            }}
          />
        </Modal>
      )}

      {historyCustomer && data && (
        <Modal title={historyCustomer.name} onClose={() => setHistory(null)}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              +{historyCustomer.phone_key}
              {historyCustomer.area ? ` · ${historyCustomer.area}` : ''}
            </p>
            {canSendMessages && (
              <Button
                size="sm"
                onClick={() => {
                  setHistory(null);
                  setEntry({ customer: historyCustomer });
                }}
              >
                <Plus className="size-4" />
                {t('newEntry')}
              </Button>
            )}
          </div>
          <ul className="space-y-3">
            {data.visits
              .filter((v) => v.customer_id === historyCustomer.id)
              .map((v) => {
                // A visit whose next date has not passed still has reminders to come.
                const open = v.next_visit >= today;
                return (
                  <li key={v.id} className={cn('rounded-xl border p-3', open ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-muted/40')}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{v.service}</span>
                        <span
                          className={cn(
                            'whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            open ? 'bg-emerald-500/15 text-emerald-300' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {open ? t('active') : t('closed')}
                        </span>
                      </span>
                      <span className="text-xs font-medium text-muted-foreground">{indianDate(v.visit_date)}</span>
                    </div>
                    {v.area && <p className="mt-0.5 text-xs text-muted-foreground">{v.area}</p>}
                    <p className="mt-1 text-xs text-foreground">
                      {t('nextVisit')}: <b>{indianDate(v.next_visit)}</b>
                    </p>
                    {v.comment && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{v.comment}</p>}
                    {v.message_error && <p className="mt-1 text-xs text-amber-300">{t('messageError', { error: v.message_error })}</p>}
                    {v.images.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {v.images.map((u) => (
                          <button key={u} type="button" onClick={() => setZoom(u)} className="size-16 overflow-hidden rounded-lg border border-border">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={u} alt={t('photo')} loading="lazy" className="size-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                    {open && canSendMessages && (
                      <div className="mt-2 flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setHistory(null);
                            setEntry({ customer: historyCustomer, visit: v });
                          }}
                        >
                          <Pencil className="size-3.5" />
                          {t('edit')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-500/40 text-red-300 hover:bg-red-500/10"
                          onClick={() =>
                            setRemoving({ kind: 'visit', id: v.id, label: `${v.service} · ${indianDate(v.visit_date)} → ${indianDate(v.next_visit)}` })
                          }
                        >
                          <Trash2 className="size-3.5" />
                          {t('remove')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            {data.visits.every((v) => v.customer_id !== historyCustomer.id) && (
              <li className="py-8 text-center text-sm text-muted-foreground">{t('noHistory')}</li>
            )}
          </ul>
        </Modal>
      )}

      {settingsOpen && data?.business && fromId && (
        <Modal title={t('settings')} onClose={() => setSettingsOpen(false)}>
          <BusinessForm
            channelId={fromId}
            business={data.business}
            onSaved={async () => {
              setSettingsOpen(false);
              await load();
            }}
          />
        </Modal>
      )}

      {removing && (
        <Modal title={removing.kind === 'customer' ? t('removeCustomerTitle') : t('removeVisitTitle')} onClose={() => setRemoving(null)}>
          <p className="text-sm font-semibold text-foreground">{removing.label}</p>
          <p className="mt-1 text-sm text-red-300">{removing.kind === 'customer' ? t('removeCustomerHint') : t('removeVisitHint')}</p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setRemoving(null)}>
              {t('cancel')}
            </Button>
            <Button className="flex-1 bg-red-600 text-white hover:bg-red-500" disabled={busy} onClick={() => void remove()}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('yesRemove')}
            </Button>
          </div>
        </Modal>
      )}

      {zoom && (
        <button type="button" aria-label="Close" onClick={() => setZoom(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt={t('photo')} className="max-h-[85dvh] max-w-[95vw] rounded-lg object-contain" />
        </button>
      )}
    </div>
  );
}

function BusinessForm({
  channelId,
  business,
  onSaved,
}: {
  channelId: string;
  business: ServiceSettings | null;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('Service');
  const [name, setName] = useState(business?.business_name ?? '');
  const [address, setAddress] = useState(business?.address ?? '');
  const [language, setLanguage] = useState(business?.language ?? 'en');
  const [time, setTime] = useState(business?.reminder_time ?? '09:00');
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await api('/api/service/business', json('POST', { channel_id: channelId, name, address, language, reminder_time: time }));
          toast.success(t('saved'));
          await onSaved();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        } finally {
          setSaving(false);
        }
      }}
    >
      <Label text={t('businessName')}>
        <Input value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} placeholder={t('businessNameExample')} />
      </Label>
      <Label text={t('businessAddress')}>
        <Textarea value={address} maxLength={200} rows={2} required onChange={(e) => setAddress(e.target.value)} />
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <Label text={t('messageLanguage')}>
          <select className={field} value={language} onChange={(e) => setLanguage(e.target.value === 'hi' ? 'hi' : 'en')}>
            <option value="en">English</option>
            <option value="hi">हिन्दी</option>
          </select>
        </Label>
        <Label text={t('reminderTime')}>
          <input type="time" className={field} value={time} required onChange={(e) => setTime(e.target.value)} />
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">{t('reminderHint')}</p>
      <Button type="submit" className="w-full" disabled={saving || !name.trim() || !address.trim()}>
        {saving && <Loader2 className="size-4 animate-spin" />}
        {t('save')}
      </Button>
    </form>
  );
}

function EntryForm({
  channelId,
  data,
  customer,
  visit,
  onSaved,
}: {
  channelId: string;
  data: ServiceData;
  customer?: ServiceCustomer;
  visit?: ServiceVisit;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('Service');
  const lastService = (id: string) => data.visits.find((v) => v.customer_id === id)?.service ?? '';
  const [customerId, setCustomerId] = useState(customer?.id ?? '');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState(customer?.name ?? '');
  const [area, setArea] = useState(visit?.area ?? customer?.area ?? '');
  const [service, setService] = useState(visit?.service ?? (customer ? lastService(customer.id) : ''));
  const [visitDate, setVisitDate] = useState(visit?.visit_date ?? data.today);
  const [nextVisit, setNextVisit] = useState(visit?.next_visit ?? '');
  const [comment, setComment] = useState(visit?.comment ?? '');
  const [images, setImages] = useState<string[]>(visit?.images ?? []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  const pick = (id: string) => {
    setCustomerId(id);
    const c = data.customers.find((x) => x.id === id);
    setName(c?.name ?? '');
    setArea(c?.area ?? '');
    setService(c ? lastService(c.id) : '');
  };

  // A typed number that is already a customer picks that customer.
  const typePhone = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 15);
    setPhone(digits);
    if (digits.length >= 10) {
      const known = data.customers.find((c) => c.phone_key.endsWith(digits.slice(-10)));
      if (known) pick(known.id);
    }
  };

  const addFiles = async (files: FileList | null) => {
    const chosen = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (chosen.length === 0) return;
    setUploading(true);
    try {
      for (const file of chosen.slice(0, MAX_VISIT_IMAGES - images.length)) {
        const up = await uploadAccountMedia('chat-media', file);
        setImages((prev) => (prev.length >= MAX_VISIT_IMAGES ? prev : [...prev, up.publicUrl]));
      }
    } catch (err) {
      toast.error(t('uploadFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setUploading(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId && phone.length < 10) return toast.error(t('badPhone'));
    if (nextVisit < visitDate) return toast.error(t('nextBeforeVisit'));
    setSaving(true);
    try {
      const body = {
        channel_id: channelId,
        customerId: customerId || undefined,
        customerPhone: customerId ? undefined : phone,
        customerName: name,
        area,
        service,
        visitDate,
        nextVisit,
        comment,
        images,
      };
      if (visit) {
        await api(`/api/service/visits/${visit.id}`, json('PATCH', body));
        toast.success(t('updated'));
      } else {
        const res = await api<{ sent: boolean; message_error: string | null }>('/api/service/visits', json('POST', body));
        if (res.sent) toast.success(t('savedAndSent'));
        else toast.warning(t('savedNotSent', { error: res.message_error ?? '' }));
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Label text={t('chooseCustomer')}>
        <select className={field} value={customerId} disabled={!!visit} onChange={(e) => pick(e.target.value)}>
          <option value="">{t('newCustomer')}</option>
          {data.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · +{c.phone_key}
            </option>
          ))}
        </select>
      </Label>
      {!customerId && (
        <Label text={t('customerPhone')}>
          <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => typePhone(e.target.value)} placeholder={t('customerPhoneHint')} />
        </Label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Label text={t('customerName')}>
          <Input value={name} maxLength={50} required onChange={(e) => setName(e.target.value)} />
        </Label>
        <Label text={t('area')}>
          <Input value={area} maxLength={80} onChange={(e) => setArea(e.target.value)} />
        </Label>
      </div>
      <Label text={t('service')}>
        <Input value={service} maxLength={80} required onChange={(e) => setService(e.target.value)} placeholder={t('serviceExample')} />
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <Label text={t('visitDate')}>
          <input type="date" className={field} value={visitDate} required onChange={(e) => setVisitDate(e.target.value)} />
        </Label>
        <Label text={t('nextVisit')}>
          <input type="date" className={field} value={nextVisit} min={visitDate} required onChange={(e) => setNextVisit(e.target.value)} />
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{t('nextVisit')}:</span>
        {[1, 2, 3, 6, 12].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setNextVisit(addMonths(visitDate || data.today, n))}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t('plusMonths', { n })}
          </button>
        ))}
      </div>
      <Label text={t('comment')}>
        <Textarea value={comment} maxLength={300} rows={2} onChange={(e) => setComment(e.target.value)} />
      </Label>
      <div>
        <span className="mb-1 block text-xs text-muted-foreground">{t('photos', { max: MAX_VISIT_IMAGES })}</span>
        <div className="flex flex-wrap gap-2">
          {images.map((u) => (
            <div key={u} className="relative size-20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={t('photo')} className="size-full rounded-lg border border-border object-cover" />
              <button
                type="button"
                aria-label={t('remove')}
                onClick={() => setImages((prev) => prev.filter((x) => x !== u))}
                className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-red-600 text-white"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {images.length < MAX_VISIT_IMAGES &&
            (uploading ? (
              <div className="flex size-20 items-center justify-center rounded-lg border border-dashed border-border">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => cameraRef.current?.click()}
                  className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground hover:border-primary"
                >
                  <Camera className="size-5" />
                  <span className="text-[10px]">{t('camera')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground hover:border-primary"
                >
                  <ImagePlus className="size-5" />
                  <span className="text-[10px]">{t('gallery')}</span>
                </button>
              </>
            ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      <Button type="submit" className="w-full" disabled={saving || uploading}>
        {saving && <Loader2 className="size-4 animate-spin" />}
        {visit ? t('update') : t('saveAndSend')}
      </Button>
    </form>
  );
}
