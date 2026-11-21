'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrandMark } from '@/components/brand/brand-mark';
import { SettingsPanelHead } from './settings-panel-head';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_BRAND_NAME = 40;

/**
 * Business branding (migration 079): the business's own name and one
 * logo at the top of the portal, with the product name small beneath.
 * Off by default; only owners and admins can change it.
 */
export function BrandingPanel() {
  const t = useTranslations('Settings.branding');
  const tBrand = useTranslations('Sidebar');
  const { account, canEditSettings, refreshProfile } = useAuth();

  const [enabled, setEnabled] = useState(account?.brand_enabled ?? false);
  const [name, setName] = useState(account?.brand_name ?? '');
  const [logo, setLogo] = useState<string | null>(account?.brand_logo_url ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const off = !canEditSettings;

  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast.error(t('logoType'));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t('logoTooLarge'));
      return;
    }
    setUploading(true);
    try {
      const up = await uploadAccountMedia('chat-media', file);
      setLogo(up.publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, name, logo_url: logo }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('saveFailed'));
      await refreshProfile();
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const shownName = name.trim();
  const usable = enabled && (!!shownName || !!logo);

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="space-y-5 rounded-xl border border-border bg-card p-4">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--primary)]"
            checked={enabled}
            disabled={off}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            {t('enable')}
            <span className="block text-xs text-muted-foreground">{t('enableHint')}</span>
          </span>
        </label>

        <label className="block text-xs text-muted-foreground">
          <span className="mb-1 block">{t('nameLabel')}</span>
          <Input
            className="bg-muted sm:w-80"
            value={name}
            maxLength={MAX_BRAND_NAME}
            disabled={off}
            placeholder={t('namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t('logoLabel')}</p>
          <input
            ref={fileRef}
            type="file"
            accept={LOGO_TYPES.join(',')}
            className="hidden"
            onChange={(e) => void pickLogo(e.target.files?.[0])}
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" className="size-full object-contain" />
              ) : (
                <ImagePlus className="size-6 text-muted-foreground" />
              )}
            </span>
            <Button variant="outline" size="sm" disabled={off || uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              {logo ? t('logoReplace') : t('logoUpload')}
            </Button>
            {logo && (
              <Button variant="outline" size="sm" disabled={off} onClick={() => setLogo(null)}>
                <Trash2 className="size-4" />
                {t('logoRemove')}
              </Button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('logoHint')}</p>
        </div>

        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t('preview')}</p>
          <div className="flex h-14 w-60 max-w-full items-center gap-2 rounded-lg border border-border bg-background px-4">
            {usable ? (
              <>
                {logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logo} alt="" className="size-8 shrink-0 rounded-md object-contain" />
                ) : (
                  <BrandMark className="size-8 shrink-0" />
                )}
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {shownName || tBrand('title')}
                  </span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {tBrand('title')} {tBrand('titleBy')}
                  </span>
                </span>
              </>
            ) : (
              <>
                <BrandMark className="size-8 shrink-0" />
                <span className="flex items-baseline gap-1.5">
                  <span className="text-base font-semibold text-foreground">{tBrand('title')}</span>
                  <span className="text-[10px] text-muted-foreground">{tBrand('titleBy')}</span>
                </span>
              </>
            )}
          </div>
          {enabled && !shownName && !logo && <p className="mt-1 text-xs text-amber-300">{t('needOne')}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save()} disabled={off || saving || uploading}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
          {off && <span className="text-xs text-muted-foreground">{t('adminOnly')}</span>}
        </div>
      </div>
    </div>
  );
}
