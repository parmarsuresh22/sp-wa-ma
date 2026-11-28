'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bot,
  CalendarCheck,
  Cake,
  Contact,
  KanbanSquare,
  Megaphone,
  MessagesSquare,
  Ticket,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { BrandMark } from '@/components/brand/brand-mark';
import { cn } from '@/lib/utils';

/* The sign-in and sign-up screens: the form on one side and, moving
 * slowly behind it (phone) or beside it (wide screen), cards saying
 * what the portal does for a business and for one person working
 * alone. The movement is CSS only (globals.css); for anyone who asked
 * their device for less motion it slows right down instead of stopping,
 * because the moving cards are the point of the screen. */

type Feature = { key: string; icon: LucideIcon; who: 'business' | 'individual' };

const FEATURES: Feature[] = [
  { key: 'inbox', icon: MessagesSquare, who: 'business' },
  { key: 'service', icon: Wrench, who: 'individual' },
  { key: 'broadcasts', icon: Megaphone, who: 'business' },
  { key: 'wishes', icon: Cake, who: 'individual' },
  { key: 'ai', icon: Bot, who: 'business' },
  { key: 'appointments', icon: CalendarCheck, who: 'individual' },
  { key: 'events', icon: Ticket, who: 'business' },
  { key: 'contacts', icon: Contact, who: 'individual' },
  { key: 'pipelines', icon: KanbanSquare, who: 'business' },
  { key: 'automations', icon: Workflow, who: 'business' },
];

/** "Atlas" with "by LLC Solution" under it. */
export function BrandLockup({ className }: { className?: string }) {
  const t = useTranslations('AuthShowcase');
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <BrandMark className="h-11 w-11 shrink-0" />
      <div className="leading-tight">
        <p className="text-2xl font-bold tracking-tight text-foreground">Atlas</p>
        <p className="text-xs font-medium text-muted-foreground">{t('byline')}</p>
      </div>
    </div>
  );
}

function Column({ items, direction, className }: { items: Feature[]; direction: 'up' | 'down'; className?: string }) {
  const t = useTranslations('AuthShowcase');
  // The list twice over, so the loop has no seam: the column slides by
  // exactly one copy and starts again.
  return (
    <div className={cn('w-full max-w-[260px] flex-1', className)}>
      <ul className={direction === 'up' ? 'auth-col-up' : 'auth-col-down'}>
        {[...items, ...items].map((f, i) => {
          const Icon = f.icon;
          return (
            <li
              key={`${f.key}-${i}`}
              className="auth-card mb-4 rounded-2xl border border-border bg-card/90 p-4 shadow-sm"
              style={{ animationDelay: `${(i % items.length) * -1.3}s` }}
            >
              <span className="flex items-center gap-2">
                <span
                  className="auth-icon flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10"
                  style={{ animationDelay: `${(i % items.length) * -0.7}s` }}
                >
                  <Icon className="size-5 text-primary" />
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    f.who === 'business' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-500',
                  )}
                >
                  {t(f.who)}
                </span>
              </span>
              <span className="mt-3 block text-sm font-semibold text-foreground">{t(`${f.key}.title`)}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t(`${f.key}.text`)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  const t = useTranslations('AuthShowcase');
  const half = Math.ceil(FEATURES.length / 2);
  return (
    <div className="relative min-h-screen overflow-hidden bg-background lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="pointer-events-none absolute inset-0 overflow-hidden lg:relative lg:inset-auto lg:border-r lg:border-border">
        <div aria-hidden="true" className="absolute inset-0">
          <div className="auth-blob absolute -left-24 -top-24 size-80 rounded-full bg-primary/35 blur-3xl" />
          <div className="auth-blob auth-blob-slow absolute -bottom-28 -right-20 size-96 rounded-full bg-[#ff6d5a]/30 blur-3xl" />
          <div className="auth-blob auth-blob-mid absolute left-1/3 top-1/3 size-64 rounded-full bg-emerald-500/15 blur-3xl" />
          <div className="absolute inset-0 flex justify-center gap-4 px-4 opacity-40 [mask-image:linear-gradient(to_bottom,transparent,black_12%,black_88%,transparent)] lg:px-8 lg:opacity-100 lg:[mask-image:linear-gradient(to_bottom,transparent,black_10%,black_48%,transparent_64%)]">
            <Column items={FEATURES.slice(0, half)} direction="up" />
            <Column items={FEATURES.slice(half)} direction="down" />
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-background from-60% to-transparent p-10 pt-24 lg:block">
          <BrandLockup />
          <h2 className="mt-5 max-w-lg text-3xl font-bold leading-tight tracking-tight text-foreground">
            {t('headline')}
          </h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{t('subline')}</p>
        </div>
      </aside>

      <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-5 px-4 py-8">
        {/* On a phone the cards pass behind these two, so each sits on its own patch. */}
        <BrandLockup className="rounded-2xl bg-background/80 px-4 py-2 backdrop-blur lg:hidden" />
        {children}
        <p className="rounded-full bg-background/80 px-3 py-1 text-center text-xs text-muted-foreground backdrop-blur">{t('footer')}</p>
      </main>
    </div>
  );
}
