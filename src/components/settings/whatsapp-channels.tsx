'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  QrCode,
  RotateCcw,
  Smartphone,
  Star,
  Trash2,
  Unlink,
  XCircle,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel, type ChannelSummary } from '@/hooks/use-channels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';

type Selection = { kind: 'channel'; id: string } | { kind: 'new-meta' } | null;

/**
 * Settings → WhatsApp. The account's numbers ("channels", migration
 * 061): Meta Cloud API numbers and WhatsApp Web sessions on a self-run
 * WAHA bridge. Pick one to manage it; add more with the buttons on the
 * right. The Meta form below is the pre-061 settings panel, now scoped
 * to the selected channel.
 */
export function WhatsAppChannels() {
  const t = useTranslations('Settings.whatsapp.channels');
  const tw = useTranslations('Settings.whatsapp');
  const { canEditSettings } = useAuth();
  const { channels, loading, refresh } = useChannels();
  const [selection, setSelection] = useState<Selection>(null);
  const [addBridgeOpen, setAddBridgeOpen] = useState(false);
  const [renaming, setRenaming] = useState<ChannelSummary | null>(null);

  // What the page shows: the user's pick when it still exists, else
  // the default channel, else (fresh account) the blank Meta form.
  const effective: Selection = useMemo(() => {
    if (!channels) return selection;
    if (selection?.kind === 'new-meta') return selection;
    if (selection?.kind === 'channel' && channels.some((c) => c.id === selection.id)) return selection;
    if (channels.length === 0) return { kind: 'new-meta' };
    const def = channels.find((c) => c.is_default) ?? channels[0];
    return { kind: 'channel', id: def.id };
  }, [channels, selection]);

  const selected = useMemo(
    () => (effective?.kind === 'channel' ? channels?.find((c) => c.id === effective.id) ?? null : null),
    [channels, effective],
  );

  const setDefault = useCallback(
    async (ch: ChannelSummary) => {
      const res = await fetch(`/api/whatsapp/channels/${ch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('updateFailed'));
        return;
      }
      toast.success(t('defaultSet', { name: channelLabel(ch) }));
      await refresh();
    },
    [refresh, t],
  );

  const removingRef = useRef<string | null>(null);
  const remove = useCallback(
    async (ch: ChannelSummary) => {
      if (removingRef.current === ch.id) return; // guard a double-fired click
      if (!confirm(t('removeConfirm', { name: channelLabel(ch) }))) return;
      removingRef.current = ch.id;
      try {
        const res = await fetch(`/api/whatsapp/channels/${ch.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast.error(data.error || t('removeFailed'));
        } else {
          toast.success(t('removed'));
          setSelection(null);
        }
      } finally {
        removingRef.current = null;
        // Whatever the answer, the list on screen may be stale.
        await refresh();
      }
    },
    [refresh, t],
  );

  const onMetaChanged = useCallback(
    async (id: string | null) => {
      await refresh();
      setSelection(id ? { kind: 'channel', id } : null);
    },
    [refresh],
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEditSettings ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelection({ kind: 'new-meta' })}
                className={cn(effective?.kind === 'new-meta' && 'border-primary text-primary')}
              >
                <Plus className="size-4" />
                {t('addMeta')}
              </Button>
              <Button size="sm" onClick={() => setAddBridgeOpen(true)}>
                <QrCode className="size-4" />
                {t('addBridge')}
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Channel list */}
      {loading && !channels ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="mb-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {channels.map((ch) => {
            const active = effective?.kind === 'channel' && effective.id === ch.id;
            const connected = ch.status === 'connected';
            return (
              <div
                key={ch.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelection({ kind: 'channel', id: ch.id })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelection({ kind: 'channel', id: ch.id });
                }}
                className={cn(
                  'flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted/50',
                  active ? 'border-primary ring-1 ring-primary/40' : 'border-border',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full',
                    connected ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {ch.provider === 'waha' ? <Smartphone className="size-4" /> : <Zap className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-foreground">{channelLabel(ch)}</span>
                    {ch.is_default && (
                      <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label={t('default')} />
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                      {ch.provider === 'waha' ? t('providerWaha') : t('providerMeta')}
                    </Badge>
                    <span className="inline-flex items-center gap-1">
                      <span
                        className={cn('size-1.5 rounded-full', connected ? 'bg-emerald-500' : 'bg-red-500')}
                      />
                      {connected ? t('connected') : t('disconnected')}
                    </span>
                    {ch.label && ch.display_phone && (
                      <span className="truncate">{ch.display_phone}</span>
                    )}
                  </div>
                </div>
                {canEditSettings && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      onClick={(e) => e.stopPropagation()}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t('actions')}
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="border-border bg-popover">
                      <DropdownMenuItem onClick={() => setRenaming(ch)}>
                        <Pencil className="size-4" /> {t('rename')}
                      </DropdownMenuItem>
                      {!ch.is_default && (
                        <DropdownMenuItem onClick={() => void setDefault(ch)}>
                          <Star className="size-4" /> {t('setDefault')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => void remove(ch)}>
                        <Trash2 className="size-4" /> {t('remove')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Selected channel */}
      {effective?.kind === 'new-meta' && (
        <>
          {channels && channels.length > 0 && (
            <Alert className="mb-4 bg-card border-border">
              <AlertTitle className="text-foreground">{t('newMetaTitle')}</AlertTitle>
              <AlertDescription className="text-muted-foreground">{t('newMetaDesc')}</AlertDescription>
            </Alert>
          )}
          <WhatsAppConfig key="new-meta" channelId={null} embedded onChanged={onMetaChanged} />
        </>
      )}
      {selected && selected.provider !== 'waha' && (
        <WhatsAppConfig key={selected.id} channelId={selected.id} embedded onChanged={onMetaChanged} />
      )}
      {selected && selected.provider === 'waha' && (
        <BridgeChannelPanel key={selected.id} channel={selected} canEdit={canEditSettings} onChanged={refresh} />
      )}

      <AddBridgeDialog
        open={addBridgeOpen}
        onOpenChange={setAddBridgeOpen}
        onCreated={async (id) => {
          await refresh();
          setSelection({ kind: 'channel', id });
        }}
      />

      <RenameDialog
        channel={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        onRenamed={refresh}
      />

      {/* Shared note for admins about where the Meta webhook lives */}
      {!canEditSettings && (
        <p className="mt-6 text-xs text-muted-foreground">{tw('readOnlyHint')}</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// WhatsApp Web (WAHA bridge) channel: pairing + session controls
// ------------------------------------------------------------

interface BridgeState {
  status: string | null;
  phone: string | null;
  pushName: string | null;
  qr: string | null;
  qrImage: string | null;
  webhookOk?: boolean | null;
  error: string | null;
}

function BridgeChannelPanel({
  channel,
  canEdit,
  onChanged,
}: {
  channel: ChannelSummary;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const [state, setState] = useState<BridgeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp/channels/${channel.id}/bridge`, { cache: 'no-store' });
      const data = (await res.json()) as BridgeState & { error?: string };
      if (!res.ok) {
        setState({ status: null, phone: null, pushName: null, qr: null, qrImage: null, error: data.error ?? null });
        return;
      }
      setState(data);
    } catch (err) {
      setState({
        status: null,
        phone: null,
        pushName: null,
        qr: null,
        qrImage: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [channel.id]);

  // Poll quickly while pairing (QR codes rotate every ~20 s), slowly
  // once the session is working.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await poll();
      if (cancelled) return;
      const working = state?.status === 'WORKING';
      timer = setTimeout(tick, working ? 20_000 : 4_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, state?.status === 'WORKING']);

  // Status changes should reflect in the channel list (dot, number).
  const lastStatus = state?.status;
  useEffect(() => {
    if (lastStatus) void onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStatus]);

  const act = async (action: 'start' | 'restart' | 'logout' | 'stop' | 'repair_webhook') => {
    setBusy(action);
    try {
      const res = await fetch(`/api/whatsapp/channels/${channel.id}/bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('actionFailed'));
        return;
      }
      toast.success(t('actionDone'));
      setState(null);
      await poll();
    } finally {
      setBusy(null);
    }
  };

  const status = state?.status ?? channel.bridge_status ?? null;
  const working = status === 'WORKING';
  const pairing = status === 'SCAN_QR_CODE';

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {working ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {working ? t('bridgeConnected') : pairing ? t('bridgePairing') : t('bridgeDisconnected')}
            </AlertTitle>
            {status && (
              <Badge variant="outline" className="ml-auto h-5 px-1.5 text-[10px] font-mono">
                {status}
              </Badge>
            )}
          </div>
          <AlertDescription className="text-muted-foreground">
            {working
              ? t('bridgeConnectedDesc', {
                  phone: state?.phone ?? channel.display_phone ?? '',
                  name: state?.pushName ?? '',
                })
              : pairing
                ? t('bridgePairingDesc')
                : state?.error
                  ? state.error
                  : t('bridgeDisconnectedDesc')}
          </AlertDescription>
        </Alert>

        {state?.webhookOk === false && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <AlertTitle className="text-amber-200">{t('webhookMismatchTitle')}</AlertTitle>
            <AlertDescription className="text-amber-100/80 text-xs leading-relaxed">
              <p>{t('webhookMismatchDesc')}</p>
              {canEdit && (
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void act('repair_webhook')}
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {busy === 'repair_webhook' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  {t('fixWebhook')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {pairing && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('scanTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">{t('scanDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              {state?.qrImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.qrImage}
                  alt={t('scanTitle')}
                  className="size-64 rounded-lg bg-white p-2"
                />
              ) : state?.qr ? (
                <div className="w-full">
                  <p className="mb-1 text-xs text-muted-foreground">{t('qrRawHint')}</p>
                  <textarea
                    readOnly
                    value={state.qr}
                    className="h-24 w-full rounded-md border border-border bg-muted p-2 font-mono text-[10px] text-foreground"
                  />
                </div>
              ) : (
                <div className="flex size-64 items-center justify-center rounded-lg border border-dashed border-border">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              )}
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                <li>{t('scanStep1')}</li>
                <li>{t('scanStep2')}</li>
                <li>{t('scanStep3')}</li>
              </ol>
            </CardContent>
          </Card>
        )}

        {canEdit && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('sessionTitle')}</CardTitle>
              <CardDescription className="text-muted-foreground">{t('sessionDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {!working && (
                <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act('start')}>
                  {busy === 'start' ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
                  {t('start')}
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act('restart')}>
                {busy === 'restart' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                {t('restart')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => {
                  if (confirm(t('relinkConfirm'))) void act('logout');
                }}
              >
                {busy === 'logout' ? <Loader2 className="size-4 animate-spin" /> : <Unlink className="size-4" />}
                {t('relink')}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('bridgeDetailsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">{t('bridgeManagedNote')}</p>
            {(state?.phone ?? channel.display_phone) && (
              <div>
                <Label className="text-muted-foreground">{t('linkedNumber')}</Label>
                <p className="text-foreground">{state?.phone ?? channel.display_phone}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Alert className="bg-amber-950/30 border-amber-700/50">
          <AlertTitle className="text-amber-200">{t('bridgeLimitsTitle')}</AlertTitle>
          <AlertDescription className="text-amber-100/80 text-xs leading-relaxed">
            {t('bridgeLimitsDesc')}
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Add a WhatsApp Web channel
// ------------------------------------------------------------

function AddBridgeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channelId: string) => Promise<void> | void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const { channels } = useChannels();
  // A bridge already linked on this account: the server reuses its
  // address and saved API key, so the form only asks for a name.
  const existingBridge = useMemo(
    () => (channels ?? []).find((c) => c.provider === 'waha' && c.bridge_configured) ?? null,
    [channels],
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setBaseUrl('');
      setApiKey('');
      setSessionName('');
      setFieldError(null);
      setConfirmOpen(false);
    }
  }, [open]);

  const firstBridge = !existingBridge;

  function requestLink() {
    if (firstBridge && (!baseUrl.trim() || !apiKey.trim())) {
      toast.error(t('bridgeFieldsRequired'));
      return;
    }
    setConfirmOpen(true);
  }

  async function submit() {
    setConfirmOpen(false);
    setSaving(true);
    setFieldError(null);
    try {
      const res = await fetch('/api/whatsapp/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'waha',
          label: label.trim() || null,
          // Blank = reuse the bridge (and key) already linked on this account.
          bridge_base_url: firstBridge ? baseUrl.trim() : '',
          bridge_api_key: firstBridge ? apiKey.trim() : '',
          session_name: sessionName.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFieldError(data.error || t('createFailed'));
        toast.error(data.error || t('createFailed'), { duration: 8000 });
        return;
      }
      toast.success(t('created'));
      onOpenChange(false);
      await onCreated(data.channel.id as string);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('addBridgeTitle')}</DialogTitle>
          <DialogDescription>{firstBridge ? t('addBridgeDesc') : t('addBridgeDescReuse')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('labelField')}</Label>
            <Input
              name="waha-channel-label"
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('labelPlaceholder')}
              className="bg-muted border-border"
            />
          </div>
          {firstBridge && (
          <>
          <div className="space-y-2">
            <Label>{t('bridgeUrl')}</Label>
            <Input
              type="url"
              name="waha-bridge-url"
              autoComplete="off"
              inputMode="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://waha.example.com"
              className="bg-muted border-border font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t('bridgeUrlHint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('bridgeApiKey')}</Label>
            <Input
              type="password"
              name="waha-bridge-api-key"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="WAHA_API_KEY"
              className="bg-muted border-border font-mono text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label>
              {t('sessionName')} <span className="text-muted-foreground">{t('optional')}</span>
            </Label>
            <Input
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="wacrm-sales"
              className="bg-muted border-border font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{t('sessionNameHint')}</p>
          </div>
          </>
          )}
          {!firstBridge && (
            <p className="text-xs text-muted-foreground">{t('bridgeReuseNote')}</p>
          )}
          {fieldError && <p className="text-sm text-red-400">{fieldError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={requestLink} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
            {saving ? t('creating') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Read-and-accept before a QR code is issued. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('bridgeLimitsTitle')}</DialogTitle>
            <DialogDescription>{t('bridgeLimitsDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
              {t('acceptAndLink')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Rename
// ------------------------------------------------------------

function RenameDialog({
  channel,
  onOpenChange,
  onRenamed,
}: {
  channel: ChannelSummary | null;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => Promise<void> | void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(channel?.label ?? '');
  }, [channel]);

  async function submit() {
    if (!channel) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/whatsapp/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: value.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('updateFailed'));
        return;
      }
      onOpenChange(false);
      await onRenamed();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!channel} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('rename')}</DialogTitle>
          <DialogDescription>{t('renameDesc')}</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('labelPlaceholder')}
          maxLength={80}
          className="bg-muted border-border"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
