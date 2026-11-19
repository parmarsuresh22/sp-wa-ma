'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  FolderOpen,
  ImagePlus,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { contactSearchFilter } from '@/lib/contacts/search-filter';
import { useAuth } from '@/hooks/use-auth';
import { useChannels, channelLabel } from '@/hooks/use-channels';
import {
  MAX_BROADCAST_RECIPIENTS,
  MAX_CAPTION_LENGTH,
  withWhatsAppLink,
  type AudienceMode,
  type PostBroadcastResult,
  type PostRow,
} from '@/lib/posts/post';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const HISTORY_PAGE = 8;

interface DriveStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
}

interface DriveFile {
  id: string;
  name: string;
  thumbnailLink: string | null;
  createdTime: string | null;
}

interface PickedContact {
  id: string;
  name: string | null;
  phone: string | null;
}

interface TagOption {
  id: string;
  name: string;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 text-sm text-foreground',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export function PostsStudio() {
  const t = useTranslations('Posts');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { canEditSettings } = useAuth();
  const { channels } = useChannels();
  const supabase = useMemo(() => createClient(), []);

  const webChannels = useMemo(
    () => (channels ?? []).filter((c) => c.provider === 'waha'),
    [channels],
  );
  const linkableChannels = useMemo(
    () => (channels ?? []).filter((c) => !!c.display_phone),
    [channels],
  );

  // ---- composer state ---------------------------------------
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [mediaMime, setMediaMime] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState<'caption' | 'image' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  const [includeLink, setIncludeLink] = useState(true);
  const [linkChannelId, setLinkChannelId] = useState<string | null>(null);
  const [statusIds, setStatusIds] = useState<string[]>([]);
  const [broadcastOn, setBroadcastOn] = useState(false);
  const [broadcastChannelId, setBroadcastChannelId] = useState<string | null>(null);
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('contacts');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<PickedContact[]>([]);
  const [saveToDrive, setSaveToDrive] = useState(false);

  const [posting, setPosting] = useState(false);
  const [progress, setProgress] = useState<{ postId: string; tally: PostBroadcastResult } | null>(null);
  const stopRef = useRef(false);

  // Sensible defaults once the numbers are known.
  const effectiveLinkChannelId =
    linkChannelId && linkableChannels.some((c) => c.id === linkChannelId)
      ? linkChannelId
      : (linkableChannels[0]?.id ?? null);
  const effectiveBroadcastChannelId =
    broadcastChannelId && webChannels.some((c) => c.id === broadcastChannelId)
      ? broadcastChannelId
      : (webChannels[0]?.id ?? null);
  const linkPhone = linkableChannels.find((c) => c.id === effectiveLinkChannelId)?.display_phone ?? null;
  const finalText = includeLink ? withWhatsAppLink(caption, linkPhone) : caption.trim();

  // ---- reference data ---------------------------------------
  const [tags, setTags] = useState<TagOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('tags')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (!cancelled) setTags((data as TagOption[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const loadDrive = useCallback(async () => {
    try {
      const res = await fetch('/api/google/drive', { cache: 'no-store' });
      if (res.ok) setDrive((await res.json()) as DriveStatus);
    } catch {
      /* the Drive options just stay hidden */
    }
  }, []);
  useEffect(() => {
    void loadDrive();
  }, [loadDrive]);

  // Outcome of "Connect Google Drive" (the callback redirects back here).
  const driveOutcome = searchParams.get('drive');
  const handledOutcome = useRef<string | null>(null);
  useEffect(() => {
    if (!driveOutcome || handledOutcome.current === driveOutcome) return;
    handledOutcome.current = driveOutcome;
    if (driveOutcome === 'connected') toast.success(t('driveConnected'));
    else if (driveOutcome === 'denied') toast.error(t('driveDenied'));
    else if (driveOutcome === 'not_configured') toast.error(t('driveNotConfigured'));
    else if (driveOutcome === 'forbidden') toast.error(t('driveForbidden'));
    else toast.error(t('driveError'));
    router.replace('/posts', { scroll: false });
  }, [driveOutcome, router, t]);

  // ---- history ----------------------------------------------
  const [history, setHistory] = useState<PostRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);

  const loadHistory = useCallback(
    async (page: number) => {
      const from = page * HISTORY_PAGE;
      const { data, count, error } = await supabase
        .from('posts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + HISTORY_PAGE - 1);
      if (error) {
        toast.error(t('historyFailed'));
        setHistory((prev) => prev ?? []);
        return;
      }
      setHistory((data as PostRow[] | null) ?? []);
      setHistoryTotal(count ?? 0);
    },
    [supabase, t],
  );
  useEffect(() => {
    void loadHistory(historyPage);
  }, [loadHistory, historyPage]);

  // ---- image ------------------------------------------------
  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!IMAGE_TYPES.includes(file.type)) {
        toast.error(t('imageType'));
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(t('imageTooLarge'));
        return;
      }
      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia('chat-media', file);
        setMediaUrl(publicUrl);
        setMediaMime(file.type);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('uploadFailed'));
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [t],
  );

