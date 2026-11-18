'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Save, Smartphone, Trash2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { collectVariableSlots } from '@/components/inbox/template-picker';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NAME_TOKEN = '{{name}}';
// A leap year, so February offers the 29th.
const LEAP_YEAR = 2024;

interface WishRow {
  channel_id: string | null;
  enabled: boolean;
  month: number;
  day: number;
  message_text: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: unknown;
  last_sent_at: string | null;
  last_error: string | null;
}

interface StoredParams {
  body: string[];
  headerText: string;
  buttonParams: Record<number, string>;
}

function readParams(raw: unknown): StoredParams {
  const out: StoredParams = { body: [], headerText: '', buttonParams: {} };
  if (Array.isArray(raw)) {
    out.body = raw.map((v) => (typeof v === 'string' ? v : ''));
  } else if (raw && typeof raw === 'object') {
    const o = raw as { body?: unknown; headerText?: unknown; buttonParams?: unknown };
    if (Array.isArray(o.body)) out.body = o.body.map((v) => (typeof v === 'string' ? v : ''));
    if (typeof o.headerText === 'string') out.headerText = o.headerText;
    if (o.buttonParams && typeof o.buttonParams === 'object') {
      for (const [k, v] of Object.entries(o.buttonParams as Record<string, unknown>)) {
        if (typeof v === 'string') out.buttonParams[Number(k)] = v;
      }
    }
  }
  return out;
}

const templateKey = (name: string, language?: string | null) => `${name}::${language ?? ''}`;

/**
 * The contact's yearly wish: a day and month, and what to send. The
 * wish goes out on the number selected on the contacts page — an
 * approved template on a Business API number, free text on a WhatsApp
 * Web number. When it is sent is the number's Wish Scheduler setting.
 */
