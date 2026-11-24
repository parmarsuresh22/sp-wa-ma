'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Camera, CameraOff, CheckCircle2, Loader2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api, postJson, stamp, type EventView } from './shared';

interface ScanAnswer {
  result: 'ok' | 'used' | 'cancelled' | 'wrong_event' | 'unknown';
  pass?: {
    holder_name: string | null;
    phone_key: string;
    seq: number;
    used_at: string | null;
    pass_type: string | null;
    quantity: number | null;
    event_name: string | null;
  };
}

/** The same QR is ignored for this long, so holding it up does not re-scan it. */
const SAME_CODE_MS = 6000;
const SCAN_EVERY_MS = 180;

/**
 * The gate scanner: the phone camera reads a pass QR and the portal
 * answers green (let them in) or red (why not). Works in any browser
 * with a camera — the picture is decoded on the phone, only the code
 * is sent.
 */
export function PassScanner({
  event,
  checkedIn,
  issued,
  onScanned,
}: {
  event: EventView;
  checkedIn: number;
  issued: number;
  onScanned: () => void;
}) {
  const t = useTranslations('Events');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const busyRef = useRef(false);
  const [on, setOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<ScanAnswer | null>(null);
  const [typed, setTyped] = useState('');

  const submit = useCallback(
    async (code: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setChecking(true);
      try {
        const res = await api<ScanAnswer>(`/api/events/${event.id}/scan`, postJson('POST', { code }));
        setAnswer(res);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(res.result === 'ok' ? 120 : [120, 80, 120, 80, 120]);
        }
        if (res.result === 'ok') onScanned();
      } catch {
        setAnswer(null);
        setCameraError(t('scanFailed'));
      } finally {
        busyRef.current = false;
        setChecking(false);
      }
    },
    [event.id, onScanned, t],
  );

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch {
        if (!stopped) {
          setCameraError(t('cameraBlocked'));
          setOn(false);
        }
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      const { default: jsQR } = await import('jsqr');

      const tick = () => {
        if (stopped) return;
        const canvas = canvasRef.current;
        if (canvas && video.readyState >= 2 && video.videoWidth > 0 && !busyRef.current) {
          // Half size is plenty for a QR and much faster to decode.
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
            const code = found?.data?.trim();
            if (code) {
              const last = lastRef.current;
              const now = Date.now();
              if (code !== last.code || now - last.at > SAME_CODE_MS) {
                lastRef.current = { code, at: now };
                void submit(code);
              }
            }
          }
        }
        timer = setTimeout(tick, SCAN_EVERY_MS);
      };
      tick();
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [on, submit, t]);

  const good = answer?.result === 'ok';
  const pass = answer?.pass;

  return (
    <div className="mx-auto w-full max-w-md space-y-3">
      <p className="text-center text-sm text-muted-foreground">{t('scanCount', { used: checkedIn, total: issued })}</p>

      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-black">
        <video ref={videoRef} playsInline muted className={cn('size-full object-cover', !on && 'hidden')} />
        <canvas ref={canvasRef} className="hidden" />
        {on ? (
          <div className="pointer-events-none absolute inset-8 rounded-xl border-2 border-white/70" />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Camera className="size-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{cameraError ?? t('scanIntro')}</p>
          </div>
        )}
        {checking && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <Loader2 className="size-8 animate-spin text-white" />
          </div>
        )}
      </div>

      <Button
        type="button"
        className="w-full"
        variant={on ? 'outline' : 'default'}
        onClick={() => {
          setCameraError(null);
          setOn((v) => !v);
        }}
      >
        {on ? <CameraOff className="size-4" /> : <Camera className="size-4" />}
        {on ? t('stopCamera') : t('startCamera')}
      </Button>

      {answer && (
        <div
          role="status"
          className={cn(
            'rounded-xl border-2 p-4 text-center',
            good ? 'border-emerald-500 bg-emerald-500/15' : 'border-red-500 bg-red-500/15',
          )}
        >
          {good ? (
            <CheckCircle2 className="mx-auto size-12 text-emerald-400" />
          ) : (
            <XCircle className="mx-auto size-12 text-red-400" />
          )}
          <p className={cn('mt-2 text-lg font-bold', good ? 'text-emerald-300' : 'text-red-300')}>
            {t(`scan.${answer.result}`)}
          </p>
          {pass && (
            <div className="mt-2 space-y-0.5 text-sm text-foreground">
              <p className="font-semibold">{pass.holder_name || pass.phone_key}</p>
              <p className="text-muted-foreground">
                {pass.pass_type}
                {pass.quantity ? ` · ${t('passOf', { n: pass.seq, total: pass.quantity })}` : ''}
              </p>
              {answer.result === 'used' && pass.used_at && (
                <p className="text-red-300">{t('usedAt', { time: stamp(pass.used_at) })}</p>
              )}
              {answer.result === 'wrong_event' && pass.event_name && (
                <p className="text-red-300">{t('passIsFor', { event: pass.event_name })}</p>
              )}
            </div>
          )}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) void submit(typed.trim());
          setTyped('');
        }}
      >
        <Input value={typed} autoCapitalize="characters" onChange={(e) => setTyped(e.target.value)} placeholder={t('typeCode')} />
        <Button type="submit" variant="outline" disabled={!typed.trim() || checking}>
          {t('check')}
        </Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">{t('scanHelp')}</p>
    </div>
  );
}
