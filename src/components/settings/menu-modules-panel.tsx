'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2, Lock } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { SECTION_KEYS, type SectionKey } from '@/lib/auth/sections';
import { planAllows } from '@/lib/plans/plans';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Settings → Menu modules (migration 087). The owner ticks the modules
 * the menu shows for everyone in the account. A module left out is only
 * hidden from the menu: it keeps working and can be ticked back any
 * time.
 */
export function MenuModulesPanel() {
  const t = useTranslations('Settings.menuModules');
  const tNames = useTranslations('Settings.memberSections.name');
  const { account, isOwner, plan, refreshProfile } = useAuth();
  const saved = account?.menu_hidden ?? [];
  const [hidden, setHidden] = useState<SectionKey[] | null>(null);
  const [saving, setSaving] = useState(false);
  const current = hidden ?? SECTION_KEYS.filter((k) => saved.includes(k));
  const changed = hidden !== null && (hidden.length !== saved.length || hidden.some((k) => !saved.includes(k)));

  const toggle = (key: SectionKey, shown: boolean) =>
    setHidden(shown ? current.filter((k) => k !== key) : SECTION_KEYS.filter((k) => k === key || current.includes(k)));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/menu', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: current }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('saveFailed'));
      await refreshProfile();
      setHidden(null);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {!isOwner && <p className="text-sm text-amber-300">{t('ownerOnly')}</p>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {SECTION_KEYS.map((key) => {
            const shown = !current.includes(key);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={shown}
                  disabled={!isOwner || saving}
                  onChange={(e) => toggle(key, e.target.checked)}
                />
                <span className="flex-1">{tNames(key)}</span>
                {!planAllows(plan?.sections, key) && (
                  <Lock aria-label={t('notInPlan')} className="size-3.5 shrink-0 opacity-60" />
                )}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
        {isOwner && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={saving || !changed}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
            <Button variant="outline" disabled={saving || current.length === 0} onClick={() => setHidden([])}>
              {t('showAll')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
