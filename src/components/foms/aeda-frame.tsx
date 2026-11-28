'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/** Only pages of the module itself may be opened through `?p=`. */
function safeStart(raw: string | null): string {
  if (raw && /^\/aeda(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&%_.~+-]*)?$/.test(raw)) return raw;
  return '/aeda';
}

/**
 * AEDA Forms inside the portal. The module is the original FOMS
 * application with its own screens and styles, so it is shown in a
 * frame that fills the page. The address of the portal follows the
 * page open in the frame (`?p=`), so a refresh or a shared link comes
 * back to the same place.
 */
export function AedaFrame() {
  const params = useSearchParams();
  // Read once: afterwards the frame leads and the address follows.
  const [start] = useState(() => safeStart(params.get('p')));
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');

  // Anyone but the platform admin gets "not found" from the server.
  useEffect(() => {
    let alive = true;
    fetch('/api/aeda-forms/access', { cache: 'no-store' })
      .then((res) => alive && setState(res.ok ? 'ready' : 'denied'))
      .catch(() => alive && setState('denied'));
    return () => {
      alive = false;
    };
  }, []);

  const follow = () => {
    try {
      const loc = frame.current?.contentWindow?.location;
      if (!loc || !loc.pathname.startsWith('/aeda')) return;
      const inner = loc.pathname + loc.search;
      const next = inner === '/aeda' ? '/aeda-forms' : `/aeda-forms?p=${encodeURIComponent(inner)}`;
      window.history.replaceState(window.history.state, '', next);
    } catch {
      /* the frame went to another site: nothing to follow */
    }
  };

  if (state === 'denied') {
    return <p className="py-16 text-center text-sm text-muted-foreground">This page is not available.</p>;
  }
  return (
    // Fills the page: the padding of the main area is taken back, and the
    // height is the window less the top bar.
    <div className="-m-4 h-[calc(100dvh-3.5rem)] sm:-m-6">
      {state === 'loading' ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : (
        <iframe ref={frame} src={start} title="AEDA Forms" onLoad={follow} className="block h-full w-full border-0 bg-background" />
      )}
    </div>
  );
}
