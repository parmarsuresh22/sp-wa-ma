'use client';

import { useTranslations } from 'next-intl';

import { SECTION_KEYS, type SectionKey } from '@/lib/auth/sections';

/**
 * Tick boxes for the parts of the portal an agent or viewer may open.
 *
 * `value === null` means "everything" (no restriction). Ticking "All
 * sections" off turns it into an explicit list the admin then edits.
 */
export function SectionChecklist({
  value,
  onChange,
  disabled,
}: {
  value: SectionKey[] | null;
  onChange: (next: SectionKey[] | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Settings.memberSections');
  const all = value === null;

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--primary)]"
          checked={all}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? null : ['dashboard', 'inbox'])}
        />
        <span>
          {t('all')}
          <span className="block text-xs text-muted-foreground">{t('allHint')}</span>
        </span>
      </label>
      {!all && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
            {SECTION_KEYS.map((key) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={value.includes(key)}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? SECTION_KEYS.filter((k) => k === key || value.includes(k))
                        : value.filter((k) => k !== key),
                    )
                  }
                />
                {t(`name.${key}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{value.length === 0 ? t('noneHint') : t('listHint')}</p>
        </>
      )}
    </div>
  );
}
