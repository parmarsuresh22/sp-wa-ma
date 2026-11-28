'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';

import { cleanSchema, type Answers, type FormSchema } from '@/lib/aeda-forms/schema';
import { FormRenderer } from './form-renderer';

/** The page behind a form's public link: no sign-in, one form. */
export function PublicForm({ token }: { token: string }) {
  const [form, setForm] = useState<{ name: string; schema: FormSchema } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [done, setDone] = useState<{ ref: string; message: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A box people never see; robots fill it in.
  const [website, setWebsite] = useState('');

  useEffect(() => {
    let alive = true;
    fetch(`/api/public/forms/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) return setState('missing');
        const data = (await res.json()) as { name: string; schema: unknown };
        setForm({ name: data.name, schema: cleanSchema(data.schema) });
        setState('ready');
      })
      .catch(() => alive && setState('missing'));
    return () => {
      alive = false;
    };
  }, [token]);

  const submit = async (answers: Answers) => {
    setProblem(null);
    const res = await fetch(`/api/public/forms/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: answers, website }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      setProblem(data.error || 'Could not send your answer. Check your connection and try again.');
      return (data.errors as Record<string, string> | undefined) ?? {};
    }
    setDone({ ref: data.ref, message: data.message });
  };

  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl px-4 py-8 sm:py-12">
      {state === 'loading' && (
        <div className="flex justify-center py-20">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}
      {state === 'missing' && (
        <p className="py-20 text-center text-sm text-muted-foreground">This form is not available.</p>
      )}
      {state === 'ready' && form && (
        <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-8">
          <h1 className="mb-4 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{form.name}</h1>
          {done ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CheckCircle2 className="size-10 text-emerald-500" />
              <p className="text-base font-medium text-foreground">{done.message}</p>
              <p className="text-sm text-muted-foreground">
                Reference: <span className="font-mono font-semibold text-foreground">{done.ref}</span>
              </p>
            </div>
          ) : (
            <>
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
              />
              <FormRenderer schema={form.schema} onSubmit={submit} />
              {problem && (
                <p role="alert" className="mt-3 text-sm font-medium text-red-400">
                  {problem}
                </p>
              )}
            </>
          )}
        </div>
      )}
      <p className="mt-6 text-center text-xs text-muted-foreground">Atlas by LLC Solution</p>
    </main>
  );
}
