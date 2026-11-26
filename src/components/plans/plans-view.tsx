'use client';

import { useTranslations } from 'next-intl';
import { Check, Loader2, Minus } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { SECTION_KEYS } from '@/lib/auth/sections';
import { PLAN_FEATURES, type Plan } from '@/lib/plans/plans';
import { cn } from '@/lib/utils';

/** Everything the plans include, side by side, with the account's own plan marked. */
export function PlansView() {
  const t = useTranslations('Plans');
  const { plans, plan, profileLoading } = useAuth();

  const label = (group: 'modules' | 'features', key: string) => (t.has(`${group}.${key}`) ? t(`${group}.${key}`) : key);
  const team = (p: Plan) => {
    const part = (n: number | null, one: string) => (n === null ? null : n === 0 ? null : t(one, { n }));
    if (p.max_admins === null && p.max_agents === null && p.max_viewers === null) return t('teamNoLimit');
    const parts = [part(p.max_admins, 'teamAdmins'), part(p.max_agents, 'teamAgents'), part(p.max_viewers, 'teamViewers')].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : t('teamOwnerOnly');
  };
  const mark = (on: boolean) =>
    on ? (
      <Check className="mx-auto size-4 text-emerald-400" aria-label={t('included')} />
    ) : (
      <Minus className="mx-auto size-4 text-muted-foreground/60" aria-label={t('readOnly')} />
    );

  return (
    <div className="min-w-0">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>

      {plans.length === 0 ? (
        <div className="flex justify-center py-16">
          {profileLoading ? <Loader2 className="size-5 animate-spin text-primary" /> : <p className="text-sm text-muted-foreground">{t('none')}</p>}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {plans.map((p) => {
              const mine = p.key === plan?.key;
              return (
                <div key={p.key} className={cn('rounded-xl border bg-card p-4', mine ? 'border-primary' : 'border-border')}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-foreground">{p.name}</h2>
                    {mine && (
                      <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">{t('yourPlan')}</span>
                    )}
                  </div>
                  {p.description && <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>}
                  <dl className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('modulesCount')}</dt>
                      <dd className="font-medium text-foreground">
                        {p.sections.length} / {SECTION_KEYS.length}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('webNumbers')}</dt>
                      <dd className="font-medium text-foreground">{p.web_number_limit}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{t('team')}</dt>
                      <dd className="text-right font-medium text-foreground">{team(p)}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>

          <div className="mt-5 overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[20rem] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('whatYouGet')}</th>
                  {plans.map((p) => (
                    <th key={p.key} className={cn('px-3 py-2 text-center font-semibold', p.key === plan?.key ? 'text-primary' : 'text-foreground')}>
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border bg-muted/40">
                  <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('modulesHead')}
                  </td>
                </tr>
                {SECTION_KEYS.map((key) => (
                  <tr key={key} className="border-b border-border/60">
                    <td className="px-3 py-2 text-foreground">{label('modules', key)}</td>
                    {plans.map((p) => (
                      <td key={p.key} className="px-3 py-2">
                        {mark(p.sections.includes(key))}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-b border-border bg-muted/40">
                  <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('settingsHead')}
                  </td>
                </tr>
                {PLAN_FEATURES.map((key) => (
                  <tr key={key} className="border-b border-border/60">
                    <td className="px-3 py-2 text-foreground">{label('features', key)}</td>
                    {plans.map((p) => (
                      <td key={p.key} className="px-3 py-2">
                        {mark(p.features.includes(key))}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-b border-border bg-muted/40">
                  <td colSpan={plans.length + 1} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('limitsHead')}
                  </td>
                </tr>
                <tr className="border-b border-border/60">
                  <td className="px-3 py-2 text-foreground">{t('webNumbers')}</td>
                  {plans.map((p) => (
                    <td key={p.key} className="px-3 py-2 text-center font-medium text-foreground">
                      {p.web_number_limit}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-3 py-2 text-foreground">{t('team')}</td>
                  {plans.map((p) => (
                    <td key={p.key} className="px-3 py-2 text-center text-foreground">
                      {team(p)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
            <li>{t('noteReadOnly')}</li>
            <li>{t('noteExisting')}</li>
            <li>{t('noteChange')}</li>
          </ul>
        </>
      )}
    </div>
  );
}
