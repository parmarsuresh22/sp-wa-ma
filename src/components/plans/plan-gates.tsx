'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { planHasFeature, type PlanFeature } from '@/lib/plans/plans';

/** The strip that says why a page can be read but not used. */
export function PlanLockNotice({ text, sticky }: { text: string; sticky?: boolean }) {
  const t = useTranslations('Plans');
  return (
    <div
      role="note"
      className={
        'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-200 ' +
        // On a module page it stays in view while the page scrolls.
        (sticky ? 'sticky top-0 z-20 bg-[#2b2110]' : 'bg-amber-500/10')
      }
    >
      <Lock className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      <Link href="/plans" className="font-semibold underline underline-offset-2">
        {t('seePlans')}
      </Link>
    </div>
  );
}

/** Above a module page that is outside the account's plan. */
export function PlanModuleNotice() {
  const t = useTranslations('Plans');
  const { plan, planLocked } = useAuth();
  if (!planLocked) return null;
  return <PlanLockNotice sticky text={t('moduleLocked', { plan: plan?.name ?? '' })} />;
}

/**
 * A part of Settings the plan may not include: it is still shown, with
 * everything in it switched off. The server refuses the change as well.
 */
export function PlanFeatureGate({ feature, children }: { feature: PlanFeature; children: React.ReactNode }) {
  const t = useTranslations('Plans');
  const { plan } = useAuth();
  if (planHasFeature(plan, feature)) return <>{children}</>;
  return (
    <>
      <PlanLockNotice text={t('featureLocked', { plan: plan?.name ?? '' })} />
      <fieldset disabled className="min-w-0 opacity-70">
        {children}
      </fieldset>
    </>
  );
}
