'use client';

import { AccountPlanPicker, AccountPlansList, PlansSection, accountSubtitle, accountTitle } from './plans-admin';

/* The platform admin page (/admin8085). One person uses it, so its
 * text is plain English rather than routed through the locale files. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { readCache, writeCache } from '@/lib/client-cache';
import { useStickToBottom } from '@/hooks/use-stick-to-bottom';
import { usePageSize } from '@/hooks/use-page-size';
import { ListPager } from '@/components/ui/list-pager';
import type { AdminHome } from '@/lib/admin/overview';

// ------------------------------------------------------------
// Shapes returned by /api/admin8085/*
// ------------------------------------------------------------

interface AccountStats {
  account_id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  owner_name?: string | null;
  web_number_limit: number;
  plan_key?: string;
  // The usage counts arrive a moment after the list itself (they read
  // far more data), so every one of them may still be missing.
  last_sign_in_at?: string | null;
  members?: number;
  meta_numbers?: number;
  web_numbers?: number;
  web_connected?: number;
  web_pending?: number;
  contacts?: number;
  conversations?: number;
  messages_total?: number;
  messages_7d?: number;
  messages_30d?: number;
  last_message_at?: string | null;
  flows?: number;
  automations?: number;
  broadcasts?: number;
  data_tables?: number;
  ai_enabled?: boolean;
}

/** A count that may not have arrived yet. */
function num(v: number | undefined): string {
  return v === undefined ? '…' : String(v);
}

interface NumberRequest {
  id: string;
  account_id: string;
  label: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  created_at: string;
  decided_at: string | null;
  requested_by_email: string | null;
}

