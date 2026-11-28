'use client';

import { useTranslations } from 'next-intl';
import { Check, Circle } from 'lucide-react';

import { PASSWORD_RULES, passwordChecks, passwordTooGuessable } from '@/lib/auth/password';

/**
 * The list under a new-password field: each rule turns green as the
 * password meets it, so nobody has to submit to learn what is missing.
 */
export function PasswordRules({ password, email }: { password: string; email?: string | null }) {
  const t = useTranslations('PasswordRules');
  const checks = passwordChecks(password);
  const guessable = password.length > 0 && passwordTooGuessable(password, email);
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">{t('title')}</p>
      <ul className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
        {PASSWORD_RULES.map((rule) => (
          <li
            key={rule}
            className={
              checks[rule]
                ? 'flex items-center gap-1.5 text-xs text-emerald-500'
                : 'flex items-center gap-1.5 text-xs text-muted-foreground'
            }
          >
            {checks[rule] ? <Check className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
            {t(rule)}
          </li>
        ))}
      </ul>
      {guessable && <p className="mt-1 text-xs text-red-400">{t('guessable')}</p>}
    </div>
  );
}
