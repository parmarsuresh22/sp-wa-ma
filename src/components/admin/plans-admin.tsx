'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { SECTION_KEYS, type SectionKey } from '@/lib/auth/sections';
import { PLAN_FEATURES, type Plan, type PlanFeature } from '@/lib/plans/plans';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type AdminPlan = Plan & { accounts: number };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

/** Names for the admin page. A module added later shows under its key until named here. */
const MODULE_NAMES: Partial<Record<SectionKey, string>> = {
  dashboard: 'Dashboard',
  inbox: 'Inbox + Notifications',
  contacts: 'Contacts',
  pipelines: 'Pipelines',
  broadcasts: 'Broadcasts',
  posts: 'Posts',
  appointments: 'Appointments',
  events: 'Events',
  service: 'Service Today',
  automations: 'Automations',
  flows: 'Flows',
  agents: 'AI Agents',
  data: 'Data tables',
};
const FEATURE_NAMES: Record<PlanFeature, string> = {
  branding: 'Business branding',
  wishes: 'Wish scheduler',
  api_keys: 'API keys',
};
const TEAM: { key: 'max_admins' | 'max_agents' | 'max_viewers'; label: string }[] = [
  { key: 'max_admins', label: 'Admins' },
  { key: 'max_agents', label: 'Agents' },
  { key: 'max_viewers', label: 'Viewers' },
];

/**
 * What each plan includes: the menu modules, the parts of Settings, and
 * the limits. A module added to the portal appears here by itself,
 * unticked, ready to be given to a plan.
 */