  const runAi = useCallback(
    async (mode: 'caption' | 'image') => {
      if (aiBusy) return;
      setAiBusy(mode);
      try {
        const res = await fetch('/api/posts/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            mode === 'caption'
              ? { mode, prompt: aiPrompt, current: caption }
              : { mode, prompt: aiPrompt, media_url: mediaUrl },
          ),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || t('aiFailed'), { duration: 9000 });
          return;
        }
        if (mode === 'caption' && typeof data.caption === 'string') {
          setCaption(data.caption);
        } else if (mode === 'image' && typeof data.media_url === 'string') {
          setMediaUrl(data.media_url);
          setMediaMime(typeof data.media_mime === 'string' ? data.media_mime : 'image/png');
          toast.success(t('aiImageDone'));
        }
      } catch {
        toast.error(t('aiFailed'));
      } finally {
        setAiBusy(null);
      }
    },
    [aiBusy, aiPrompt, caption, mediaUrl, t],
  );

  // ---- Google Drive picker ----------------------------------
  const [driveOpen, setDriveOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<DriveFile[] | null>(null);
  const [driveBusy, setDriveBusy] = useState<string | null>(null);

  const openDrivePicker = useCallback(async () => {
    setDriveOpen(true);
    setDriveFiles(null);
    try {
      const res = await fetch('/api/google/drive/files', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || t('driveError'));
        if (data.code === 'not_connected') void loadDrive();
        setDriveOpen(false);
        return;
      }
      setDriveFiles((data.files as DriveFile[]) ?? []);
    } catch {
      toast.error(t('driveError'));
      setDriveOpen(false);
    }
  }, [loadDrive, t]);

  const pickDriveFile = useCallback(
    async (file: DriveFile) => {
      setDriveBusy(file.id);
      try {
        const res = await fetch('/api/google/drive/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_id: file.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || t('driveError'));
          return;
        }
        setMediaUrl(data.media_url as string);
        setMediaMime((data.media_mime as string) ?? 'image/jpeg');
        setDriveOpen(false);
      } finally {
        setDriveBusy(null);
      }
    },
    [t],
  );

  const disconnectDrive = useCallback(async () => {
    if (!confirm(t('driveDisconnectConfirm'))) return;
    setDrive((d) => (d ? { ...d, connected: false, email: null } : d));
    setSaveToDrive(false);
    await fetch('/api/google/drive', { method: 'DELETE' });
    void loadDrive();
  }, [loadDrive, t]);

  // ---- contact picker ---------------------------------------
  const [contactQuery, setContactQuery] = useState('');
  const [contactHits, setContactHits] = useState<PickedContact[]>([]);
  useEffect(() => {
    const term = contactQuery.trim();
    if (term.length < 2) {
      setContactHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      let query = supabase.from('contacts').select('id, name, phone').not('phone', 'is', null);
      const filter = contactSearchFilter(term);
      if (filter) query = query.or(filter);
      const { data } = await query.order('name').limit(8);
      if (!cancelled) setContactHits((data as PickedContact[] | null) ?? []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contactQuery, supabase]);

  // ---- broadcast loop ---------------------------------------
  const patchHistory = useCallback((postId: string, tally: PostBroadcastResult) => {
    setHistory((prev) =>
      (prev ?? []).map((p) =>
        p.id === postId ? { ...p, results: { ...p.results, broadcast: tally } } : p,
      ),
    );
  }, []);

  const runBroadcast = useCallback(
    async (postId: string, start: PostBroadcastResult) => {
      stopRef.current = false;
      let tally = start;
      setProgress({ postId, tally });
      while (!tally.done && !stopRef.current) {
        const res = await fetch(`/api/posts/${postId}/broadcast`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.broadcast) {
          toast.error(data.error || t('broadcastFailed'), { duration: 9000 });
          break;
        }
        tally = data.broadcast as PostBroadcastResult;
        setProgress({ postId, tally });
        patchHistory(postId, tally);
      }
      if (tally.done) {
        toast.success(t('broadcastDone', { sent: tally.sent, failed: tally.failed }));
      }
      setProgress(null);
    },
    [patchHistory, t],
  );

  // ---- post -------------------------------------------------
  const hasContent = !!mediaUrl || !!caption.trim();
  const audienceReady =
    !broadcastOn ||
    (!!effectiveBroadcastChannelId &&
      (audienceMode === 'all' ||
        (audienceMode === 'tags' && tagIds.length > 0) ||
        (audienceMode === 'contacts' && picked.length > 0)));
  const hasDestination = statusIds.length > 0 || broadcastOn || (saveToDrive && !!mediaUrl);
  const canPost = hasContent && hasDestination && audienceReady && !posting && !uploading && !aiBusy;

  const submit = useCallback(async () => {
    if (!canPost) return;
    setPosting(true);
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption,
          media_url: mediaUrl,
          media_mime: mediaMime,
          include_link: includeLink,
          link_channel_id: effectiveLinkChannelId,
          status_channel_ids: statusIds,
          audience: broadcastOn
            ? {
                mode: audienceMode,
                tag_ids: tagIds,
                contact_ids: picked.map((p) => p.id),
                channel_id: effectiveBroadcastChannelId,
              }
            : null,
          save_to_drive: saveToDrive,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.post) {
        toast.error(data.error || t('postFailed'), { duration: 9000 });
        return;
      }
      const post = data.post as PostRow;
      setHistoryPage(0);
      setHistory((prev) => [post, ...(prev ?? []).filter((p) => p.id !== post.id)].slice(0, HISTORY_PAGE));
      setHistoryTotal((n) => n + 1);

      const failedStatus = (post.results.status ?? []).filter((s) => !s.ok);
      const okStatus = (post.results.status ?? []).filter((s) => s.ok);
      if (okStatus.length > 0) toast.success(t('statusPosted', { count: okStatus.length }));
      for (const s of failedStatus) {
        toast.error(t('statusFailed', { error: s.error ?? '' }), { duration: 10000 });
      }
      if (post.results.drive) {
        if (post.results.drive.ok) toast.success(t('driveSaved'));
        else toast.error(t('driveSaveFailed', { error: post.results.drive.error ?? '' }), { duration: 9000 });
      }

      // The composer is free again; the broadcast runs on underneath.
      setCaption('');
      setMediaUrl(null);
      setMediaMime(null);
      setAiPrompt('');
      setPicked([]);
      setStatusIds([]);
      setBroadcastOn(false);

      if (post.results.broadcast && !post.results.broadcast.done) {
        void runBroadcast(post.id, post.results.broadcast);
      }
    } catch {
      toast.error(t('postFailed'));
    } finally {
      setPosting(false);
    }
  }, [
    audienceMode,
    broadcastOn,
    canPost,
    caption,
    effectiveBroadcastChannelId,
    effectiveLinkChannelId,
    includeLink,
    mediaMime,
    mediaUrl,
    picked,
    runBroadcast,
    saveToDrive,
    statusIds,
    t,
    tagIds,
  ]);

  const reuse = useCallback((post: PostRow) => {
    setCaption(post.caption ?? '');
    setMediaUrl(post.media_url);
    setMediaMime(post.media_mime);
    setIncludeLink(post.include_link);
    if (post.link_channel_id) setLinkChannelId(post.link_channel_id);
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const removePost = useCallback(
    async (post: PostRow) => {
      if (!confirm(t('deleteConfirm'))) return;
      setHistory((prev) => (prev ?? []).filter((p) => p.id !== post.id));
      setHistoryTotal((n) => Math.max(0, n - 1));
      const res = await fetch(`/api/posts/${post.id}`, { method: 'DELETE' });
      if (!res.ok) toast.error(t('deleteFailed'));
      void loadHistory(historyPage);
    },
    [historyPage, loadHistory, t],
  );

  const channelName = useCallback(
    (id: string) => {
      const ch = (channels ?? []).find((c) => c.id === id);
      return ch ? channelLabel(ch) : t('removedNumber');
    },
    [channels, t],
  );

  const channelItems = (list: typeof webChannels) =>
    Object.fromEntries(
      list.map((c) => [c.id, `${channelLabel(c)}${c.display_phone && c.label ? ` · ${c.display_phone}` : ''}`]),
    );

  return (
    <div ref={topRef}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:items-start">
        {/* ---------------- composer ---------------- */}
        <div className="space-y-4">
          <Section title={t('imageTitle')} hint={t('imageHint')}>
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_TYPES.join(',')}
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {mediaUrl ? (
              <div className="relative w-fit">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaUrl}
                  alt={t('imageAlt')}
                  className="max-h-72 max-w-full rounded-lg border border-border object-contain"
                />
                <button
                  type="button"
                  onClick={() => {
                    setMediaUrl(null);
                    setMediaMime(null);
                  }}
                  className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                  aria-label={t('removeImage')}
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
                {mediaUrl ? t('replaceImage') : t('uploadImage')}
              </Button>
              {drive?.connected && (
                <Button variant="outline" size="sm" onClick={() => void openDrivePicker()}>
                  <FolderOpen className="size-4" />
                  {t('fromDrive')}
                </Button>
              )}
            </div>
          </Section>

          <Section title={t('aiTitle')} hint={t('aiHint')}>
            <Input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder={t('aiPlaceholder')}
              maxLength={2000}
              className="bg-muted"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!!aiBusy || (!aiPrompt.trim() && !caption.trim())}
                onClick={() => void runAi('caption')}
              >
                {aiBusy === 'caption' ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {caption.trim() ? t('aiRewrite') : t('aiWrite')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!aiBusy || !aiPrompt.trim()}
                onClick={() => void runAi('image')}
              >
                {aiBusy === 'image' ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                {mediaUrl ? t('aiEditImage') : t('aiCreateImage')}
              </Button>
            </div>
            {aiBusy === 'image' && <p className="text-xs text-muted-foreground">{t('aiImageWait')}</p>}
          </Section>

          <Section title={t('textTitle')}>
            <Textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, MAX_CAPTION_LENGTH))}
              placeholder={t('textPlaceholder')}
              rows={5}
              className="bg-muted"
            />
            <p className="text-right text-[11px] text-muted-foreground">
              {caption.length}/{MAX_CAPTION_LENGTH}
            </p>
            <Check checked={includeLink} onChange={setIncludeLink} disabled={linkableChannels.length === 0}>
              {t('includeLink')}
              <span className="block text-xs text-muted-foreground">
                {linkableChannels.length === 0 ? t('includeLinkNoNumber') : t('includeLinkHint')}
              </span>
            </Check>
            {includeLink && linkableChannels.length > 1 && effectiveLinkChannelId && (
              <Select
                value={effectiveLinkChannelId}
                onValueChange={(v) => setLinkChannelId(v ? String(v) : null)}
                items={channelItems(linkableChannels)}
              >
                <SelectTrigger className="w-full bg-muted sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {linkableChannels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {channelItems([c])[c.id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {finalText && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('preview')}</p>
                <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
                  {finalText}
                </p>
              </div>
            )}
          </Section>

          <Section title={t('whereTitle')} hint={t('whereHint')}>
            {/* WhatsApp Status */}
            {webChannels.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                {t('noWebNumber')}
              </p>
            ) : (
              webChannels.map((c) => {
                const connected = c.status === 'connected';
                return (
                  <Check
                    key={c.id}
                    checked={statusIds.includes(c.id)}
                    disabled={!connected}
                    onChange={(on) =>
                      setStatusIds((prev) => (on ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                    }
                  >
                    {t('statusOn', { name: channelLabel(c) })}
                    <span className="block text-xs text-muted-foreground">
                      {connected ? t('statusHint') : t('numberDisconnected')}
                    </span>
                  </Check>
                );
              })
            )}

            {/* Broadcast */}
            <Check checked={broadcastOn} onChange={setBroadcastOn} disabled={webChannels.length === 0}>
              {t('broadcast')}
              <span className="block text-xs text-muted-foreground">{t('broadcastHint')}</span>
            </Check>
            {broadcastOn && effectiveBroadcastChannelId && (
              <div className="ml-6 space-y-3 rounded-lg border border-border p-3">
                {webChannels.length > 1 && (
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">{t('broadcastFrom')}</p>
                    <Select
                      value={effectiveBroadcastChannelId}
                      onValueChange={(v) => setBroadcastChannelId(v ? String(v) : null)}
                      items={channelItems(webChannels)}
                    >
                      <SelectTrigger className="w-full bg-muted sm:w-80">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {webChannels.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {channelItems([c])[c.id]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {(['contacts', 'tags', 'all'] as AudienceMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setAudienceMode(mode)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs',
                        audienceMode === mode
                          ? 'border-primary bg-primary/15 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(`audience.${mode}`)}
                    </button>
                  ))}
                </div>

                {audienceMode === 'contacts' && (
                  <div className="space-y-2">
                    <Input
                      value={contactQuery}
                      onChange={(e) => setContactQuery(e.target.value)}
                      placeholder={t('contactSearch')}
                      className="bg-muted"
                    />
                    {contactHits.length > 0 && (
                      <ul className="max-h-44 overflow-y-auto rounded-lg border border-border">
                        {contactHits
                          .filter((h) => !picked.some((p) => p.id === h.id))
                          .map((h) => (
                            <li key={h.id}>
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                                onClick={() => {
                                  setPicked((prev) =>
                                    prev.length >= MAX_BROADCAST_RECIPIENTS ? prev : [...prev, h],
                                  );
                                  setContactQuery('');
                                }}
                              >
                                <span className="truncate">{h.name || h.phone}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{h.phone}</span>
                              </button>
                            </li>
                          ))}
                      </ul>
                    )}
                    {picked.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {picked.map((p) => (
                          <Badge key={p.id} variant="outline" className="gap-1 font-normal">
                            {p.name || p.phone}
                            <button
                              type="button"
                              aria-label={t('removeContact')}
                              onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                            >
                              <X className="size-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {audienceMode === 'tags' &&
                  (tags.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('noTags')}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((tag) => {
                        const on = tagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() =>
                              setTagIds((prev) => (on ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]))
                            }
                            className={cn(
                              'rounded-full border px-3 py-1 text-xs',
                              on
                                ? 'border-primary bg-primary/15 text-foreground'
                                : 'border-border text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  ))}

                {audienceMode === 'all' && (
                  <p className="text-xs text-amber-300">{t('audienceAllWarning', { max: MAX_BROADCAST_RECIPIENTS })}</p>
                )}
                <p className="text-xs text-muted-foreground">{t('broadcastNote', { token: '{{name}}' })}</p>
              </div>
            )}

            {/* Google Drive */}
            {drive?.connected ? (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Check checked={saveToDrive} onChange={setSaveToDrive} disabled={!mediaUrl}>
                  {t('saveToDrive')}
                  <span className="block text-xs text-muted-foreground">
                    {t('driveAs', { email: drive.email ?? 'Google' })}
                  </span>
                </Check>
                {canEditSettings && (
                  <button
                    type="button"
                    onClick={() => void disconnectDrive()}
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    {t('driveDisconnect')}
                  </button>
                )}
              </div>
            ) : drive?.configured ? (
              canEditSettings ? (
                <a
                  href="/api/google/drive/connect"
                  className="inline-flex items-center gap-2 text-sm text-primary underline"
                >
                  <CloudUpload className="size-4" />
                  {t('driveConnect')}
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">{t('driveAskAdmin')}</p>
              )
            ) : drive ? (
              <p className="text-xs text-muted-foreground">{t('driveUnavailable')}</p>
            ) : null}
          </Section>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void submit()} disabled={!canPost}>
              {posting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {posting ? t('posting') : t('post')}
            </Button>
            {!hasContent ? (
              <span className="text-xs text-muted-foreground">{t('needContent')}</span>
            ) : !hasDestination ? (
              <span className="text-xs text-muted-foreground">{t('needDestination')}</span>
            ) : !audienceReady ? (
              <span className="text-xs text-muted-foreground">{t('needAudience')}</span>
            ) : null}
          </div>

          {progress && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Loader2 className="size-4 animate-spin text-primary" />
                {t('broadcastProgress', {
                  done: progress.tally.sent + progress.tally.failed,
                  total: progress.tally.total,
                })}
                <button
                  type="button"
                  className="ml-auto text-xs text-muted-foreground underline hover:text-foreground"
                  onClick={() => {
                    stopRef.current = true;
                  }}
                >
                  {t('broadcastPause')}
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('broadcastKeepOpen')}</p>
            </div>
          )}
        </div>

        {/* ---------------- history ---------------- */}
        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">{t('historyTitle')}</h2>
          {history === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : history.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {t('historyEmpty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {history.map((post) => {
                const b = post.results?.broadcast;
                const paused = !!b && !b.done && progress?.postId !== post.id;
                return (
                  <li key={post.id} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex gap-3">
                      {post.media_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={post.media_url}
                          alt=""
                          loading="lazy"
                          className="size-16 shrink-0 rounded-lg border border-border object-cover"
                        />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-foreground">
                          {post.caption || t('noText')}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {new Date(post.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(post.results?.status ?? []).map((s) => (
                        <Badge
                          key={s.channel_id}
                          variant="outline"
                          title={s.error}
                          className={cn(
                            'gap-1 font-normal',
                            s.ok ? 'border-emerald-500/40 text-emerald-300' : 'border-red-500/40 text-red-300',
                          )}
                        >
                          {s.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                          {t('badgeStatus', { name: channelName(s.channel_id) })}
                        </Badge>
                      ))}
                      {b && (
                        <Badge
                          variant="outline"
                          title={b.last_error}
                          className={cn(
                            'font-normal',
                            b.done && b.failed === 0
                              ? 'border-emerald-500/40 text-emerald-300'
                              : 'border-amber-500/40 text-amber-300',
                          )}
                        >
                          {t('badgeBroadcast', { sent: b.sent, total: b.total, failed: b.failed })}
                        </Badge>
                      )}
                      {post.results?.drive && (
                        <Badge
                          variant="outline"
                          title={post.results.drive.error}
                          className={cn(
                            'font-normal',
                            post.results.drive.ok
                              ? 'border-emerald-500/40 text-emerald-300'
                              : 'border-red-500/40 text-red-300',
                          )}
                        >
                          {t('badgeDrive')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => reuse(post)}>
                        <RotateCcw className="size-4" />
                        {t('reuse')}
                      </Button>
                      {paused && b && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!progress}
                          onClick={() => void runBroadcast(post.id, b)}
                        >
                          <Send className="size-4" />
                          {t('broadcastContinue')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto"
                        aria-label={t('delete')}
                        onClick={() => void removePost(post)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {historyTotal > HISTORY_PAGE && (
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {historyPage * HISTORY_PAGE + 1}–{Math.min((historyPage + 1) * HISTORY_PAGE, historyTotal)} / {historyTotal}
              </span>
              <span className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={historyPage === 0}
                  onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(historyPage + 1) * HISTORY_PAGE >= historyTotal}
                  onClick={() => setHistoryPage((p) => p + 1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Pick an image Atlas saved to Google Drive */}
      <Dialog open={driveOpen} onOpenChange={setDriveOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('drivePickTitle')}</DialogTitle>
            <DialogDescription>{t('drivePickDesc')}</DialogDescription>
          </DialogHeader>
          {driveFiles === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : driveFiles.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('drivePickEmpty')}</p>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {driveFiles.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={!!driveBusy}
                  onClick={() => void pickDriveFile(f)}
                  className="group relative overflow-hidden rounded-lg border border-border bg-muted text-left hover:border-primary"
                >
                  {f.thumbnailLink ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.thumbnailLink}
                      alt={f.name}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center">
                      <ImagePlus className="size-6 text-muted-foreground" />
                    </div>
                  )}
                  <p className="truncate px-1.5 py-1 text-[11px] text-muted-foreground">{f.name}</p>
                  {driveBusy === f.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 className="size-5 animate-spin text-white" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