export function ContactWishTab({
  contactId,
  channelId,
}: {
  contactId: string;
  /** The number selected on the contacts page; null for "All numbers". */
  channelId: string | null;
}) {
  const t = useTranslations('Contacts.wish');
  const locale = useLocale();
  const { canSendMessages } = useAuth();
  const { channels } = useChannels();

  const [loading, setLoading] = useState(true);
  const [wish, setWish] = useState<WishRow | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [month, setMonth] = useState<number | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tplKey, setTplKey] = useState('');
  const [params, setParams] = useState<StoredParams>({ body: [], headerText: '', buttonParams: {} });
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  function applyWish(row: WishRow | null) {
    setWish(row);
    setEnabled(row ? row.enabled : true);
    setMonth(row?.month ?? null);
    setDay(row?.day ?? null);
    setText(row?.message_text ?? '');
    setTplKey(row?.template_name ? templateKey(row.template_name, row.template_language) : '');
    setParams(readParams(row?.template_params));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/wishes/contact/${contactId}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { wish?: WishRow | null };
        if (cancelled) return;
        if (!res.ok) throw new Error();
        applyWish(body.wish ?? null);
      } catch {
        if (!cancelled) toast.error(t('loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, t]);

  // The number the wish is saved on: the contacts-page selection; with
  // a single number there is nothing to choose; with "All numbers" an
  // existing wish keeps its own number, a new one has to pick.
  const list = useMemo(() => channels ?? [], [channels]);
  const target = useMemo(() => {
    const byId = (id: string | null | undefined) => (id ? list.find((c) => c.id === id) ?? null : null);
    return byId(channelId) ?? (list.length === 1 ? list[0] : null) ?? byId(wish?.channel_id) ?? null;
  }, [list, channelId, wish]);
  const savedChannel = wish?.channel_id ? list.find((c) => c.id === wish.channel_id) ?? null : null;
  const isBridge = target?.provider === 'waha';
  const needsTemplates = !!target && !isBridge;

  useEffect(() => {
    if (!needsTemplates || templates !== null) return;
    let cancelled = false;
    createClient()
      .from('message_templates')
      .select('*')
      .eq('status', 'APPROVED')
      .order('name')
      .then(({ data }) => {
        if (!cancelled) setTemplates((data as MessageTemplate[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [needsTemplates, templates]);

  const template = useMemo(
    () => templates?.find((tpl) => templateKey(tpl.name, tpl.language) === tplKey) ?? null,
    [templates, tplKey],
  );
  const slots = useMemo(() => (template ? collectVariableSlots(template) : null), [template]);

  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(LEAP_YEAR, i, 1))));
  }, [locale]);
  const dayCount = month ? new Date(Date.UTC(LEAP_YEAR, month, 0)).getUTCDate() : 31;

  function pickMonth(next: number) {
    setMonth(next);
    const max = new Date(Date.UTC(LEAP_YEAR, next, 0)).getUTCDate();
    if (day && day > max) setDay(max);
  }

  function pickTemplate(key: string) {
    setTplKey(key);
    setParams({ body: [], headerText: '', buttonParams: {} });
  }

  async function save() {
    if (!target) return;
    if (!month || !day) {
      toast.error(t('requiredDate'));
      return;
    }
    const payload: Record<string, unknown> = { enabled, month, day, channel_id: target.id };
    if (isBridge) {
      if (enabled && !text.trim()) {
        toast.error(t('requiredMessage'));
        return;
      }
      payload.message_text = text;
    } else {
      if (enabled && !template) {
        toast.error(t('requiredTemplate'));
        return;
      }
      if (template && slots) {
        const body = slots.bodyVars.map((_, i) => params.body[i] ?? '');
        const buttonParams: Record<number, string> = {};
        for (const s of slots.urlButtonSlots) {
          buttonParams[s.index] = (params.buttonParams[s.index] ?? '').trim();
        }
        const complete =
          body.every((v) => v.trim()) &&
          (slots.headerVar === null || params.headerText.trim()) &&
          Object.values(buttonParams).every((v) => v);
        if (enabled && !complete) {
          toast.error(t('requiredValues'));
          return;
        }
        payload.template_name = template.name;
        payload.template_language = template.language ?? null;
        payload.template_params = {
          body,
          ...(slots.headerVar !== null ? { headerText: params.headerText.trim() } : {}),
          ...(slots.urlButtonSlots.length > 0 ? { buttonParams } : {}),
        };
      }
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/wishes/contact/${contactId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { wish?: WishRow; error?: string };
      if (!res.ok || !body.wish) {
        toast.error(t('saveFailed', { reason: body.error || `HTTP ${res.status}` }));
        return;
      }
      applyWish(body.wish);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed', { reason: t('networkError') }));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      const res = await fetch(`/api/wishes/contact/${contactId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(t('saveFailed', { reason: body.error || `HTTP ${res.status}` }));
        return;
      }
      applyWish(null);
      toast.success(t('removed'));
    } catch {
      toast.error(t('saveFailed', { reason: t('networkError') }));
    } finally {
      setRemoving(false);
    }
  }

  if (loading || channels === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!target) {
    return (
      <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
        {list.length === 0 ? t('noNumbers') : t('pickNumber')}
      </p>
    );
  }

  const disabled = !canSendMessages || saving || removing;
  const fieldClass = 'bg-muted border-border text-foreground text-sm placeholder:text-muted-foreground';
  const targetName = channelLabel(target);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="wish-enabled" className="text-sm text-foreground">
            {t('enable')}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('enableDesc')}</p>
        </div>
        <Switch
          id="wish-enabled"
          checked={enabled}
          onCheckedChange={(v) => setEnabled(!!v)}
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {t('day')} <span className="text-red-400">*</span>
          </Label>
          <Select
            value={day ? String(day) : null}
            onValueChange={(v) => v && setDay(Number(v))}
            disabled={disabled}
          >
            <SelectTrigger className="w-full" aria-label={t('day')}>
              <SelectValue placeholder={t('pickDay')} />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: dayCount }, (_, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>
                  {i + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {t('month')} <span className="text-red-400">*</span>
          </Label>
          <Select
            value={month ? String(month) : null}
            onValueChange={(v) => v && pickMonth(Number(v))}
            disabled={disabled}
            items={Object.fromEntries(months.map((name, i) => [String(i + 1), name]))}
          >
            <SelectTrigger className="w-full" aria-label={t('month')}>
              <SelectValue placeholder={t('pickMonth')} />
            </SelectTrigger>
            <SelectContent>
              {months.map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 text-foreground">
          <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
          {t('sendsFrom', { number: targetName })}
        </p>
        {savedChannel && savedChannel.id !== target.id ? (
          <p className="mt-1">
            {t('switchNumber', { from: channelLabel(savedChannel), to: targetName })}
          </p>
        ) : null}
        <p className="mt-1">{t('schedulerNote')}</p>
      </div>

      {isBridge ? (
        <div className="space-y-1.5">
          <Label htmlFor="wish-text" className="text-xs text-muted-foreground">
            {t('message')} <span className="text-red-400">*</span>
          </Label>
          <Textarea
            id="wish-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('messagePlaceholder', { token: NAME_TOKEN })}
            disabled={disabled}
            className={`${fieldClass} min-h-[110px] resize-none`}
          />
          <p className="text-xs text-muted-foreground">{t('nameHint', { token: NAME_TOKEN })}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('template')} <span className="text-red-400">*</span>
            </Label>
            {templates === null ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTemplates')}</p>
            ) : (
              <Select
                value={template ? tplKey : null}
                onValueChange={(v) => v && pickTemplate(String(v))}
                disabled={disabled}
                items={Object.fromEntries(
                  templates.map((tpl) => [
                    templateKey(tpl.name, tpl.language),
                    `${tpl.name}${tpl.language ? ` (${tpl.language})` : ''}`,
                  ]),
                )}
              >
                <SelectTrigger className="w-full" aria-label={t('template')}>
                  <SelectValue placeholder={t('pickTemplate')} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={templateKey(tpl.name, tpl.language)}>
                      {tpl.name}
                      {tpl.language ? ` (${tpl.language})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">{t('templateWhy')}</p>
            {wish?.template_name && templates !== null && templates.length > 0 && tplKey && !template ? (
              <p className="text-xs text-red-400">{t('templateGone', { name: wish.template_name })}</p>
            ) : null}
          </div>

          {template && slots ? (
            <>
              <div className="rounded-lg border border-border bg-background/50 p-3">
                <p className="whitespace-pre-wrap text-sm text-foreground">{template.body_text}</p>
              </div>
              {slots.headerVar !== null && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('headerValueFor', { var: `{{${slots.headerVar}}}` })}
                  </Label>
                  <Input
                    value={params.headerText}
                    onChange={(e) => setParams((p) => ({ ...p, headerText: e.target.value }))}
                    disabled={disabled}
                    className={`${fieldClass} h-8`}
                  />
                </div>
              )}
              {slots.bodyVars.map((v, i) => (
                <div key={v} className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('valueFor', { var: `{{${v}}}` })}
                  </Label>
                  <Input
                    value={params.body[i] ?? ''}
                    onChange={(e) =>
                      setParams((p) => {
                        const body = slots.bodyVars.map((_, j) => p.body[j] ?? '');
                        body[i] = e.target.value;
                        return { ...p, body };
                      })
                    }
                    placeholder={NAME_TOKEN}
                    disabled={disabled}
                    className={`${fieldClass} h-8`}
                  />
                </div>
              ))}
              {slots.urlButtonSlots.map((s) => (
                <div key={s.index} className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t('buttonValueFor', { text: s.text })}
                  </Label>
                  <Input
                    value={params.buttonParams[s.index] ?? ''}
                    onChange={(e) =>
                      setParams((p) => ({
                        ...p,
                        buttonParams: { ...p.buttonParams, [s.index]: e.target.value },
                      }))
                    }
                    disabled={disabled}
                    className={`${fieldClass} h-8`}
                  />
                </div>
              ))}
              {slots.bodyVars.length > 0 || slots.headerVar !== null ? (
                <p className="text-xs text-muted-foreground">{t('nameHint', { token: NAME_TOKEN })}</p>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {wish?.last_error ? (
        <p className="text-xs text-red-400">{t('lastError', { reason: wish.last_error })}</p>
      ) : wish?.last_sent_at ? (
        <p className="text-xs text-muted-foreground">
          {t('lastSent', {
            date: new Date(wish.last_sent_at).toLocaleDateString(locale, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
          })}
        </p>
      ) : null}

      {canSendMessages ? (
        <div className="flex gap-2">
          <Button
            onClick={save}
            disabled={disabled}
            size="sm"
            className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {t('save')}
          </Button>
          {wish ? (
            <Button onClick={remove} disabled={disabled} size="sm" variant="outline">
              {removing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {t('remove')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
