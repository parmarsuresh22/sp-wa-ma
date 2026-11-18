'use client';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

export const CUSTOM_MESSAGE_MAX = 2000;

/** `{{name}}` → the recipient's name (or the fallback). */
export function renderCustomMessage(text: string, name: string | null | undefined, fallback = ''): string {
  const n = (name ?? '').trim() || fallback;
  return text.replace(/\{\{\s*name\s*\}\}/gi, n).trim();
}

interface Props {
  text: string;
  onChange: (text: string) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Free-text message for a WhatsApp Web number. No template catalogue
 * exists there, so the campaign is whatever you type here, with
 * `{{name}}` filled in per recipient.
 */
export function StepCustomMessage({ text, onChange, onNext, onBack }: Props) {
  const t = useTranslations('Broadcasts.wizard');
  const trimmed = text.trim();
  const tooLong = trimmed.length > CUSTOM_MESSAGE_MAX;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('customMessage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.raw('customMessage.intro')}</p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('customMessage.label')}
        </label>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={8}
          placeholder={t.raw('customMessage.inputPlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t.raw('customMessage.nameHint')}</span>
          <span className={tooLong ? 'text-red-400' : undefined}>
            {trimmed.length}/{CUSTOM_MESSAGE_MAX}
          </span>
        </div>
      </div>

      {trimmed && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t('customMessage.preview')}</p>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {renderCustomMessage(trimmed, t('customMessage.previewName'))}
          </p>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-100/80">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
        <p>{t('customMessage.warning')}</p>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!trimmed || tooLong}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
