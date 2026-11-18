'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Smartphone, Zap, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useChannels, channelLabel, type ChannelSummary } from '@/hooks/use-channels';
import { cn } from '@/lib/utils';

interface Step0Props {
  channelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * "Send from": which of the account's numbers the campaign goes out
 * on. A Business API number sends an approved template; a WhatsApp Web
 * number sends a plain message you write in the next step.
 */
export function Step0ChooseChannel({ channelId, onSelect, onNext, onBack }: Step0Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { channels, loading } = useChannels();
  const list = channels ?? [];

  // One number only: pick it so the step is a confirmation, not a chore.
  useEffect(() => {
    if (!channelId && list.length === 1) onSelect(list[0]);
  }, [channelId, list, onSelect]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseChannel.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('chooseChannel.subtitle')}</p>
      </div>

      {loading && !channels ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('chooseChannel.none')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((c) => {
            const bridge = c.provider === 'waha';
            const selected = c.id === channelId;
            const connected = c.status === 'connected';
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50',
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary/40' : 'border-border bg-card',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full',
                    bridge ? 'bg-sky-500/15 text-sky-500' : 'bg-primary/15 text-primary',
                  )}
                >
                  {bridge ? <Smartphone className="size-4" /> : <Zap className="size-4" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{channelLabel(c)}</p>
                  {c.label && c.display_phone && (
                    <p className="truncate text-xs text-muted-foreground">{c.display_phone}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {bridge ? t('chooseChannel.bridgeHint') : t('chooseChannel.metaHint')}
                  </p>
                  {!connected && (
                    <p className="mt-1 text-xs text-amber-400">{t('chooseChannel.disconnected')}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!channelId}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
