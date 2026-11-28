'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileUp, Loader2, MessageCircle, Smartphone, X } from 'lucide-react';

import { parseVcf, type RawDeviceContact } from '@/lib/contacts/device-contacts';

/** The phone's own contact chooser (Android Chrome and a few others). */
type ContactPicker = {
  select: (props: string[], opts: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]>;
};
function contactPicker(): ContactPicker | null {
  if (typeof navigator === 'undefined') return null;
  const c = (navigator as Navigator & { contacts?: ContactPicker }).contacts;
  return c && typeof c.select === 'function' ? c : null;
}

const BATCH = 1000;

/**
 * Three ways to bring a phone's contacts under one WhatsApp number:
 * pick them on this phone, upload the phone's contacts file, or read
 * what WhatsApp itself knows of the linked phone.
 */
export function SyncContactsDialog({
  channel,
  onClose,
  onDone,
}: {
  channel: { id: string; name: string; isWeb: boolean };
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('Contacts.page');
  const [busy, setBusy] = useState<'pick' | 'file' | 'whatsapp' | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const picker = contactPicker();

  const send = async (contacts: RawDeviceContact[] | null) => {
    const post = async (body: unknown) => {
      const res = await fetch(`/api/whatsapp/channels/${channel.id}/sync-contacts`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; found?: number; added?: number };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return { found: data.found ?? 0, added: data.added ?? 0 };
    };
    let found = 0;
    let added = 0;
    if (contacts === null) {
      ({ found, added } = await post(null));
    } else {
      for (let i = 0; i < contacts.length; i += BATCH) {
        const part = await post({ contacts: contacts.slice(i, i + BATCH) });
        found += part.found;
        added += part.added;
      }
    }
    if (found === 0) toast.warning(t('syncNone'));
    else toast.success(t('syncDone', { found, added }));
    onDone();
    if (found > 0) onClose();
  };

  const run = async (kind: 'pick' | 'file' | 'whatsapp', work: () => Promise<void>) => {
    setBusy(kind);
    try {
      await work();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pick = () =>
    run('pick', async () => {
      if (!picker) return;
      const chosen = await picker.select(['name', 'tel'], { multiple: true });
      const contacts = chosen.flatMap((c) => (c.tel ?? []).map((phone) => ({ name: c.name?.[0] ?? null, phone })));
      if (contacts.length === 0) return;
      await send(contacts);
    });

  const upload = (file: File | undefined) =>
    run('file', async () => {
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) throw new Error(t('syncFileTooBig'));
      const contacts = parseVcf(await file.text());
      if (contacts.length === 0) throw new Error(t('syncFileEmpty'));
      await send(contacts);
    });

  const option =
    'flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left hover:border-primary disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={t('syncTitle')} className="w-full max-w-md rounded-t-2xl border border-border bg-background p-4 sm:rounded-2xl">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{t('syncTitle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('syncInto', { number: channel.name })}</p>
          </div>
          <button type="button" aria-label={t('syncClose')} disabled={!!busy} onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-3 space-y-2">
          <button type="button" className={option} disabled={!!busy || !picker} onClick={() => void pick()}>
            {busy === 'pick' ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" /> : <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" />}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{t('syncPick')}</span>
              <span className="block text-xs text-muted-foreground">{picker ? t('syncPickHint') : t('syncPickUnavailable')}</span>
            </span>
          </button>

          <button type="button" className={option} disabled={!!busy} onClick={() => fileRef.current?.click()}>
            {busy === 'file' ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" /> : <FileUp className="mt-0.5 size-5 shrink-0 text-primary" />}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{t('syncFile')}</span>
              <span className="block text-xs text-muted-foreground">{t('syncFileHint')}</span>
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".vcf,text/vcard,text/x-vcard"
            className="hidden"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />

          {channel.isWeb && (
            <button type="button" className={option} disabled={!!busy} onClick={() => void run('whatsapp', () => send(null))}>
              {busy === 'whatsapp' ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" /> : <MessageCircle className="mt-0.5 size-5 shrink-0 text-primary" />}
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{t('syncWhatsApp')}</span>
                <span className="block text-xs text-muted-foreground">{t('syncWhatsAppHint')}</span>
              </span>
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('syncNote')}</p>
      </div>
    </div>
  );
}