export function PlansSection() {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlans((await api<{ plans: AdminPlan[] }>('/api/admin8085/plans')).plans);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const change = (key: string, patch: Partial<AdminPlan>) =>
    setPlans((prev) => (prev ?? []).map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const toggle = <T extends string>(list: T[], item: T, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item));

  const save = async (plan: AdminPlan) => {
    setSaving(plan.key);
    try {
      await api('/api/admin8085/plans', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      });
      toast.success(`${plan.name} saved`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const cell = 'px-2 py-1.5 text-center';
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Plans and modules</h2>
        <p className="text-xs text-muted-foreground">
          Tick what each plan includes. A module that is not ticked stays in the customer&apos;s menu, read-only. Changes reach every
          account on the plan within half a minute.
        </p>
      </div>
      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>}
      {!plans ? (
        !error && (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[26rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium text-muted-foreground">Plan</th>
                {plans.map((p) => (
                  <th key={p.key} className="px-2 py-2">
                    <Input
                      value={p.name}
                      maxLength={40}
                      aria-label={`Name of the ${p.key} plan`}
                      onChange={(e) => change(p.key, { name: e.target.value })}
                      className="h-8 min-w-28 bg-muted text-center font-semibold"
                    />
                    <span className="mt-1 block text-center text-[11px] font-normal text-muted-foreground">
                      {p.accounts} {p.accounts === 1 ? 'account' : 'accounts'}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border bg-muted/40">
                <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Menu modules
                </td>
              </tr>
              {SECTION_KEYS.map((key) => (
                <tr key={key} className="border-b border-border/60">
                  <td className="px-3 py-1.5">{MODULE_NAMES[key] ?? key}</td>
                  {plans.map((p) => (
                    <td key={p.key} className={cell}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        aria-label={`${MODULE_NAMES[key] ?? key} in ${p.name}`}
                        checked={p.sections.includes(key)}
                        onChange={(e) => change(p.key, { sections: toggle(p.sections, key, e.target.checked) })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-border bg-muted/40">
                <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Settings
                </td>
              </tr>
              {PLAN_FEATURES.map((key) => (
                <tr key={key} className="border-b border-border/60">
                  <td className="px-3 py-1.5">{FEATURE_NAMES[key]}</td>
                  {plans.map((p) => (
                    <td key={p.key} className={cell}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        aria-label={`${FEATURE_NAMES[key]} in ${p.name}`}
                        checked={p.features.includes(key)}
                        onChange={(e) => change(p.key, { features: toggle(p.features, key, e.target.checked) })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-border bg-muted/40">
                <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Limits (leave a team box empty for no limit)
                </td>
              </tr>
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5">WhatsApp Web numbers</td>
                {plans.map((p) => (
                  <td key={p.key} className={cell}>
                    <Input
                      inputMode="numeric"
                      value={String(p.web_number_limit)}
                      aria-label={`WhatsApp Web numbers in ${p.name}`}
                      onChange={(e) => change(p.key, { web_number_limit: Number.parseInt(e.target.value.replace(/\D/g, '') || '0', 10) })}
                      className="mx-auto h-8 w-16 bg-muted text-center"
                    />
                  </td>
                ))}
              </tr>
              {TEAM.map((row) => (
                <tr key={row.key} className="border-b border-border/60">
                  <td className="px-3 py-1.5">Team: {row.label}</td>
                  {plans.map((p) => (
                    <td key={p.key} className={cell}>
                      <Input
                        inputMode="numeric"
                        placeholder="No limit"
                        value={p[row.key] === null ? '' : String(p[row.key])}
                        aria-label={`${row.label} in ${p.name}`}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, '');
                          change(p.key, { [row.key]: digits === '' ? null : Number.parseInt(digits, 10) } as Partial<AdminPlan>);
                        }}
                        className="mx-auto h-8 w-20 bg-muted text-center"
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5 align-top">Shown on the Plans page</td>
                {plans.map((p) => (
                  <td key={p.key} className="px-2 py-1.5">
                    <textarea
                      value={p.description ?? ''}
                      maxLength={300}
                      rows={2}
                      aria-label={`Description of ${p.name}`}
                      onChange={(e) => change(p.key, { description: e.target.value })}
                      className="w-full min-w-28 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-3 py-2" />
                {plans.map((p) => (
                  <td key={p.key} className={cell}>
                    <Button size="sm" onClick={() => void save(p)} disabled={saving !== null}>
                      {saving === p.key && <Loader2 className="size-4 animate-spin" />}
                      Save
                    </Button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The plan of one account: choosing another replaces the one it had. */
export function AccountPlanPicker({
  accountId,
  planKey,
  onChanged,
  plans: given,
  bare,
}: {
  accountId: string;
  planKey: string | undefined;
  onChanged: () => void | Promise<void>;
  /** The plans, when the caller already has them. */
  plans?: AdminPlan[];
  /** Hide the word "Subscription" (a table column says it). */
  bare?: boolean;
}) {
  const [loaded, setPlans] = useState<AdminPlan[]>([]);
  const plans = given ?? loaded;
  const [current, setCurrent] = useState(planKey ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (given) return;
    let gone = false;
    api<{ plans: AdminPlan[] }>('/api/admin8085/plans')
      .then((d) => {
        if (!gone) setPlans(d.plans);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [given]);

  const assign = async (key: string) => {
    const before = current;
    setCurrent(key);
    setSaving(true);
    try {
      await api(`/api/admin8085/accounts/${accountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_key: key }),
      });
      toast.success(`Plan changed to ${plans.find((p) => p.key === key)?.name ?? key}`);
      await onChanged();
    } catch (err) {
      setCurrent(before);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {bare ? <span className="sr-only">Subscription</span> : 'Subscription'}
      <select
        value={current}
        disabled={saving || plans.length === 0}
        onChange={(e) => void assign(e.target.value)}
        className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
      >
        {!plans.some((p) => p.key === current) && <option value={current}>{current || '…'}</option>}
        {plans.map((p) => (
          <option key={p.key} value={p.key}>
            {p.name}
          </option>
        ))}
      </select>
      {saving && <Loader2 className="size-4 animate-spin" />}
    </label>
  );
}

/**
 * Every account with its plan beside it. Choosing another plan saves at
 * once and replaces the one the account had.
 */
export function AccountPlansList({
  accounts,
  onChanged,
}: {
  accounts: { account_id: string; name: string; owner_email: string | null; plan_key?: string; web_number_limit: number }[];
  onChanged: () => void | Promise<void>;
}) {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('');

  const loadPlans = useCallback(async () => {
    try {
      setPlans((await api<{ plans: AdminPlan[] }>('/api/admin8085/plans')).plans);
    } catch {
      setPlans((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void loadPlans(), 0);
    return () => clearTimeout(timer);
  }, [loadPlans]);

  const needle = q.trim().toLowerCase();
  const rows = accounts.filter(
    (a) =>
      (!only || a.plan_key === only) &&
      (!needle || a.name.toLowerCase().includes(needle) || (a.owner_email ?? '').toLowerCase().includes(needle)),
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Accounts and their plans</h2>
        <p className="text-xs text-muted-foreground">
          Pick a plan beside an account; it is saved at once and replaces the plan the account had. A new account starts on Standard.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="h-8 w-full bg-muted sm:w-64" />
        <select
          value={only}
          aria-label="Show accounts on one plan"
          onChange={(e) => setOnly(e.target.value)}
          className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
        >
          <option value="">All plans ({accounts.length})</option>
          {(plans ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} ({accounts.filter((a) => a.plan_key === p.key).length})
            </option>
          ))}
        </select>
      </div>
      {!plans ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No account matches.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((a) => (
            <li key={a.account_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-sm font-semibold">{a.name}</p>
                <p className="truncate text-xs text-muted-foreground">{a.owner_email ?? '—'}</p>
              </div>
              <AccountPlanPicker
                key={`${a.account_id}:${a.plan_key ?? ''}`}
                accountId={a.account_id}
                planKey={a.plan_key}
                plans={plans}
                bare
                onChanged={async () => {
                  await Promise.all([onChanged(), loadPlans()]);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
