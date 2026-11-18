'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  BookOpen,
  FileSpreadsheet,
  Globe,
  Upload,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';

type SourceType = 'text' | 'file' | 'url';

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
  source_type?: SourceType;
  source_url?: string | null;
  source_filename?: string | null;
  source_fetched_at?: string | null;
}

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

const SPREADSHEET_ACCEPT = '.xlsx,.xlsm,.xls,.csv,.tsv,.ods';

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [editingSource, setEditingSource] = useState<SourceType>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlTitle, setUrlTitle] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
  const newFileRef = useRef<HTMLInputElement>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);
  const t = useTranslations('Settings.aiKnowledge');

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  const openNew = () => {
    setEditing('new');
    setEditingSource('text');
    setTitle('');
    setContent('');
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      setEditing(id);
      setEditingSource((data.source_type as SourceType | undefined) ?? 'text');
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
    } catch {
      toast.error(t('openFailed'));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setTitle('');
    setContent('');
  };

  /** Toast for an import/save response; `true` when it succeeded. */
  const reportImport = (res: Response, data: { error?: string; warning?: string }, okMessage: string) => {
    if (!res.ok) {
      toast.error(data.error ?? t('saveFailed'));
      return false;
    }
    if (data.warning) toast.warning(data.warning);
    else toast.success(okMessage);
    return true;
  };

  const save = async () => {
    const textDoc = editingSource === 'text';
    if (!title.trim() || (textDoc && !content.trim())) {
      toast.error(t('titleContentRequired'));
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // Imported documents keep their extracted content; only the
          // title is editable for them.
          body: JSON.stringify(
            textDoc ? { title: title.trim(), content: content.trim() } : { title: title.trim() },
          ),
        },
      );
      const data = await res.json();
      if (reportImport(res, data, isNew ? t('saveSuccessNew') : t('saveSuccessUpdate'))) {
        cancelEdit();
        await fetchDocs();
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const uploadFile = async (file: File, replaceId: string | null) => {
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    if (replaceId) setBusyDocId(replaceId);
    try {
      const res = await fetch(
        replaceId ? `/api/ai/knowledge/${replaceId}/import` : '/api/ai/knowledge/import',
        { method: 'POST', body: form },
      );
      const data = await res.json();
      if (reportImport(res, data, replaceId ? t('fileReplaced') : t('fileAdded', { name: file.name }))) {
        await fetchDocs();
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setUploading(false);
      setBusyDocId(null);
    }
  };

  const addUrl = async () => {
    if (!urlValue.trim()) {
      toast.error(t('urlRequired'));
      return;
    }
    setUrlSaving(true);
    try {
      const res = await fetch('/api/ai/knowledge/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlValue.trim(), title: urlTitle.trim() || undefined }),
      });
      const data = await res.json();
      if (reportImport(res, data, t('urlAdded'))) {
        setUrlOpen(false);
        setUrlValue('');
        setUrlTitle('');
        await fetchDocs();
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setUrlSaving(false);
    }
  };

  const refreshUrl = async (id: string) => {
    setBusyDocId(id);
    try {
      const res = await fetch(`/api/ai/knowledge/${id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (reportImport(res, data, t('urlRefreshed'))) await fetchDocs();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusyDocId(null);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      const failed: string[] = Array.isArray(data.failed) ? data.failed : [];
      const keywordOnly: string[] = Array.isArray(data.keyword_only) ? data.keyword_only : [];
      if (res.ok && failed.length > 0) {
        const titleById = new Map(docs.map((d) => [d.id, d.title]));
        toast.error(
          t('reindexWithFailures', {
            reindexed: data.reindexed,
            total: data.total,
            failedCount: failed.length,
            titles: failed.map((id) => titleById.get(id) ?? id).join(', '),
          }),
        );
      } else if (res.ok && data.success && keywordOnly.length > 0) {
        toast.warning(
          t('reindexKeywordOnly', {
            count: data.reindexed,
            keywordOnlyCount: keywordOnly.length,
          }),
        );
      } else if (res.ok && data.success) {
        toast.success(t('reindexSuccess', { count: data.reindexed }));
      } else {
        toast.error(data.error ?? t('reindexFailed'));
      }
    } catch {
      toast.error(t('reindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  const sourceIcon = (doc: DocSummary) =>
    doc.source_type === 'file' ? (
      <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-500" />
    ) : doc.source_type === 'url' ? (
      <Globe className="h-4 w-4 shrink-0 text-sky-500" />
    ) : (
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
    );

  const sourceMeta = (doc: DocSummary) =>
    doc.source_type === 'file'
      ? doc.source_filename ?? t('sourceFile')
      : doc.source_type === 'url'
        ? doc.source_url ?? t('sourceUrl')
        : t('sourceText');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey ? t('semanticSearchOn') : t('keywordSearchOn')
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hidden file inputs for "Upload spreadsheet" and "Replace file". */}
        <input
          ref={newFileRef}
          type="file"
          accept={SPREADSHEET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void uploadFile(f, null);
          }}
        />
        <input
          ref={replaceFileRef}
          type="file"
          accept={SPREADSHEET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const target = replaceTargetRef.current;
            e.target.value = '';
            replaceTargetRef.current = null;
            if (f && target) void uploadFile(f, target);
          }}
        />

        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">
                {t('noDocs')}
              </p>
            )}

            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {sourceIcon(doc)}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">{doc.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {sourceMeta(doc)}
                        </span>
                      </span>
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        {doc.source_type === 'file' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            disabled={busyDocId === doc.id}
                            onClick={() => {
                              replaceTargetRef.current = doc.id;
                              replaceFileRef.current?.click();
                            }}
                            title={t('replaceFile')}
                          >
                            {busyDocId === doc.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Upload className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        {doc.source_type === 'url' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            disabled={busyDocId === doc.id}
                            onClick={() => void refreshUrl(doc.id)}
                            title={t('refreshUrl')}
                          >
                            {busyDocId === doc.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => void openEdit(doc.id)}
                          title={t('editDoc')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(doc.id)}
                          title={t('deleteDoc')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title">{t('editDocTitle')}</Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('editDocTitlePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-content">
                    {editingSource === 'text' ? t('editDocContent') : t('importedContent')}
                  </Label>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('editDocContentPlaceholder')}
                    rows={8}
                    readOnly={editingSource !== 'text'}
                    disabled={saving}
                    className={editingSource !== 'text' ? 'font-mono text-xs' : undefined}
                  />
                  {editingSource !== 'text' && (
                    <p className="text-xs text-muted-foreground">{t('importedContentHint')}</p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={openNew}>
                      <Plus className="mr-2 h-4 w-4" /> {t('addDoc')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={uploading}
                      onClick={() => newFileRef.current?.click()}
                    >
                      {uploading && busyDocId === null ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileSpreadsheet className="mr-2 h-4 w-4" />
                      )}
                      {t('uploadSpreadsheet')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setUrlOpen(true)}>
                      <Globe className="mr-2 h-4 w-4" /> {t('addWebsite')}
                    </Button>
                  </div>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reindex}
                      disabled={reindexing}
                      title={t('reindexTooltip')}
                    >
                      {reindexing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {t('reindex')}
                    </Button>
                  )}
                </div>
              )
            )}
            {canEdit && editing === null && (
              <p className="text-xs text-muted-foreground">{t('sourcesHint')}</p>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={urlOpen} onOpenChange={setUrlOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('addWebsiteTitle')}</DialogTitle>
            <DialogDescription>{t('addWebsiteDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="kb-url">{t('websiteUrl')}</Label>
              <Input
                id="kb-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder="https://example.com/faq"
                disabled={urlSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-url-title">
                {t('editDocTitle')} <span className="text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                id="kb-url-title"
                value={urlTitle}
                onChange={(e) => setUrlTitle(e.target.value)}
                placeholder={t('websiteTitlePlaceholder')}
                disabled={urlSaving}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUrlOpen(false)} disabled={urlSaving}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void addUrl()} disabled={urlSaving}>
              {urlSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe className="mr-2 h-4 w-4" />}
              {t('importWebsite')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
