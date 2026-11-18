'use client';

import { useTranslations } from 'next-intl';
import { Smartphone } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { cn } from '@/lib/utils';

const ALL = '__all__';

/**
 * "Runs on / show" picker over the account's WhatsApp numbers. `null`
 * means every number. Renders nothing while the account has fewer than
 * two numbers — the choice would be meaningless — unless `always` is
 * set (edit forms want to show the saved scope even then).
 */
export function ChannelScopeSelect({
  value,
  onChange,
  disabled,
  className,
  size = 'default',
  always = false,
  id,
}: {
  value: string | null;
  onChange: (channelId: string | null) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  always?: boolean;
  id?: string;
}) {
  const t = useTranslations('Channels');
  const { channels } = useChannels();
  const list = channels ?? [];
  if (!always && list.length < 2) return null;

  // A saved id whose number was removed shows as "all" (the server
  // already treats it that way via ON DELETE SET NULL).
  const current = value && list.some((c) => c.id === value) ? value : ALL;

  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(!v || v === ALL ? null : String(v))}
      disabled={disabled}
      // Base UI shows the raw value in the trigger unless it is told the
      // labels up front (the items only register once the popup opens).
      items={{
        [ALL]: t('allNumbers'),
        ...Object.fromEntries(
          list.map((c) => [
            c.id,
            `${channelLabel(c)}${c.label && c.display_phone ? ` · ${c.display_phone}` : ''}`,
          ]),
        ),
      }}
    >
      <SelectTrigger id={id} size={size} className={cn('max-w-full', className)} aria-label={t('number')}>
        <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('allNumbers')}</SelectItem>
        {list.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {channelLabel(c)}
            {c.label && c.display_phone ? ` · ${c.display_phone}` : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
