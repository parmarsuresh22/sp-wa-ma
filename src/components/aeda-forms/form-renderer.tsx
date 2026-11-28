'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { collectsAnswer, type Answers, type FormField, type FormSchema } from '@/lib/aeda-forms/schema';
import { cn } from '@/lib/utils';

export const inputClass =
  'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60';

const WIDTH: Record<FormField['width'], string> = {
  full: 'sm:col-span-6',
  half: 'sm:col-span-3',
  third: 'sm:col-span-2',
};

/** The answers a form starts with: each field's default value. */
export function startingAnswers(schema: FormSchema, existing?: Record<string, unknown> | null): Answers {
  const out: Answers = {};
  for (const f of schema.fields) {
    if (!collectsAnswer(f)) continue;
    const had = existing?.[f.key];
    if (f.type === 'checkbox') {
      out[f.key] = Array.isArray(had) ? had.filter((v): v is string => typeof v === 'string') : [];
    } else {
      out[f.key] = typeof had === 'string' || typeof had === 'number' ? String(had) : existing ? '' : f.defaultValue;
    }
  }
  return out;
}

/**
 * A form drawn from its design. Used wherever a form is filled in: the
 * public link, the portal, the preview in the designer and the edit
 * window of an answer. `onSubmit` returns problems by field key (or
 * nothing when the answer was taken).
 */
export function FormRenderer({
  schema,
  initial,
  onSubmit,
  submitLabel,
  disabled,
}: {
  schema: FormSchema;
  initial?: Record<string, unknown> | null;
  onSubmit: (answers: Answers) => Promise<Record<string, string> | void>;
  submitLabel?: string;
  disabled?: boolean;
}) {
  const [answers, setAnswers] = useState<Answers>(() => startingAnswers(schema, initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (key: string, value: string | string[]) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    try {
      const problems = await onSubmit(answers);
      setErrors(problems ?? {});
      if (problems) {
        const first = schema.fields.find((f) => problems[f.key]);
        if (first) document.getElementById(`af-${first.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      {schema.description && <p className="text-sm whitespace-pre-line text-muted-foreground">{schema.description}</p>}
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-6">
        {schema.fields.map((f) => {
          if (f.type === 'heading') {
            return (
              <div key={f.id} className="border-b border-border pb-1 sm:col-span-6">
                <h3 className="text-base font-semibold text-foreground">{f.label}</h3>
                {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
              </div>
            );
          }
          const id = `af-${f.id}`;
          const error = errors[f.key];
          const value = answers[f.key];
          const str = typeof value === 'string' ? value : '';
          const list = Array.isArray(value) ? value : [];
          return (
            <div key={f.id} className={cn('min-w-0', WIDTH[f.width])}>
              <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  id={id}
                  rows={4}
                  className={cn(inputClass, 'h-auto py-2')}
                  placeholder={f.placeholder}
                  value={str}
                  disabled={disabled}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : f.type === 'dropdown' ? (
                <select id={id} className={inputClass} value={str} disabled={disabled} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">{f.placeholder || 'Choose…'}</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === 'radio' || f.type === 'checkbox' ? (
                <div id={id} role={f.type === 'radio' ? 'radiogroup' : 'group'} className="flex flex-col gap-1.5 pt-0.5">
                  {f.options.map((o) => {
                    const checked = f.type === 'radio' ? str === o : list.includes(o);
                    return (
                      <label key={o} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                        <input
                          type={f.type === 'radio' ? 'radio' : 'checkbox'}
                          name={id}
                          className="size-4 accent-[var(--primary)]"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) =>
                            f.type === 'radio'
                              ? set(f.key, o)
                              : set(f.key, e.target.checked ? [...list, o] : list.filter((v) => v !== o))
                          }
                        />
                        {o}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input
                  id={id}
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  className={inputClass}
                  placeholder={f.placeholder}
                  value={str}
                  disabled={disabled}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.help && <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>}
              {error && (
                <p role="alert" className="mt-1 text-xs font-medium text-red-400">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="submit"
        disabled={busy || disabled}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        {submitLabel ?? schema.submitLabel}
      </button>
    </form>
  );
}
