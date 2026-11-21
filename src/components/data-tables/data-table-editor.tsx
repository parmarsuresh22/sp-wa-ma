'use client';

import { usePageSize } from '@/hooks/use-page-size';
import { ListPager } from '@/components/ui/list-pager';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { columnKey, type DataColumn } from '@/lib/data-tables/columns';
import { ChannelScopeSelect } from '@/components/channels/channel-scope-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface DataTableRecord {
  id: string;
  name: string;
  channel_id: string | null;
  columns: DataColumn[];
  access: 'general' | 'private';
  phone_column: string | null;
  source_type: 'manual' | 'upload' | 'google_sheet';
  source_url: string | null;
  updated_at: string;
}

interface RowRecord {
  id: string;
  seq: number;
  data: Record<string, string>;
}

/** Rows loaded per page — the table never loads more than this at once. */
const NO_PHONE = '__none__';

/**
 * One data table as an editable grid. Rows are paged from the server
 * (50 at a time, with search) so a 20,000-row sheet opens as fast as a
 * 20-row one; every cell, row and column edit is saved as it is made.
 */
export function DataTableEditor({
  table,
  canEdit,
  onBack,
  onChanged,
  onDeleted,
}: {
  table: DataTableRecord;
  canEdit: boolean;
  onBack: () => void;
  onChanged: (next: DataTableRecord) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('DataTables');
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows] = useState<RowRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = usePageSize();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState(table.name);

  // Search waits for the typing to pause, then starts from page one.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim().toLowerCase());
      setPage(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const latest = useRef(0);
  useEffect(() => {
    const ticket = ++latest.current;
    (async () => {
      let query = supabase
        .from('data_table_rows')
        .select('id, seq, data', { count: 'exact' })
        .eq('table_id', table.id);
      if (search) query = query.ilike('search_text', `%${search.replace(/[%_\\]/g, ' ')}%`);
      const { data, count, error } = await query
        .order('seq', { ascending: true })
        .range(page * pageSize, page * pageSize + pageSize - 1);
      if (ticket !== latest.current) return;
      if (error) {
        toast.error(t('loadFailed'));
        setRows([]);
        return;
      }
      setRows((data as RowRecord[] | null) ?? []);
      setTotal(count ?? 0);
    })();
  }, [supabase, table.id, page, pageSize, search, reload, t]);


  const saveMeta = useCallback(
    async (patch: Partial<DataTableRecord>) => {
      const { error } = await supabase.from('data_tables').update(patch).eq('id', table.id);
      if (error) {
        toast.error(t('saveFailed'));
        return false;
      }
      onChanged({ ...table, ...patch });
      return true;
    },
    [supabase, table, onChanged, t],
  );

  async function saveCell(row: RowRecord, key: string, value: string) {
    if ((row.data[key] ?? '') === value) return;
    const data = { ...row.data };
    if (value === '') delete data[key];
    else data[key] = value;
    const { error } = await supabase.from('data_table_rows').update({ data }).eq('id', row.id);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, data } : r)) ?? prev);
  }

  async function addRow() {
    setBusy(true);
    const { error } = await supabase.from('data_table_rows').insert({ table_id: table.id, data: {} });
    setBusy(false);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    // New rows go to the end: clear the search and open the last page.
    setSearchInput('');
    setSearch('');
    setPage(Math.floor(total / pageSize));
    setReload((n) => n + 1);
  }

  async function deleteRow(row: RowRecord) {
    if (!window.confirm(t('confirmDeleteRow'))) return;
    const { error } = await supabase.from('data_table_rows').delete().eq('id', row.id);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    if (rows && rows.length === 1 && page > 0) setPage(page - 1);
    setReload((n) => n + 1);
  }

  async function addColumn() {
    const used = new Set(table.columns.map((c) => c.key));
    const title = t('newColumnName', { n: table.columns.length + 1 });
    await saveMeta({ columns: [...table.columns, { key: columnKey(title, used), name: title }] });
  }

  async function renameColumn(key: string, next: string) {
    const title = next.trim();
    const current = table.columns.find((c) => c.key === key);
    if (!title || !current || current.name === title) return;
    await saveMeta({ columns: table.columns.map((c) => (c.key === key ? { ...c, name: title } : c)) });
  }

  async function deleteColumn(col: DataColumn) {
    if (!window.confirm(t('confirmDeleteColumn', { name: col.name }))) return;
    await saveMeta({
      columns: table.columns.filter((c) => c.key !== col.key),
      ...(table.phone_column === col.key ? { phone_column: null } : {}),
    });
  }

  async function refreshFromGoogle() {
    if (!window.confirm(t('confirmRefresh'))) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/data-tables/${table.id}/refresh`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { rows?: number; error?: string };
      if (!res.ok) {
        toast.error(body.error || t('refreshFailed'));
        return;
      }
      const { data } = await supabase.from('data_tables').select('*').eq('id', table.id).maybeSingle();
      if (data) onChanged(data as DataTableRecord);
      setPage(0);
      setReload((n) => n + 1);
      toast.success(t('refreshed', { count: body.rows ?? 0 }));
    } catch {
      toast.error(t('refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }

  async function deleteTable() {
    if (!window.confirm(t('confirmDeleteTable', { name: table.name }))) return;
    const { error } = await supabase.from('data_tables').delete().eq('id', table.id);
    if (error) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('tableDeleted'));
    onDeleted();
  }

  const privateWithoutPhone = table.access === 'private' && !table.phone_column;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          {t('back')}
        </Button>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== table.name) saveMeta({ name: next.slice(0, 120) });
            else setName(table.name);
          }}
          readOnly={!canEdit}
          aria-label={t('tableName')}
          className="h-9 min-w-0 flex-1 text-base font-semibold sm:max-w-md"
        />
        <div className="ml-auto flex items-center gap-2">
          {canEdit && table.source_type === 'google_sheet' ? (
            <Button variant="outline" size="sm" onClick={refreshFromGoogle} disabled={refreshing}>
              {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {t('refresh')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant="outline" size="sm" onClick={deleteTable}>
              <Trash2 className="size-4" />
              {t('deleteTable')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('number')}</Label>
          <ChannelScopeSelect
            always
            className="w-full"
            value={table.channel_id}
            onChange={(channel_id) => saveMeta({ channel_id })}
            disabled={!canEdit}
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('access')}</Label>
          <Select
            value={table.access}
            onValueChange={(v) => v && saveMeta({ access: v as DataTableRecord['access'] })}
            disabled={!canEdit}
            items={{ general: t('accessGeneral'), private: t('accessPrivate') }}
          >
            <SelectTrigger className="w-full" aria-label={t('access')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">{t('accessGeneral')}</SelectItem>
              <SelectItem value="private">{t('accessPrivate')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('phoneColumn')}</Label>
          <Select
            value={table.phone_column ?? NO_PHONE}
            onValueChange={(v) => v && saveMeta({ phone_column: v === NO_PHONE ? null : String(v) })}
            disabled={!canEdit}
            items={{
              [NO_PHONE]: t('phoneColumnNone'),
              ...Object.fromEntries(table.columns.map((c) => [c.key, c.name])),
            }}
          >
            <SelectTrigger className="w-full" aria-label={t('phoneColumn')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PHONE}>{t('phoneColumnNone')}</SelectItem>
              {table.columns.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p
          className={`text-xs sm:col-span-3 ${
            privateWithoutPhone ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
          }`}
        >
          {privateWithoutPhone
            ? t('privateNeedsPhone')
            : table.access === 'private'
              ? t('accessPrivateHint')
              : t('accessGeneralHint')}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('searchRows')}
            className="pl-8"
          />
        </div>
        {canEdit ? (
          <>
            <Button size="sm" onClick={addRow} disabled={busy}>
              <Plus className="size-4" />
              {t('addRow')}
            </Button>
            <Button size="sm" variant="outline" onClick={addColumn}>
              <Plus className="size-4" />
              {t('addColumn')}
            </Button>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('rowCount', { count: total })}</span>
        </div>
      </div>

      <ListPager page={page} pageSize={pageSize} total={total} onChange={setPage} />

      <div className="overflow-auto rounded-xl border border-border bg-card">
        {table.columns.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t('noColumns')}</p>
        ) : (
          <table className="w-max min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="w-12 px-2 py-2 text-left text-xs font-medium text-muted-foreground">#</th>
                {table.columns.map((c) => (
                  <th key={c.key} className="min-w-40 px-1 py-1.5 text-left align-top">
                    <div className="flex items-center gap-1">
                      <input
                        key={`${c.key}:${c.name}`}
                        defaultValue={c.name}
                        readOnly={!canEdit}
                        onBlur={(e) => renameColumn(c.key, e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                        aria-label={t('columnName')}
                        className="min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 text-sm font-semibold text-foreground outline-none focus:bg-background focus:ring-1 focus:ring-ring"
                      />
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => deleteColumn(c)}
                          aria-label={t('deleteColumn', { name: c.name })}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-500"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                    <code className="block px-1.5 text-[10px] font-normal text-muted-foreground">
                      {`{{table.${c.key}}}`}
                      {table.phone_column === c.key ? ` · ${t('phoneBadge')}` : ''}
                    </code>
                  </th>
                ))}
                {canEdit ? <th className="w-10" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows === null ? (
                <tr>
                  <td colSpan={table.columns.length + 2} className="p-6 text-center">
                    <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={table.columns.length + 2} className="p-6 text-sm text-muted-foreground">
                    {search ? t('noMatches') : t('noRows')}
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-b-0">
                    <td className="px-2 py-1 text-xs text-muted-foreground tabular-nums">
                      {page * pageSize + i + 1}
                    </td>
                    {table.columns.map((c) => (
                      <td key={c.key} className="px-1 py-0.5">
                        <input
                          key={`${row.id}:${c.key}:${row.data[c.key] ?? ''}`}
                          defaultValue={row.data[c.key] ?? ''}
                          readOnly={!canEdit}
                          onBlur={(e) => saveCell(row, c.key, e.target.value.trim())}
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                          aria-label={c.name}
                          className="w-full rounded bg-transparent px-1.5 py-1 text-sm text-foreground outline-none focus:bg-background focus:ring-1 focus:ring-ring"
                        />
                      </td>
                    ))}
                    {canEdit ? (
                      <td className="px-1">
                        <button
                          type="button"
                          onClick={() => deleteRow(row)}
                          aria-label={t('deleteRow')}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-500"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('placeholderHint', { example: '{{table.column}}' })}</p>
      <ListPager page={page} pageSize={pageSize} total={total} onChange={setPage} />
    </div>
  );
}