interface Overview {
  accounts: AccountStats[];
  requests: NumberRequest[];
  bridge: { configured: boolean; url?: string; source?: 'settings' | 'admin_channel' };
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

const th = 'px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap';
const td = 'px-3 py-2 text-sm text-foreground align-top';

export function AdminConsole({ email, initial }: { email: string; initial: AdminHome | null }) {
  // The page arrives with the list and the requests already in it; the
  // usage counts are fetched below and replace this once they are in.
  const [overview, setOverview] = useState<Overview | null>(
    initial ? { accounts: initial.accounts, requests: initial.requests, bridge: initial.bridge } : null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);
  // Two pages: the accounts, and the subscription plans.
  const [page, setPage] = useState<'accounts' | 'plans'>('accounts');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await api<Overview>('/api/admin8085/overview'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accountName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of overview?.accounts ?? []) m.set(a.account_id, a.name);
    return m;
  }, [overview]);

  const opened = overview?.accounts.find((a) => a.account_id === openAccount) ?? null;

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
          <ShieldCheck className="size-5 shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">Atlas · Platform admin</h1>
            <p className="truncate text-xs text-muted-foreground">Signed in as {email}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Admin pages">
              {(
                [
                  ['accounts', 'Accounts'],
                  ['plans', 'Plans'],
                ] as ['accounts' | 'plans', string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={page === id}
                  onClick={() => {
                    setPage(id);
                    setOpenAccount(null);
                  }}
                  className={
                    page === id
                      ? 'rounded bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground'
                      : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} aria-label="Refresh">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <a href="/dashboard" className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground">
              Back to app
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-3 py-4 sm:space-y-8 sm:px-4 sm:py-6">
        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {!overview && loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : overview && page === 'plans' ? (
          <>
            <PlansSection />
            <AccountPlansList accounts={overview.accounts} onChanged={load} />
          </>
        ) : overview && opened ? (
          <AccountDetail
            stats={opened}
            onBack={() => setOpenAccount(null)}
            onChanged={load}
          />
        ) : overview ? (
          <>
            <RequestsSection
              requests={overview.requests}
              accountName={accountName}
              bridgeConfigured={overview.bridge.configured}
              onChanged={load}
              onOpenAccount={setOpenAccount}
            />
            <BridgeSection bridge={overview.bridge} onChanged={load} />
            <GoogleSection initial={initial?.google ?? null} />
            <AccountsSection accounts={overview.accounts} onOpen={setOpenAccount} />
          </>
        ) : null}
      </main>
    </div>
  );
}

// ------------------------------------------------------------
// WhatsApp Web number requests
// ------------------------------------------------------------

function RequestsSection({
  requests,
  accountName,
  bridgeConfigured,
  onChanged,
  onOpenAccount,
}: {
  requests: NumberRequest[];
  accountName: Map<string, string>;
  bridgeConfigured: boolean;
  onChanged: () => Promise<void>;
  onOpenAccount: (id: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Decisions made here but not yet confirmed by the server: the row
  // leaves the waiting list at once and comes back if the call fails.
  const [decidedLocally, setDecidedLocally] = useState<Set<string>>(new Set());
  const pending = requests.filter((r) => r.status === 'pending' && !decidedLocally.has(r.id));
  const decided = requests.filter((r) => r.status !== 'pending').slice(0, 15);

  async function decide(r: NumberRequest, action: 'approve' | 'reject') {
    let note: string | null = null;
    if (action === 'reject') {
      note = window.prompt('Reason shown to the account (optional):', '');
      if (note === null) return;
    }
    setBusy(r.id);
    setDecidedLocally((prev) => new Set(prev).add(r.id));
    const settle = toast.loading(action === 'approve' ? 'Creating the number on the bridge…' : 'Rejecting…');
    try {
      await api(`/api/admin8085/requests/${r.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note }),
      });
      toast.success(
        action === 'approve'
          ? 'Approved — the account can now scan its QR code'
          : 'Request rejected',
        { id: settle },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: settle, duration: 8000 });
    } finally {
      setBusy(null);
      await onChanged();
      setDecidedLocally((prev) => {
        const next = new Set(prev);
        next.delete(r.id);
        return next;
      });
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold">
        WhatsApp Web number requests{' '}
        {pending.length > 0 && (
          <Badge className="ml-1 bg-amber-500/20 text-amber-300">{pending.length} waiting</Badge>
        )}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Approving creates the number on your bridge; the account then sees a QR code to scan.
      </p>

      {pending.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Nothing is waiting for approval.
        </p>
      ) : (
        <div className="space-y-2">
          {pending.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  <button
                    type="button"
                    className="hover:underline"
                    onClick={() => onOpenAccount(r.account_id)}
                  >
                    {accountName.get(r.account_id) ?? r.account_id}
                  </button>
                  {r.label ? <span className="text-muted-foreground"> · “{r.label}”</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.requested_by_email ?? 'unknown user'} · asked {when(r.created_at)}
                </p>
              </div>
              <Button
                size="sm"
                disabled={busy === r.id || !bridgeConfigured}
                onClick={() => void decide(r, 'approve')}
              >
                {busy === r.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === r.id}
                onClick={() => void decide(r, 'reject')}
              >
                <X className="size-4" />
                Reject
              </Button>
            </div>
          ))}
          {!bridgeConfigured && (
            <p className="text-xs text-amber-300">Set the platform bridge below before approving.</p>
          )}
        </div>
      )}

      {decided.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Recent decisions ({decided.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {decided.map((r) => (
              <li key={r.id}>
                <span
                  className={cn(
                    'font-medium',
                    r.status === 'approved' && 'text-emerald-400',
                    r.status === 'rejected' && 'text-red-400',
                  )}
                >
                  {r.status}
                </span>{' '}
                · {accountName.get(r.account_id) ?? r.account_id}
                {r.label ? ` · “${r.label}”` : ''} · {r.requested_by_email ?? ''} ·{' '}
                {when(r.decided_at ?? r.created_at)}
                {r.note ? ` · ${r.note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Platform bridge
// ------------------------------------------------------------

function BridgeSection({
  bridge,
  onChanged,
}: {
  bridge: Overview['bridge'];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api('/api/admin8085/bridge', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, api_key: key }),
      });
      toast.success('Platform bridge saved');
      setEditing(false);
      setUrl('');
      setKey('');
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Platform bridge</h2>
          <p className="text-xs text-muted-foreground">
            {bridge.configured ? (
              <>
                Approved numbers are created on <span className="font-mono">{bridge.url}</span>
                {bridge.source === 'admin_channel'
                  ? ' — borrowed from your own WhatsApp Web number. Save it here to make it permanent.'
                  : '.'}
              </>
            ) : (
              'No bridge is set, so requests cannot be approved yet.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : bridge.configured ? 'Change' : 'Set bridge'}
        </Button>
      </div>
      {editing && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            type="url"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://waha.example.com"
            className="bg-muted font-mono text-sm"
          />
          <Input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="WAHA API key"
            className="bg-muted font-mono text-sm"
          />
          <Button onClick={() => void save()} disabled={saving || !url.trim() || !key.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Google Drive (the OAuth client every account connects through)
// ------------------------------------------------------------

function GoogleSection({ initial }: { initial: { configured: boolean; client_id: string | null } | null }) {
  const [info, setInfo] = useState<{ configured: boolean; client_id: string | null; redirect_uri?: string } | null>(
    initial,
  );
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api('/api/admin8085/google'));
    } catch {
      /* card keeps what it had */
    }
  }, []);
  // The summary line comes with the page. The redirect address is only
  // needed by the set-up steps, so it is fetched when they are opened.
  const needsLoad = !info || (editing && !info.redirect_uri);
  useEffect(() => {
    if (needsLoad) void load();
  }, [needsLoad, load]);

  async function save() {
    setSaving(true);
    try {
      await api('/api/admin8085/google', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: secret }),
      });
      toast.success('Google client saved');
      setEditing(false);
      setClientId('');
      setSecret('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Google Drive for posts</h2>
          <p className="text-xs text-muted-foreground">
            {!info
              ? 'Loading…'
              : info.configured
                ? `Accounts can connect their Google Drive. Client: ${info.client_id}`
                : 'Not set up. Accounts cannot connect Google Drive until a Google OAuth client is saved here.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : info?.configured ? 'Change' : 'Set up'}
        </Button>
      </div>
      {editing && info && (
        <div className="mt-3 space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>In Google Cloud Console, create a project and enable the Google Drive API.</li>
            <li>
              Configure the OAuth consent screen (External) with the scope{' '}
              <span className="font-mono">.../auth/drive.file</span>, and publish it or add your
              customers as test users.
            </li>
            <li>
              Create an OAuth client ID of type Web application with this authorised redirect URI:{' '}
              <span className="break-all font-mono text-foreground">{info.redirect_uri ?? 'loading…'}</span>
            </li>
            <li>Paste its client ID and client secret below.</li>
          </ol>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              autoComplete="off"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
              className="bg-muted font-mono text-sm"
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Client secret"
              className="bg-muted font-mono text-sm"
            />
            <Button onClick={() => void save()} disabled={saving || !clientId.trim() || !secret.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------
// Accounts
// ------------------------------------------------------------

function AccountsSection({
  accounts,
  onOpen,
}: {
  accounts: AccountStats[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold">Accounts ({accounts.length})</h2>
      <ul className="space-y-2 md:hidden">
        {accounts.map((a) => (
          <li key={a.account_id}>
            <button
              type="button"
              onClick={() => onOpen(a.account_id)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-left active:bg-muted/50"
            >
              <span className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{accountTitle(a)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{accountSubtitle(a)}</span>
                </span>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              </span>
              <span className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <span>
                  <span className="block text-muted-foreground">Contacts</span>
                  {num(a.contacts)}
                </span>
                <span>
                  <span className="block text-muted-foreground">Chats</span>
                  {num(a.conversations)}
                </span>
                <span>
                  <span className="block text-muted-foreground">Msgs 7d</span>
                  {num(a.messages_7d)}
                </span>
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">
                Numbers: API {num(a.meta_numbers)} · Web {num(a.web_numbers)}/{a.web_number_limit}
                {(a.web_pending ?? 0) > 0 && <span className="text-amber-300"> · {a.web_pending} waiting</span>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Joined {when(a.created_at)} · last sign-in {when(a.last_sign_in_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full border-collapse">
          <thead className="bg-muted/50">
            <tr>
              <th className={th}>Account</th>
              <th className={th}>Joined</th>
              <th className={th}>Last sign-in</th>
              <th className={th}>Team</th>
              <th className={th}>Numbers</th>
              <th className={th}>Contacts</th>
              <th className={th}>Chats</th>
              <th className={th}>Messages 7d / 30d / all</th>
              <th className={th}>Last message</th>
              <th className={th}>Built</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr
                key={a.account_id}
                className="cursor-pointer border-t border-border hover:bg-muted/40"
                onClick={() => onOpen(a.account_id)}
              >
                <td className={td}>
                  <p className="font-medium">{accountTitle(a)}</p>
                  <p className="text-xs text-muted-foreground">{accountSubtitle(a)}</p>
                </td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.created_at)}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.last_sign_in_at)}</td>
                <td className={td}>{num(a.members)}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>
                  <p>API: {num(a.meta_numbers)}</p>
                  <p>
                    Web: {num(a.web_numbers)}/{a.web_number_limit}
                    {(a.web_numbers ?? 0) > 0 ? ` (${a.web_connected} connected)` : ''}
                  </p>
                  {(a.web_pending ?? 0) > 0 && <p className="text-amber-300">{a.web_pending} waiting</p>}
                </td>
                <td className={td}>{num(a.contacts)}</td>
                <td className={td}>{num(a.conversations)}</td>
                <td className={cn(td, 'whitespace-nowrap')}>
                  {num(a.messages_7d)} / {num(a.messages_30d)} / {num(a.messages_total)}
                </td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.last_message_at)}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>
                  <p>
                    {num(a.flows)} flows · {num(a.automations)} automations
                  </p>
                  <p>
                    {num(a.broadcasts)} broadcasts · {num(a.data_tables)} tables
                  </p>
                  <p>AI agent: {a.ai_enabled === undefined ? '…' : a.ai_enabled ? 'on' : 'off'}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// One account
// ------------------------------------------------------------

interface AccountDetailData {
  account: { id: string; name: string; created_at: string; web_number_limit: number };
  members: {
    user_id: string;
    full_name: string | null;
    email: string | null;
    account_role: string;
    created_at: string;
    last_sign_in_at: string | null;
  }[];
  channels: {
    id: string;
    provider: string | null;
    label: string | null;
    display_phone: string | null;
    status: string;
    bridge_status: string | null;
    is_default: boolean;
    connected_at: string | null;
    created_at: string;
  }[];
  ai: {
    provider: string;
    model: string;
    is_active: boolean;
    auto_reply_enabled: boolean;
    system_prompt: string | null;
    updated_at: string;
  } | null;
  flows: { id: string; name: string; status: string; trigger_type: string; execution_count: number; last_executed_at: string | null }[];
  automations: { id: string; name: string; is_active: boolean; trigger_type: string; execution_count: number; last_executed_at: string | null }[];
  broadcasts: { id: string; name: string; status: string; total_recipients: number; sent_count: number; delivered_count: number; read_count: number; failed_count: number; created_at: string }[];
  dataTables: { id: string; name: string; access: string; source_type: string; created_at: string }[];
}

type DetailTab = 'overview' | 'chats' | 'contacts';

function AccountDetail({
  stats,
  onBack,
  onChanged,
}: {
  stats: AccountStats;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  // Shown at once from the last visit, then refreshed.
  const detailKey = `admin:detail:${stats.account_id}`;
  const [detail, setDetail] = useState<AccountDetailData | null>(
    () => readCache<AccountDetailData>(detailKey) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(String(stats.web_number_limit));
  // A new plan brings its own number limit.
  const [seenLimit, setSeenLimit] = useState(stats.web_number_limit);
  if (seenLimit !== stats.web_number_limit) {
    setSeenLimit(stats.web_number_limit);
    setLimit(String(stats.web_number_limit));
  }
  const [savingLimit, setSavingLimit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<AccountDetailData>(`/api/admin8085/accounts/${stats.account_id}`)
      .then((d) => {
        writeCache(`admin:detail:${stats.account_id}`, d);
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [stats.account_id]);

  async function saveLimit() {
    const n = Number.parseInt(limit, 10);
    if (!Number.isInteger(n) || n < 0 || n > 50) {
      toast.error('Enter a whole number from 0 to 50');
      return;
    }
    setSavingLimit(true);
    try {
      await api(`/api/admin8085/accounts/${stats.account_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ web_number_limit: n }),
      });
      toast.success('Limit saved');
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLimit(false);
    }
  }

  const channelName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of detail?.channels ?? []) {
      m.set(c.id, c.label || c.display_phone || (c.provider === 'waha' ? 'WhatsApp Web' : 'WhatsApp API'));
    }
    return m;
  }, [detail]);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          All accounts
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold leading-tight">{accountTitle(stats)}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {accountSubtitle(stats)} · joined {when(stats.created_at)}
          </p>
        </div>
        <AccountPlanPicker
          accountId={stats.account_id}
          planKey={stats.plan_key}
          onChanged={async () => {
            await onChanged();
          }}
        />
        <div className="flex w-full items-center gap-2 text-xs text-muted-foreground sm:ml-auto sm:w-auto">
          WhatsApp Web number limit
          <Input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            inputMode="numeric"
            className="h-8 w-16 bg-muted text-center"
          />
          <Button size="sm" variant="outline" onClick={() => void saveLimit()} disabled={savingLimit}>
            {savingLimit && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {(
          [
            ['overview', 'Overview'],
            ['chats', stats.conversations === undefined ? 'Chats' : `Chats (${stats.conversations})`],
            ['contacts', stats.contacts === undefined ? 'Contacts' : `Contacts (${stats.contacts})`],
          ] as [DetailTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {tab === 'overview' &&
        (detail ? (
          <AccountOverview detail={detail} />
        ) : !error ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : null)}
      {tab === 'chats' && <ChatsBrowser accountId={stats.account_id} channelName={channelName} />}
      {tab === 'contacts' && <ContactsBrowser accountId={stats.account_id} />}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 break-words">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

function AccountOverview({ detail }: { detail: AccountDetailData }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Block title={`Team (${detail.members.length})`}>
        <ul className="space-y-1.5 text-sm">
          {detail.members.map((m) => (
            <li key={m.user_id} className="rounded-md border border-border px-3 py-2">
              <p className="font-medium">
                {m.full_name || m.email || m.user_id}{' '}
                <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px] font-normal">
                  {m.account_role}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="break-all">{m.email ?? '—'}</span> · last sign-in {when(m.last_sign_in_at)}
              </p>
            </li>
          ))}
        </ul>
      </Block>

      <Block title={`WhatsApp numbers (${detail.channels.length})`}>
        {detail.channels.length === 0 ? (
          <Empty text="No number linked." />
        ) : (
          <ul className="space-y-1.5 text-sm">
            {detail.channels.map((c) => (
              <li key={c.id} className="rounded-md border border-border px-3 py-2">
                <p className="font-medium">
                  {c.label || c.display_phone || 'Unnamed'}{' '}
                  <Badge variant="outline" className="ml-1 h-5 px-1.5 text-[10px] font-normal">
                    {c.provider === 'waha' ? 'Web' : 'API'}
                  </Badge>
                  {c.is_default && <span className="ml-1 text-xs text-amber-300">default</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.display_phone ?? 'no number yet'} ·{' '}
                  <span className={c.status === 'connected' ? 'text-emerald-400' : 'text-red-400'}>
                    {c.status}
                  </span>
                  {c.bridge_status ? ` (${c.bridge_status})` : ''} · added {when(c.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="AI agent">
        {detail.ai ? (
          <div className="rounded-md border border-border px-3 py-2 text-sm">
            <p>
              {detail.ai.provider} · {detail.ai.model} ·{' '}
              {detail.ai.is_active ? 'on' : 'off'} · auto-reply{' '}
              {detail.ai.auto_reply_enabled ? 'on' : 'off'}
            </p>
            {detail.ai.system_prompt && (
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {detail.ai.system_prompt}
              </p>
            )}
          </div>
        ) : (
          <Empty text="Not set up." />
        )}
      </Block>

      <Block title={`Data tables (${detail.dataTables.length})`}>
        {detail.dataTables.length === 0 ? (
          <Empty text="None." />
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.dataTables.map((t) => (
              <li key={t.id}>
                {t.name}{' '}
                <span className="text-xs text-muted-foreground">
                  · {t.access} · {t.source_type} · {when(t.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={`Flows (${detail.flows.length})`}>
        {detail.flows.length === 0 ? (
          <Empty text="None." />
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.flows.map((f) => (
              <li key={f.id}>
                {f.name}{' '}
                <span className="text-xs text-muted-foreground">
                  · {f.status} · {f.trigger_type} · ran {f.execution_count}× · last{' '}
                  {when(f.last_executed_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={`Automations (${detail.automations.length})`}>
        {detail.automations.length === 0 ? (
          <Empty text="None." />
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.automations.map((a) => (
              <li key={a.id}>
                {a.name}{' '}
                <span className="text-xs text-muted-foreground">
                  · {a.is_active ? 'on' : 'off'} · {a.trigger_type} · ran {a.execution_count}× · last{' '}
                  {when(a.last_executed_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <div className="lg:col-span-2">
        <Block title={`Broadcasts (${detail.broadcasts.length})`}>
          {detail.broadcasts.length === 0 ? (
            <Empty text="None." />
          ) : (
            <ul className="space-y-1 text-sm">
              {detail.broadcasts.map((b) => (
                <li key={b.id}>
                  {b.name}{' '}
                  <span className="text-xs text-muted-foreground">
                    · {b.status} · {b.total_recipients} recipients · sent {b.sent_count} · delivered{' '}
                    {b.delivered_count} · read {b.read_count} · failed {b.failed_count} ·{' '}
                    {when(b.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Paged lists
// ------------------------------------------------------------

interface Paged<T> {
  rows: T[];
  total: number;
  pageSize: number;
}

function usePaged<T>(accountId: string, section: 'conversations' | 'contacts') {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = usePageSize();
  const cacheKey = `admin:${section}:${accountId}:${offset}:${limit}:${applied}`;
  const [data, setData] = useState<Paged<T> | null>(() => readCache<Paged<T>>(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);

  // Debounce typing; a new search starts from the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(q.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ section, offset: String(offset), limit: String(limit) });
    if (applied) params.set('q', applied);
    const key = `admin:${section}:${accountId}:${offset}:${limit}:${applied}`;
    api<Paged<T>>(`/api/admin8085/accounts/${accountId}?${params.toString()}`)
      .then((d) => {
        writeCache(key, d);
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, section, offset, limit, applied]);

  // A page seen before shows at once; otherwise the previous page stays
  // on screen until the new one arrives.
  return { q, setQ, offset, setOffset, data: readCache<Paged<T>>(cacheKey) ?? data, error };
}

function Pager({
  offset,
  total,
  pageSize,
  onChange,
}: {
  offset: number;
  total: number;
  pageSize: number;
  onChange: (offset: number) => void;
}) {
  // The server answers in offsets; the shared pager thinks in pages.
  return (
    <ListPager
      page={Math.floor(offset / Math.max(1, pageSize))}
      pageSize={pageSize}
      total={total}
      onChange={(p) => onChange(p * pageSize)}
      className="pt-2"
    />
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-muted pl-8"
      />
    </div>
  );
}

interface ChatRow {
  id: string;
  status: string;
  channel_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
}

interface ChatMessage {
  id: string;
  sender_type: 'customer' | 'agent' | 'bot';
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  template_name: string | null;
  status: string | null;
  ai_generated: boolean | null;
  error_title: string | null;
  created_at: string;
}

function ChatsBrowser({
  accountId,
  channelName,
}: {
  accountId: string;
  channelName: Map<string, string>;
}) {
  const { q, setQ, offset, setOffset, data, error } = usePaged<ChatRow>(accountId, 'conversations');
  const [selected, setSelected] = useState<ChatRow | null>(null);
  const closeChat = useCallback(() => setSelected(null), []);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <div className="min-w-0">
        <SearchBox value={q} onChange={setQ} placeholder="Search name or phone" />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {data && <Pager offset={offset} total={data.total} pageSize={data.pageSize} onChange={setOffset} />}
        <ul className="mt-2 space-y-1 lg:max-h-[65vh] lg:overflow-y-auto">
          {(data?.rows ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className={cn(
                  'w-full rounded-md border px-3 py-2.5 text-left hover:bg-muted/50 active:bg-muted/50',
                  selected?.id === c.id ? 'border-primary bg-muted/40' : 'border-border',
                )}
              >
                <p className="truncate text-sm font-medium">
                  {c.contact?.name || c.contact?.phone || 'Unknown'}
                </p>
                <p className="truncate text-xs text-muted-foreground">{c.last_message_text ?? '—'}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {c.contact?.phone ?? ''} · {c.channel_id ? channelName.get(c.channel_id) ?? 'number' : 'number removed'} ·{' '}
                  {when(c.last_message_at)}
                </p>
              </button>
            </li>
          ))}
          {data && data.rows.length === 0 && <Empty text="No chats." />}
        </ul>
        {data && <Pager offset={offset} total={data.total} pageSize={data.pageSize} onChange={setOffset} />}
      </div>
      {/* On a phone the open chat is a pop-up over the page, closed with
          its Close button or by tapping outside it; from lg up it sits
          beside the list. */}
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
        className={cn(
          'min-w-0 lg:static lg:block lg:h-auto lg:w-auto lg:min-h-[300px] lg:rounded-lg lg:border lg:border-border',
          selected ? 'fixed left-0 top-0 z-30 h-dvh w-screen bg-black/70 p-2 lg:bg-transparent lg:p-0' : 'hidden',
        )}
      >
        {selected ? (
          <ChatMessages key={selected.id} chat={selected} onBack={closeChat} />
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Pick a chat to read it.</p>
        )}
      </div>
    </div>
  );
}

function ChatMessages({ chat, onBack }: { chat: ChatRow; onBack: () => void }) {
  const cacheKey = `admin:messages:${chat.id}`;
  const cached = readCache<{ messages: ChatMessage[]; hasMore: boolean }>(cacheKey);
  const [messages, setMessages] = useState<ChatMessage[]>(cached?.messages ?? []);
  const [hasMore, setHasMore] = useState(cached?.hasMore ?? false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // What the next paint should do with the scroll position: jump to the
  // newest message, or stay on the message that was at the top before
  // older ones were added above it.
  const pendingScroll = useRef<{ kind: 'bottom' } | { kind: 'keep'; height: number } | null>(
    cached ? { kind: 'bottom' } : null,
  );

  const loadPage = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const qs = before ? `?before=${encodeURIComponent(before)}` : '';
        const d = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
          `/api/admin8085/conversations/${chat.id}${qs}`,
        );
        pendingScroll.current = before
          ? { kind: 'keep', height: scroller.current?.scrollHeight ?? 0 }
          : { kind: 'bottom' };
        if (!before) writeCache(`admin:messages:${chat.id}`, d);
        setMessages((prev) => (before ? [...d.messages, ...prev] : d.messages));
        setHasMore(d.hasMore);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [chat.id],
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  // While the pop-up is open on a phone the page behind stays still,
  // and Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    const phone = window.matchMedia('(max-width: 1023px)').matches;
    const before = document.body.style.overflow;
    if (phone) document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      if (phone) document.body.style.overflow = before;
    };
  }, [onBack]);

  // Stay on the newest message while attachments load.
  useStickToBottom(scroller, chat.id);

  useLayoutEffect(() => {
    const el = scroller.current;
    const want = pendingScroll.current;
    if (!el || !want) return;
    pendingScroll.current = null;
    el.scrollTop = want.kind === 'bottom' ? el.scrollHeight : el.scrollHeight - want.height;
  }, [messages]);

  return (
    <div
      role="dialog"
      aria-label="Chat"
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl lg:h-auto lg:max-h-[72vh] lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 lg:px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{chat.contact?.name || chat.contact?.phone || 'Unknown'}</p>
          <p className="truncate text-xs text-muted-foreground">{chat.contact?.phone ?? ''}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 lg:hidden" onClick={onBack}>
          <X className="size-4" />
          Close
        </Button>
      </div>
      <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-3 lg:p-4">
        {hasMore && (
          <div className="text-center">
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void loadPage(messages[0]?.created_at)}
            >
              Load older messages
            </Button>
          </div>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {loading && messages.length === 0 && <Loader2 className="mx-auto size-5 animate-spin text-primary" />}
        {messages.map((m) => {
          const mine = m.sender_type !== 'customer';
          return (
            <div key={m.id} className={cn('flex min-w-0', mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'min-w-0 max-w-[88%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed sm:max-w-[78%] lg:rounded-lg lg:text-sm',
                  mine ? 'bg-primary/15' : 'bg-muted',
                )}
              >
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {m.content_text || `[${m.template_name ? `template: ${m.template_name}` : m.content_type}]`}
                </p>
                {m.media_url && (
                  <a
                    href={m.media_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline"
                  >
                    {m.content_type} attachment
                  </a>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground lg:text-[10px]">
                  {m.sender_type === 'bot' || m.ai_generated ? 'AI' : m.sender_type} · {when(m.created_at)}
                  {mine && m.status ? ` · ${m.status}` : ''}
                  {m.error_title ? ` · ${m.error_title}` : ''}
                </p>
              </div>
            </div>
          );
        })}
        {!loading && messages.length === 0 && !error && <Empty text="No messages." />}
      </div>
    </div>
  );
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
  created_at: string;
}

function ContactsBrowser({ accountId }: { accountId: string }) {
  const { q, setQ, offset, setOffset, data, error } = usePaged<ContactRow>(accountId, 'contacts');
  return (
    <div>
      <div className="max-w-sm">
        <SearchBox value={q} onChange={setQ} placeholder="Search name, phone or email" />
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      {data && <Pager offset={offset} total={data.total} pageSize={data.pageSize} onChange={setOffset} />}
      <ul className="mt-2 space-y-1.5 md:hidden">
        {(data?.rows ?? []).map((c) => (
          <li key={c.id} className="rounded-md border border-border px-3 py-2">
            <p className="truncate text-sm font-medium">{c.name || c.phone || '—'}</p>
            <p className="text-xs text-muted-foreground">
              {c.phone ?? '—'}
              {c.company ? ` · ${c.company}` : ''}
            </p>
            {c.email && <p className="break-all text-xs text-muted-foreground">{c.email}</p>}
            <p className="text-[11px] text-muted-foreground">Added {when(c.created_at)}</p>
          </li>
        ))}
        {data && data.rows.length === 0 && <li className="p-2 text-sm text-muted-foreground">No contacts.</li>}
      </ul>
      <div className="mt-2 hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full border-collapse">
          <thead className="bg-muted/50">
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Phone</th>
              <th className={th}>Email</th>
              <th className={th}>Company</th>
              <th className={th}>Added</th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className={td}>{c.name ?? '—'}</td>
                <td className={td}>{c.phone ?? '—'}</td>
                <td className={td}>{c.email ?? '—'}</td>
                <td className={td}>{c.company ?? '—'}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No contacts.</p>}
      </div>
      {data && <Pager offset={offset} total={data.total} pageSize={data.pageSize} onChange={setOffset} />}
    </div>
  );
}
