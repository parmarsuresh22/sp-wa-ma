'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Table2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const NONE = '__none__';

interface TableOption {
  id: string;
  name: string;
  channel_id: string | null;
  access: 'general' | 'private';
}

/**
 * "Answer from this table" picker for the AI agent, a flow or an
 * automation. Lists the data tables attached to `channelId` (plus the
 * ones attached to every number); `null` means no table.
 */
export function DataTableSelect({
  value,
  onChange,
  channelId,
  disabled,
  className,
  size = 'default',
  id,
}: {
  value: string | null;
  onChange: (tableId: string | null) => void;
  /** The WhatsApp number the responder runs on; null = every number. */
  channelId?: string | null;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  id?: string;
}) {
  const t = useTranslations('DataTables');
  const [tables, setTables] = useState<TableOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from('data_tables')
      .select('id, name, channel_id, access')
      .order('name')
      .then(({ data }) => {
        if (!cancelled) setTables((data as TableOption[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A number's own tables plus the unattached ones; the saved choice
  // always stays listed so it never silently disappears.
  const options = (tables ?? []).filter(
    (tb) => !channelId || !tb.channel_id || tb.channel_id === channelId || tb.id === value,
  );
  const label = (tb: TableOption) =>
    `${tb.name}${tb.access === 'private' ? ` · ${t('accessPrivateShort')}` : ''}`;
  const current = value && options.some((tb) => tb.id === value) ? value : NONE;

  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(!v || v === NONE ? null : String(v))}
      disabled={disabled || tables === null}
      items={{ [NONE]: t('selectNone'), ...Object.fromEntries(options.map((tb) => [tb.id, label(tb)])) }}
    >
      <SelectTrigger id={id} size={size} className={cn('max-w-full', className)} aria-label={t('selectLabel')}>
        <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('selectNone')}</SelectItem>
        {options.map((tb) => (
          <SelectItem key={tb.id} value={tb.id}>
            {label(tb)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The picker with its label and a line explaining what the chosen
 * table does for that responder.
 */
export function DataTableField({
  variant,
  compact = false,
  id,
  ...props
}: {
  variant: 'ai' | 'flow' | 'automation';
  /** Smaller label, for the flow builder's side panel. */
  compact?: boolean;
  id?: string;
  value: string | null;
  onChange: (tableId: string | null) => void;
  channelId?: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations('DataTables');
  return (
    <div className={compact ? undefined : 'space-y-2'}>
      <label
        htmlFor={id}
        className={
          compact
            ? 'mb-1 block text-xs text-muted-foreground'
            : 'text-sm leading-none font-medium text-foreground'
        }
      >
        {t('fieldLabel')}
      </label>
      {compact ? null : (
        <p className="text-xs text-muted-foreground">{t(`fieldDesc.${variant}`)}</p>
      )}
      <DataTableSelect id={id} className={compact ? 'w-full bg-muted' : 'w-full'} {...props} />
      {compact ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{t(`fieldDesc.${variant}`)}</p>
      ) : null}
    </div>
  );
}
