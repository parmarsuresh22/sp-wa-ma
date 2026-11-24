'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Camera, CameraOff, CheckCircle2, Loader2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api, postJson, stamp, type EventView } from './shared';

interface ScanAnswer {
  /** `error` is ours: the portal could not be reached. */
  result: 'ok' | 'used' | 'cancelled' | 'wrong_event' | 'unknown' | 'error';
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
/** How long the answer stays above the camera, unless the next scan replaces it first. */
const SHOW_OK_MS = 4000;
const SHOW_BAD_MS = 8000;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** One high beep for "let them in", two low ones for "stop". */
function beep(ctx: AudioContext | null, good: boolean) {
  if (!ctx) return;
  try {
    const tones = good ? [[880, 0, 0.16]] : [[220, 0, 0.22], [220, 0.3, 0.22]];
    for (const [freq, start, length] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = good ? 'sine' : 'square';
      osc.frequency.value = freq;
      gain.gain.value = good ? 0.25 : 0.18;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + length);
    }
  } catch {
    // No sound is fine; the colour and the vibration still tell.
  }
}

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
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<ScanAnswer | null>(null);
  const [typed, setTyped] = useState('');
  // The answer shows above the camera for a moment; `last` stays as a small
  // line underneath in case the person at the gate looked away.
  const [last, setLast] = useState<ScanAnswer | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  /** Sound may only start from a tap, so this runs on the buttons. */
  const wakeSound = useCallback(() => {
    try {
      if (!audioRef.current) {
        const Ctx = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
        if (Ctx) audioRef.current = new Ctx();
      }
      void audioRef.current?.resume();
    } catch {
      // Sound is a bonus.
    }
  }, []);

  const show = useCallback((res: ScanAnswer) => {
    setAnswer(res);
    setLast(res);
    const good = res.result === 'ok';
    beep(audioRef.current, good);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(good ? 120 : [120, 80, 120, 80, 120]);
    }
  }, []);

  const submit = useCallback(
    async (code: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setChecking(true);
      try {
        const res = await api<ScanAnswer>(`/api/events/${event.id}/scan`, postJson('POST', { code }));
        show(res);
        if (res.result === 'ok') onScanned();
      } catch {
        // Forget the code, so holding the same pass up again retries it.
        lastRef.current = { code: '', at: 0 };
        show({ result: 'error' });
      } finally {
        busyRef.current = false;
        setChecking(false);
      }
    },
    [event.id, onScanned, show],
  );

  // The answer clears itself, so the next guest can step up without a tap.
  useEffect(() => {
    if (!answer) return;
    const timer = setTimeout(() => setAnswer(null), answer.result === 'ok' ? SHOW_OK_MS : SHOW_BAD_MS);
    return () => clearTimeout(timer);
  }, [answer]);

  // Keep the phone's screen on while the camera is scanning.
  useEffect(() => {
    if (!on) return;
    let lock: { release: () => Promise<void> } | null = null;
    let gone = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock
      ?.request('screen')
      .then((l) => {
        if (gone) void l.release().catch(() => undefined);
        else lock = l;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      void lock?.release().catch(() => undefined);
    };
  }, [on]);

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      const fail = (key: string) => {
        if (stopped) return;
        setCameraError(t(key));
        setStarting(false);
        setOn(false);
      };
      // Browsers inside another app (the one WhatsApp opens links in,
      // for example) and pages not on https have no camera at all.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        fail('cameraUnsupported');
        return;
      }
      // This call is what makes the browser ask "Allow camera?".
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
            audio: false,
          });
        } catch (err) {
          const name = (err as { name?: string })?.name;
          if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err;
          // No back camera (a laptop, say): take whichever camera there is.
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
      } catch (err) {
        const name = (err as { name?: string })?.name;
        fail(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'cameraDenied'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'cameraMissing'
              : name === 'NotReadableError' || name === 'AbortError'
                ? 'cameraBusy'
                : 'cameraBlocked',
        );
        return;
      }
      if (!stopped) setStarting(false);
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

      {/* The answer sits above the camera, never on it, so the next
          pass can be read while this one is still on show. The strip
          keeps its height, so the camera does not jump. */}
      <div
        role="status"
        aria-live="assertive"
        className={cn(
          'flex h-28 w-full items-center gap-3 overflow-hidden rounded-xl px-4 text-left',
          !answer
            ? 'border border-dashed border-border text-muted-foreground'
            : good
              ? 'bg-emerald-600 text-white'
              : 'bg-red-600 text-white',
        )}
      >
        {!answer ? (
          <>
            {checking ? <Loader2 className="size-8 shrink-0 animate-spin" /> : <Camera className="size-8 shrink-0" />}
            <span className="text-sm">{checking ? t('scanChecking') : t('scanReady')}</span>
          </>
        ) : (
          <>
            {good ? <CheckCircle2 className="size-16 shrink-0" /> : <XCircle className="size-16 shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-extrabold leading-tight">{t(`scan.${answer.result}`)}</p>
              {pass && (
                <>
                  <p className="truncate text-lg font-semibold leading-snug">{pass.holder_name || pass.phone_key}</p>
                  <p className="truncate text-sm text-white/90">
                    {pass.pass_type}
                    {pass.quantity ? ` · ${t('passOf', { n: pass.seq, total: pass.quantity })}` : ''}
                    {answer.result === 'used' && pass.used_at ? ` · ${t('usedAt', { time: stamp(pass.used_at) })}` : ''}
                    {answer.result === 'wrong_event' && pass.event_name ? ` · ${t('passIsFor', { event: pass.event_name })}` : ''}
                  </p>
                </>
              )}
            </div>
            {checking && <Loader2 className="size-6 shrink-0 animate-spin" />}
          </>
        )}
      </div>

      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={cn('size-full object-cover', (!on || starting) && 'hidden')}
        />
        <canvas ref={canvasRef} className="hidden" />
        {on && !starting ? (
          <div
            className={cn(
              'pointer-events-none absolute inset-8 rounded-xl border-4',
              !answer ? 'border-white/70' : good ? 'border-emerald-400' : 'border-red-500',
            )}
          />
        ) : starting ? (
          <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
            <Loader2 className="size-10 animate-spin text-white/80" />
            <p className="text-sm text-white/80">{t('cameraAsking')}</p>
          </div>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
            {cameraError ? (
              <CameraOff className="size-10 text-red-400" />
            ) : (
              <Camera className="size-10 text-white/60" />
            )}
            <p role={cameraError ? 'alert' : undefined} className={cn('text-sm', cameraError ? 'text-red-200' : 'text-white/70')}>
              {cameraError ?? t('scanIntro')}
            </p>
          </div>
        )}
      </div>

      <Button
        type="button"
        className="w-full"
        variant={on ? 'outline' : 'default'}
        onClick={() => {
          wakeSound();
          setCameraError(null);
          setStarting(!on);
          setOn((v) => !v);
        }}
      >
        {on ? <CameraOff className="size-4" /> : <Camera className="size-4" />}
        {on ? t('stopCamera') : cameraError ? t('retryCamera') : t('startCamera')}
      </Button>

      {last && !answer && (
        <p
          className={cn(
            'truncate text-center text-sm font-medium',
            last.result === 'ok' ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {t('lastScan', {
            result: t(`scan.${last.result}`),
            who: last.pass ? last.pass.holder_name || last.pass.phone_key : '-',
          })}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          wakeSound();
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
