'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  Clock,
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
import { useChannels, channelLabel, mutateChannels, type ChannelSummary } from '@/hooks/use-channels';
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

/** A request for a WhatsApp Web number (migration 071). */
interface WebNumberRequest {
  id: string;
  label: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  channel_id: string | null;
  note: string | null;
  created_at: string;
}

interface WebNumberUsage {
  linked: number;
  pending: number;
  limit: number;
}

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

  // WhatsApp Web numbers are approved by the platform before they can
  // be linked: a request sits here as "pending approval" and turns into
  // a channel (with a QR code) once approved.
  const [requests, setRequests] = useState<WebNumberRequest[]>([]);
  const [usage, setUsage] = useState<WebNumberUsage | null>(null);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  const loadRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/web-number-requests', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { requests?: WebNumberRequest[]; usage?: WebNumberUsage };
      const rows = data.requests ?? [];
      // A request we were waiting on just got approved: show its QR.
      const approved = rows.find(
        (r) => r.status === 'approved' && r.channel_id && pendingIdsRef.current.has(r.id),
      );
      pendingIdsRef.current = new Set(rows.filter((r) => r.status === 'pending').map((r) => r.id));
      setRequests(rows);
      setUsage(data.usage ?? null);
      if (approved?.channel_id) {
        await refresh();
        setSelection({ kind: 'channel', id: approved.channel_id });
        toast.success(t('requestApproved', { name: approved.label || t('unnamedNumber') }));
      }
    } catch {
      /* next poll retries */
    }
  }, [refresh, t]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  // Poll only while something is waiting for a decision.
  const hasPending = requests.some((r) => r.status === 'pending');
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void loadRequests(), 5_000);
    return () => clearInterval(timer);
  }, [hasPending, loadRequests]);

  const withdrawRequest = useCallback(
    async (r: WebNumberRequest) => {
      // Off the screen now; the reload below restores it on failure.
      setRequests((prev) => prev.filter((x) => x.id !== r.id));
      if (r.status === 'pending') {
        pendingIdsRef.current.delete(r.id);
        setUsage((u) => (u ? { ...u, pending: Math.max(0, u.pending - 1) } : u));
      }
      const res = await fetch(`/api/whatsapp/web-number-requests/${r.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('updateFailed'));
      } else if (r.status === 'pending') {
        toast.success(t('requestCancelled'));
      }
      await loadRequests();
    },
    [loadRequests, t],
  );

  const openRequests = useMemo(
    () => requests.filter((r) => r.status === 'pending' || r.status === 'rejected'),
    [requests],
  );

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
      // Move the star now; the server call confirms it.
      mutateChannels((rows) => rows.map((c) => ({ ...c, is_default: c.id === ch.id })));
      const res = await fetch(`/api/whatsapp/channels/${ch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('updateFailed'));
        await refresh();
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
      // Take it off the screen at once (here, in the inbox dropdown,
      // everywhere the list is shown). If the server refuses, the
      // refresh below puts it back.
      mutateChannels((rows) => rows.filter((c) => c.id !== ch.id));
      setSelection(null);
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
        void loadRequests();
      }
    },
    [refresh, loadRequests, t],
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

      {/* WhatsApp Web numbers waiting for (or refused) approval */}
      {openRequests.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {openRequests.map((r) => {
            const pending = r.status === 'pending';
            return (
              <div
                key={r.id}
                className={cn(
                  'flex items-start gap-3 rounded-xl border border-dashed bg-card p-3',
                  pending ? 'border-amber-500/50' : 'border-red-500/40',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full',
                    pending ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400',
                  )}
                >
                  {pending ? <Clock className="size-4" /> : <XCircle className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {r.label || t('unnamedNumber')}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn(
                      'mt-0.5 h-5 px-1.5 text-[10px] font-normal',
                      pending ? 'border-amber-500/50 text-amber-300' : 'border-red-500/40 text-red-300',
                    )}
                  >
                    {pending ? t('pendingApproval') : t('notApproved')}
                  </Badge>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pending ? t('pendingApprovalDesc') : r.note || t('notApprovedDesc')}
                  </p>
                  {canEditSettings && (
                    <button
                      type="button"
                      onClick={() => void withdrawRequest(r)}
                      className="mt-1.5 text-xs text-muted-foreground underline hover:text-foreground"
                    >
                      {pending ? t('cancelRequest') : t('dismissRequest')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
        usage={usage}
        onRequested={(created) => {
          // Show the pending card straight from the server's answer.
          pendingIdsRef.current.add(created.id);
          setRequests((prev) => [created, ...prev.filter((x) => x.id !== created.id)]);
          setUsage((u) => (u ? { ...u, pending: u.pending + 1 } : u));
          void loadRequests();
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
  usage,
  onRequested,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usage: WebNumberUsage | null;
  onRequested: (created: WebNumberRequest) => void;
}) {
  const t = useTranslations('Settings.whatsapp.channels');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setFieldError(null);
      setConfirmOpen(false);
    }
  }, [open]);

  const used = usage ? usage.linked + usage.pending : 0;
  const atLimit = !!usage && used >= usage.limit;

  // The number is hosted for the account, so all it gives is a name;
  // the request then waits for approval before a QR code is issued.
  async function submit() {
    setConfirmOpen(false);
    setSaving(true);
    setFieldError(null);
    try {
      const res = await fetch('/api/whatsapp/web-number-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          data.code === 'web_number_limit' && data.usage
            ? t('limitReached', { limit: data.usage.limit })
            : data.error || t('requestFailed');
        setFieldError(message);
        toast.error(message, { duration: 8000 });
        return;
      }
      toast.success(t('requestSent'), { duration: 8000 });
      onOpenChange(false);
      onRequested(data.request as WebNumberRequest);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('addBridgeTitle')}</DialogTitle>
          <DialogDescription>{t('addBridgeDescApproval')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('labelField')}</Label>
            <Input
              name="waha-channel-label"
              autoComplete="off"
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('labelPlaceholder')}
              className="bg-muted border-border"
            />
          </div>
          {usage && (
            <p className={cn('text-xs', atLimit ? 'text-amber-300' : 'text-muted-foreground')}>
              {atLimit
                ? t('limitReached', { limit: usage.limit })
                : t('webNumberLimit', { used, limit: usage.limit })}
            </p>
          )}
          {fieldError && <p className="text-sm text-red-400">{fieldError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => setConfirmOpen(true)} disabled={saving || atLimit}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
            {saving ? t('requestSending') : t('requestSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Read-and-accept before the request is sent. */}
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
              {t('acceptAndRequest')}
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
    // Show the new name now and close; a refusal reloads the old one.
    const nextLabel = value.trim() || null;
    mutateChannels((rows) => rows.map((c) => (c.id === channel.id ? { ...c, label: nextLabel } : c)));
    onOpenChange(false);
    try {
      const res = await fetch(`/api/whatsapp/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: value.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('updateFailed'));
      }
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
