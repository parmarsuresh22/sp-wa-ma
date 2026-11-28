'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleHelp, ExternalLink } from 'lucide-react';

import { SUPPORT_EMAIL } from '@/lib/auth/blocked';
import { HELP_TOPICS, isOutsideLink, type HelpLang, type HelpTopic, type HelpTopicKey } from '@/lib/help/topics';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const LANG_KEY = 'atlas-help-lang';
const LANGS: { id: HelpLang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'हिंदी' },
];

/** The language the reader last chose for help texts (this browser only). */
export function useHelpLang(): [HelpLang, (lang: HelpLang) => void] {
  const [lang, setLang] = useState<HelpLang>('en');
  useEffect(() => {
    try {
      if (window.localStorage.getItem(LANG_KEY) === 'hi') setLang('hi');
    } catch {
      /* private window: English */
    }
  }, []);
  const choose = (next: HelpLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      /* not remembered, still shown */
    }
  };
  return [lang, choose];
}

/** English / Hindi switch used by every help text. */
export function HelpLangSwitch({ lang, onChange }: { lang: HelpLang; onChange: (lang: HelpLang) => void }) {
  const t = useTranslations('Help');
  return (
    <div role="group" aria-label={t('language')} className="inline-flex rounded-lg border border-border bg-muted p-0.5">
      {LANGS.map((l) => (
        <button
          key={l.id}
          type="button"
          aria-pressed={lang === l.id}
          onClick={() => onChange(l.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            lang === l.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** The steps and links of one topic, in the chosen language. */
export function HelpSteps({ topic, lang, onNavigate }: { topic: HelpTopic; lang: HelpLang; onNavigate?: () => void }) {
  const t = useTranslations('Help');
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground marker:font-semibold marker:text-primary">
        {topic.steps[lang].map((step, i) => (
          <li key={i} className="pl-1 leading-relaxed">
            {step}
          </li>
        ))}
      </ol>
      {topic.links && topic.links.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('links')}</p>
          <ul className="flex flex-col gap-1.5">
            {topic.links.map((link) =>
              isOutsideLink(link.url) ? (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2"
                  >
                    {link.label[lang]}
                    <ExternalLink className="size-3.5 shrink-0" aria-label={t('opensNewTab')} />
                  </a>
                </li>
              ) : (
                <li key={link.url}>
                  <Link
                    href={link.url}
                    onClick={onNavigate}
                    className="text-sm font-medium text-primary underline underline-offset-2"
                  >
                    {link.label[lang]}
                  </Link>
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A help button: opens what the page (or one setting) is for, how to
 * set it up, and the outside pages the setup needs, in English or
 * Hindi.
 *
 * `variant="icon"` is the small round "?" for use beside a field or a
 * heading; the default shows the word as well.
 */
export function HelpButton({
  topic,
  variant = 'labelled',
  className,
}: {
  topic: HelpTopicKey;
  variant?: 'labelled' | 'icon';
  className?: string;
}) {
  const t = useTranslations('Help');
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useHelpLang();
  const data: HelpTopic = HELP_TOPICS[topic];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('open', { topic: data.title.en })}
        title={t('open', { topic: data.title.en })}
        className={cn(
          'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
          variant === 'icon' ? 'size-7' : 'h-9 px-2 text-sm font-medium',
          className,
        )}
      >
        <CircleHelp className={variant === 'icon' ? 'size-4' : 'size-[18px]'} />
        {variant === 'labelled' && <span className="hidden sm:inline">{t('button')}</span>}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <DialogTitle>{data.title[lang]}</DialogTitle>
              <HelpLangSwitch lang={lang} onChange={setLang} />
            </div>
            <DialogDescription>{data.intro[lang]}</DialogDescription>
          </DialogHeader>
          <HelpSteps topic={data} lang={lang} onNavigate={() => setOpen(false)} />
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            {t.rich('support', {
              address: SUPPORT_EMAIL,
              email: (chunks) => (
                <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-foreground underline underline-offset-2">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
