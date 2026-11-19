'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileSpreadsheet, Link2, Loader2, Lock, Plus, Table2, Upload, Users } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useActiveChannel } from '@/hooks/use-active-channel';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import { ChannelScopeSelect } from '@/components/channels/channel-scope-select';
import {
  DataTableEditor,
  type DataTableRecord,
} from '@/components/data-tables/data-table-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// `useSearchParams` needs a Suspense boundary (see settings/page.tsx).
export default function DataTablesPage() {
  return (
    <Suspense fallback={null}>
      <DataTablesInner />
    </Suspense>
  );
}

function DataTablesInner() {
  const t = useTranslations('DataTables');
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const { accountId, canEditSettings } = useAuth();
  const { channels, byId } = useChannels();
  const [activeChannel, setActiveChannel] = useActiveChannel();
  const channelId =
    activeChannel !== 'all' && channels?.some((c) => c.id === activeChannel) ? activeChannel : null;

  const [tables, setTables] = useState<DataTableRecord[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetName, setSheetName] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedId = searchParams.get('table');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('data_tables')
      .select('id, name, channel_id, columns, access, phone_column, source_type, source_url, updated_at')
      .order('updated_at', { ascending: false });
    if (error) toast.error(t('loadFailed'));
    setTables((data as DataTableRecord[] | null) ?? []);
  }, [supabase, t]);

  useEffect(() => {
    load();
  }, [load]);

  const open = (id: string | null) => router.replace(id ? `/data?table=${id}` : '/data', { scroll: false });

  async function finishImport(res: Response) {
    const body = (await res.json().catch(() => ({}))) as {
      tables?: { id: string; name: string; rows: number; truncated: boolean }[];
      error?: string;
    };
    if (!res.ok || !body.tables) {
      toast.error(body.error || t('importFailed'));
      return false;
    }
    await load();
    const rows = body.tables.reduce((n, tb) => n + tb.rows, 0);
    toast.success(t('imported', { tables: body.tables.length, rows }));
    if (body.tables.some((tb) => tb.truncated)) toast.warning(t('importTruncated'));
    if (body.tables.length === 1) open(body.tables[0].id);
    return true;
  }

  async function uploadFile(file: File) {
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (channelId) form.append('channel_id', channelId);
      await finishImport(await fetch('/api/data-tables/import', { method: 'POST', body: form }));
    } catch {
      toast.error(t('importFailed'));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function importSheet() {
    setImporting(true);
    try {
      const ok = await finishImport(
        await fetch('/api/data-tables/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: sheetUrl, name: sheetName, channel_id: channelId }),
        }),
      );
      if (ok) {
        setSheetOpen(false);
        setSheetUrl('');
        setSheetName('');
      }
    } catch {
      toast.error(t('importFailed'));
    } finally {
      setImporting(false);
    }
  }

  async function createBlank() {
    if (!accountId) return;
    const { data, error } = await supabase
      .from('data_tables')
      .insert({
        account_id: accountId,
        channel_id: channelId,
        name: t('untitled'),
        columns: [
          { key: 'name', name: t('starterName') },
          { key: 'phone', name: t('starterPhone') },
        ],
        source_type: 'manual',
      })
      .select('id')
      .single();
    if (error || !data) {
      toast.error(t('saveFailed'));
      return;
    }
    await load();
    open(data.id);
  }

  const selected = selectedId ? tables?.find((tb) => tb.id === selectedId) ?? null : null;

  if (selectedId && tables !== null && selected) {
    return (
      <DataTableEditor
        key={selected.id}
        table={selected}
        canEdit={canEditSettings}
        onBack={() => open(null)}
        onChanged={(next) =>
          setTables((prev) => prev?.map((tb) => (tb.id === next.id ? next : tb)) ?? prev)
        }
        onDeleted={() => {
          setTables((prev) => prev?.filter((tb) => tb.id !== selected.id) ?? prev);
          open(null);
        }}
      />
    );
  }

  // Tables of the selected number, plus the ones attached to every number.
  const visible = (tables ?? []).filter(
    (tb) => !channelId || !tb.channel_id || tb.channel_id === channelId,
  );

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <ChannelScopeSelect
          className="shrink-0 bg-card"
          value={channelId}
          onChange={(id) => setActiveChannel(id ?? 'all')}
        />
      </div>

      {canEditSettings ? (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv,.tsv,.ods"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadFile(file);
            }}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t('upload')}
          </Button>
          <Button variant="outline" onClick={() => setSheetOpen(true)} disabled={importing}>
            <Link2 className="size-4" />
            {t('googleSheet')}
          </Button>
          <Button variant="outline" onClick={createBlank} disabled={importing}>
            <Plus className="size-4" />
            {t('newTable')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {channelId
              ? t('attachesTo', { number: channelLabel(byId(channelId)) })
              : t('attachesToAll')}
          </span>
        </div>
      ) : null}

      <div className="mt-5">
        {tables === null ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <FileSpreadsheet className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-[52ch] text-sm text-muted-foreground">{t('emptyDesc')}</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((tb) => (
              <button
                key={tb.id}
                type="button"
                onClick={() => open(tb.id)}
                className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Table2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">{tb.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {tb.access === 'private' ? <Lock className="size-3" /> : <Users className="size-3" />}
                      {tb.access === 'private' ? t('accessPrivateShort') : t('accessGeneralShort')}
                    </span>
                    <span>{t('columnCount', { count: tb.columns?.length ?? 0 })}</span>
                    <span className="truncate">
                      {tb.channel_id ? channelLabel(byId(tb.channel_id)) || t('allNumbers') : t('allNumbers')}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('googleSheetTitle')}</DialogTitle>
            <DialogDescription>{t('googleSheetDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sheet-url">{t('googleSheetUrl')}</Label>
              <Input
                id="sheet-url"
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sheet-name">{t('tableName')}</Label>
              <Input
                id="sheet-name"
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
                placeholder={t('googleSheetNamePlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSheetOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={importSheet} disabled={importing || !sheetUrl.trim()}>
              {importing ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
