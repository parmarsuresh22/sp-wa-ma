'use client';

/* The platform admin page (/admin8085). One person uses it, so its
 * text is plain English rather than routed through the locale files. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
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

// ------------------------------------------------------------
// Shapes returned by /api/admin8085/*
// ------------------------------------------------------------

interface AccountStats {
  account_id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  last_sign_in_at: string | null;
  members: number;
  meta_numbers: number;
  web_numbers: number;
  web_connected: number;
  web_pending: number;
  web_number_limit: number;
  contacts: number;
  conversations: number;
  messages_total: number;
  messages_7d: number;
  messages_30d: number;
  last_message_at: string | null;
  flows: number;
  automations: number;
  broadcasts: number;
  data_tables: number;
  ai_enabled: boolean;
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

export function AdminConsole({ email }: { email: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);

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
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <ShieldCheck className="size-5 text-primary" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">Atlas · Platform admin</h1>
            <p className="truncate text-xs text-muted-foreground">Signed in as {email}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh
            </Button>
            <a href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
              Back to app
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-4 py-6">
        {error && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {!overview && loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
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
      <div className="overflow-x-auto rounded-lg border border-border">
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
                  <p className="font-medium">{a.name}</p>
                  <p className="text-xs text-muted-foreground">{a.owner_email ?? '—'}</p>
                </td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.created_at)}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.last_sign_in_at)}</td>
                <td className={td}>{a.members}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>
                  <p>API: {a.meta_numbers}</p>
                  <p>
                    Web: {a.web_numbers}/{a.web_number_limit}
                    {a.web_numbers > 0 ? ` (${a.web_connected} connected)` : ''}
                  </p>
                  {a.web_pending > 0 && <p className="text-amber-300">{a.web_pending} waiting</p>}
                </td>
                <td className={td}>{a.contacts}</td>
                <td className={td}>{a.conversations}</td>
                <td className={cn(td, 'whitespace-nowrap')}>
                  {a.messages_7d} / {a.messages_30d} / {a.messages_total}
                </td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>{when(a.last_message_at)}</td>
                <td className={cn(td, 'whitespace-nowrap text-xs')}>
                  <p>
                    {a.flows} flows · {a.automations} automations
                  </p>
                  <p>
                    {a.broadcasts} broadcasts · {a.data_tables} tables
                  </p>
                  <p>AI agent: {a.ai_enabled ? 'on' : 'off'}</p>
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
  const [detail, setDetail] = useState<AccountDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(String(stats.web_number_limit));
  const [savingLimit, setSavingLimit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<AccountDetailData>(`/api/admin8085/accounts/${stats.account_id}`)
      .then((d) => {
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
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight">{stats.name}</h2>
          <p className="text-xs text-muted-foreground">
            {stats.owner_email ?? '—'} · joined {when(stats.created_at)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
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

      <div className="flex gap-1 border-b border-border">
        {(
          [
            ['overview', 'Overview'],
            ['chats', `Chats (${stats.conversations})`],
            ['contacts', `Contacts (${stats.contacts})`],
          ] as [DetailTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
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
    <div>
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
    <div className="grid gap-6 lg:grid-cols-2">
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
                {m.email ?? '—'} · last sign-in {when(m.last_sign_in_at)}
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
  const [data, setData] = useState<Paged<T> | null>(null);
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
    const params = new URLSearchParams({ section, offset: String(offset) });
    if (applied) params.set('q', applied);
    api<Paged<T>>(`/api/admin8085/accounts/${accountId}?${params.toString()}`)
      .then((d) => {
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
  }, [accountId, section, offset, applied]);

  return { q, setQ, offset, setOffset, data, error };
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
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
      <span>
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <span className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + pageSize >= total}
          onClick={() => onChange(offset + pageSize)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </span>
    </div>
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

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <div>
        <SearchBox value={q} onChange={setQ} placeholder="Search name or phone" />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <ul className="mt-2 max-h-[65vh] space-y-1 overflow-y-auto">
          {(data?.rows ?? []).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className={cn(
                  'w-full rounded-md border px-3 py-2 text-left hover:bg-muted/50',
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
      <div className="min-h-[300px] rounded-lg border border-border">
        {selected ? (
          <ChatMessages key={selected.id} chat={selected} />
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">Pick a chat to read it.</p>
        )}
      </div>
    </div>
  );
}

function ChatMessages({ chat }: { chat: ChatRow }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const qs = before ? `?before=${encodeURIComponent(before)}` : '';
        const d = await api<{ messages: ChatMessage[]; hasMore: boolean }>(
          `/api/admin8085/conversations/${chat.id}${qs}`,
        );
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

  return (
    <div className="flex max-h-[72vh] flex-col">
      <div className="border-b border-border px-4 py-2">
        <p className="text-sm font-medium">{chat.contact?.name || chat.contact?.phone || 'Unknown'}</p>
        <p className="text-xs text-muted-foreground">{chat.contact?.phone ?? ''}</p>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
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
            <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[78%] rounded-lg px-3 py-2 text-sm',
                  mine ? 'bg-primary/15' : 'bg-muted',
                )}
              >
                <p className="whitespace-pre-wrap break-words">
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
                <p className="mt-1 text-[10px] text-muted-foreground">
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
      <div className="mt-2 overflow-x-auto rounded-lg border border-border">
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
