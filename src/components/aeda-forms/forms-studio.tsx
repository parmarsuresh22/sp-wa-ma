'use client';

/* AEDA Forms (migration 089): projects → forms → design, fill in,
   answers. Open to the platform admin only while it is being tried
   out, so its texts are written here rather than in the message
   files; they move there when the module is opened to everyone. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';

import {
  FIELD_TYPES,
  FIELD_TYPE_LABEL,
  answerText,
  cleanSchema,
  collectsAnswer,
  csvCell,
  hasOptions,
  keyFromLabel,
  type Answers,
  type FieldType,
  type FormField,
  type FormSchema,
} from '@/lib/aeda-forms/schema';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { FormRenderer, inputClass } from './form-renderer';

// ------------------------------------------------------------
// Talking to the server
// ------------------------------------------------------------

class ApiError extends Error {
  status: number;
  errors?: Record<string, string>;
  constructor(message: string, status: number, errors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/aeda-forms${path}`, {
    method: init?.method ?? 'GET',
    cache: 'no-store',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong', res.status, data.errors);
  return data as T;
}

const say = (err: unknown) => toast.error(err instanceof Error ? err.message : 'Something went wrong', { duration: 8000 });
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

interface Project {
  id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  form_count: number;
}
interface FormSummary {
  id: string;
  name: string;
  status: 'draft' | 'published';
  published_version: number;
  archived_at: string | null;
  updated_at: string;
  field_count: number;
  submission_count: number;
}
interface FormFull {
  id: string;
  project_id: string;
  name: string;
  schema: FormSchema;
  status: 'draft' | 'published';
  published_schema: FormSchema | null;
  published_version: number;
  public_token: string;
  public_enabled: boolean;
}
interface Submission {
  id: string;
  ref: string;
  version: number;
  data: Record<string, unknown>;
  stage: string | null;
  source: 'portal' | 'link';
  modified_by: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// The module
// ------------------------------------------------------------

export function FormsStudio() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get('project');
  const formId = params.get('form');
  const view = params.get('view') ?? 'design';
  const go = useCallback(
    (next: Record<string, string>) => {
      const q = new URLSearchParams(next).toString();
      router.push(q ? `/aeda-forms?${q}` : '/aeda-forms');
    },
    [router],
  );
  // Asked once: anyone but the platform admin gets "not found".
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    api('/projects')
      .then(() => setAllowed(true))
      .catch((err) => setAllowed(!(err instanceof ApiError && err.status === 404)));
  }, []);

  if (allowed === null) return <Spinner />;
  if (!allowed) {
    return <p className="py-16 text-center text-sm text-muted-foreground">This page is not available.</p>;
  }
  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">AEDA Forms</h1>
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-amber-300 uppercase">
          Admin preview
        </span>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        Build a form, publish it, share its link, and collect the answers here. Only you can see this module for now.
      </p>
      {formId ? (
        <FormWorkspace key={formId} formId={formId} view={view} go={go} />
      ) : projectId ? (
        <ProjectView key={projectId} projectId={projectId} go={go} />
      ) : (
        <ProjectsView go={go} />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <Loader2 className="size-6 animate-spin text-primary" />
    </div>
  );
}

type Go = (next: Record<string, string>) => void;

/** A one-line "name it and create" row. */
function CreateRow({ placeholder, label, onCreate }: { placeholder: string; label: string; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim());
      setName('');
    } catch (err) {
      say(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2">
      <input className={cn(inputClass, 'max-w-xs')} placeholder={placeholder} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        {label}
      </Button>
    </form>
  );
}

// ------------------------------------------------------------
// Projects
// ------------------------------------------------------------

function ProjectsView({ go }: { go: Go }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(() => api<{ projects: Project[] }>('/projects').then((d) => setProjects(d.projects)).catch(say), []);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (p: Project, body: Record<string, unknown>) => {
    await api(`/projects/${p.id}`, { method: 'PATCH', body }).catch(say);
    await load();
  };
  const remove = async (p: Project) => {
    if (!confirm(`Delete "${p.name}" with all its forms and answers? This cannot be undone.`)) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' }).catch(say);
    await load();
  };

  if (!projects) return <Spinner />;
  const shown = projects.filter((p) => showArchived || !p.archived_at);
  const archivedCount = projects.filter((p) => p.archived_at).length;
  return (
    <div className="space-y-5">
      <CreateRow
        placeholder="New project name"
        label="Create project"
        onCreate={async (name) => {
          const { project } = await api<{ project: Project }>('/projects', { method: 'POST', body: { name } });
          go({ project: project.id });
        }}
      />
      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <FolderOpen className="mx-auto mb-2 size-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No projects yet</p>
          <p className="text-sm text-muted-foreground">A project is a folder for related forms. Create one to begin.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => (
            <div key={p.id} className={cn('rounded-xl border border-border bg-card p-4', p.archived_at && 'opacity-70')}>
              <button type="button" onClick={() => go({ project: p.id })} className="block w-full text-left">
                <p className="truncate text-base font-semibold text-foreground">{p.name}</p>
                <p className="text-sm text-muted-foreground">
                  {p.form_count} {p.form_count === 1 ? 'form' : 'forms'}
                  {p.archived_at ? ' · archived' : ''}
                </p>
              </button>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => go({ project: p.id })}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const name = prompt('Project name', p.name)?.trim();
                    if (name) void patch(p, { name });
                  }}
                >
                  <Pencil className="size-3.5" /> Rename
                </Button>
                <Button size="sm" variant="outline" onClick={() => void patch(p, { archived: !p.archived_at })}>
                  <Archive className="size-3.5" /> {p.archived_at ? 'Restore' : 'Archive'}
                </Button>
                {p.archived_at && (
                  <Button size="sm" variant="outline" onClick={() => void remove(p)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {archivedCount > 0 && (
        <button type="button" onClick={() => setShowArchived((s) => !s)} className="text-xs text-muted-foreground underline">
          {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// One project: its forms
// ------------------------------------------------------------

function ProjectView({ projectId, go }: { projectId: string; go: Go }) {
  const [data, setData] = useState<{ project: Project; forms: FormSummary[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const load = useCallback(
    () =>
      api<{ project: Project; forms: FormSummary[] }>(`/projects/${projectId}`)
        .then(setData)
        .catch((err) => (err instanceof ApiError && err.status === 404 ? setMissing(true) : say(err))),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (missing) return <Missing go={go} what="project" />;
  if (!data) return <Spinner />;
  const shown = data.forms.filter((f) => showArchived || !f.archived_at);
  const archivedCount = data.forms.filter((f) => f.archived_at).length;
  const patch = async (f: FormSummary, body: Record<string, unknown>) => {
    await api(`/forms/${f.id}`, { method: 'PATCH', body }).catch(say);
    await load();
  };
  const remove = async (f: FormSummary) => {
    if (!confirm(`Delete "${f.name}" and its ${f.submission_count} answers? This cannot be undone.`)) return;
    await api(`/forms/${f.id}`, { method: 'DELETE' }).catch(say);
    await load();
  };

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => go({})} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All projects
      </button>
      <h2 className="text-lg font-semibold text-foreground">{data.project.name}</h2>
      <CreateRow
        placeholder="New form name"
        label="Create form"
        onCreate={async (name) => {
          const { form } = await api<{ form: FormFull }>(`/projects/${projectId}`, { method: 'POST', body: { name } });
          go({ form: form.id, view: 'design' });
        }}
      />
      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <ClipboardList className="mx-auto mb-2 size-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No forms in this project yet</p>
          <p className="text-sm text-muted-foreground">Create a form, add its fields, then publish it.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {shown.map((f) => (
            <div key={f.id} className={cn('flex flex-wrap items-center gap-3 border-b border-border p-3 last:border-b-0', f.archived_at && 'opacity-70')}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{f.name}</p>
                <p className="text-xs text-muted-foreground">
                  <StatusChip published={f.status === 'published'} version={f.published_version} /> · {f.field_count} fields ·{' '}
                  {f.submission_count} answers{f.archived_at ? ' · archived' : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => go({ form: f.id, view: 'design' })}>
                  <Pencil className="size-3.5" /> Design
                </Button>
                <Button size="sm" variant="outline" onClick={() => go({ form: f.id, view: 'fill' })}>
                  Fill in
                </Button>
                <Button size="sm" variant="outline" onClick={() => go({ form: f.id, view: 'answers' })}>
                  Answers
                </Button>
                <Button size="sm" variant="outline" onClick={() => void patch(f, { archived: !f.archived_at })}>
                  <Archive className="size-3.5" /> {f.archived_at ? 'Restore' : 'Archive'}
                </Button>
                {f.archived_at && (
                  <Button size="sm" variant="outline" onClick={() => void remove(f)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {archivedCount > 0 && (
        <button type="button" onClick={() => setShowArchived((s) => !s)} className="text-xs text-muted-foreground underline">
          {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
        </button>
      )}
    </div>
  );
}

function StatusChip({ published, version }: { published: boolean; version: number }) {
  return (
    <span className={cn('font-medium', published ? 'text-emerald-400' : 'text-amber-300')}>
      {published ? `Published (version ${version})` : version > 0 ? `Draft (last published: version ${version})` : 'Draft'}
    </span>
  );
}

function Missing({ go, what }: { go: Go; what: string }) {
  return (
    <div className="py-16 text-center">
      <p className="mb-3 text-sm text-muted-foreground">This {what} does not exist any more.</p>
      <Button variant="outline" onClick={() => go({})}>
        All projects
      </Button>
    </div>
  );
}

// ------------------------------------------------------------
// One form: design, fill in, answers
// ------------------------------------------------------------

const VIEWS = [
  { id: 'design', label: 'Design' },
  { id: 'fill', label: 'Fill in' },
  { id: 'answers', label: 'Answers' },
] as const;

function FormWorkspace({ formId, view, go }: { formId: string; view: string; go: Go }) {
  const [form, setForm] = useState<FormFull | null>(null);
  const [versions, setVersions] = useState<{ version: number; published_at: string }[]>([]);
  const [missing, setMissing] = useState(false);
  const load = useCallback(
    () =>
      api<{ form: FormFull; versions: { version: number; published_at: string }[] }>(`/forms/${formId}`)
        .then((d) => {
          setForm({ ...d.form, schema: cleanSchema(d.form.schema) });
          setVersions(d.versions);
        })
        .catch((err) => (err instanceof ApiError && err.status === 404 ? setMissing(true) : say(err))),
    [formId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (missing) return <Missing go={go} what="form" />;
  if (!form) return <Spinner />;
  const active = VIEWS.some((v) => v.id === view) ? view : 'design';
  const link = typeof window !== 'undefined' ? `${window.location.origin}/f/${form.public_token}` : '';

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => go({ project: form.project_id })}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to the project
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-foreground">{form.name}</h2>
          <p className="text-xs">
            <StatusChip published={form.status === 'published'} version={form.published_version} />
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => go({ form: form.id, view: v.id })}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                active === v.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {form.status === 'published' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
          <Link2 className="size-4 shrink-0 text-primary" />
          {form.public_enabled ? (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{link}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigator.clipboard.writeText(link).then(
                    () => toast.success('Link copied'),
                    () => toast.error('Could not copy the link'),
                  )
                }
              >
                <Copy className="size-3.5" /> Copy link
              </Button>
            </>
          ) : (
            <span className="flex-1 text-muted-foreground">The public link is off. Only you can fill this form in, from the portal.</span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              api(`/forms/${form.id}`, { method: 'PATCH', body: { public_enabled: !form.public_enabled } })
                .then(load)
                .catch(say)
            }
          >
            {form.public_enabled ? 'Switch link off' : 'Switch link on'}
          </Button>
        </div>
      )}

      {active === 'design' && <Designer form={form} versions={versions} onChanged={load} />}
      {active === 'fill' && <FillIn form={form} go={go} />}
      {active === 'answers' && <AnswersView form={form} />}
    </div>
  );
}

// ------------------------------------------------------------
// Designer
// ------------------------------------------------------------

function newField(type: FieldType, existing: FormField[]): FormField {
  const label = FIELD_TYPE_LABEL[type];
  const keys = new Set(existing.map((f) => f.key));
  const ids = new Set(existing.map((f) => f.id));
  let key = keyFromLabel(label);
  for (let n = 2; keys.has(key); n++) key = `${keyFromLabel(label)}_${n}`;
  let id = `f${existing.length + 1}`;
  for (let n = existing.length + 2; ids.has(id); n++) id = `f${n}`;
  return {
    id,
    type,
    key,
    label,
    placeholder: '',
    help: '',
    required: false,
    options: hasOptions(type) ? ['Option 1', 'Option 2'] : [],
    width: 'full',
    defaultValue: '',
  };
}

function Designer({
  form,
  versions,
  onChanged,
}: {
  form: FormFull;
  versions: { version: number; published_at: string }[];
  onChanged: () => Promise<unknown>;
}) {
  const [schema, setSchema] = useState<FormSchema>(form.schema);
  const [name, setName] = useState(form.name);
  const [selected, setSelected] = useState<string | null>(form.schema.fields[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const locked = form.status === 'published';
  const field = schema.fields.find((f) => f.id === selected) ?? null;

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = (next: FormSchema) => {
    setSchema(next);
    setDirty(true);
  };
  const setField = (id: string, patch: Partial<FormField>) =>
    change({ ...schema, fields: schema.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const add = (type: FieldType) => {
    const f = newField(type, schema.fields);
    change({ ...schema, fields: [...schema.fields, f] });
    setSelected(f.id);
  };
  const move = (id: string, by: number) => {
    const at = schema.fields.findIndex((f) => f.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= schema.fields.length) return;
    const fields = [...schema.fields];
    [fields[at], fields[to]] = [fields[to], fields[at]];
    change({ ...schema, fields });
  };
  const duplicate = (f: FormField) => {
    const copy = { ...newField(f.type, schema.fields), label: `${f.label} (copy)`, placeholder: f.placeholder, help: f.help, required: f.required, options: [...f.options], width: f.width, defaultValue: f.defaultValue };
    const at = schema.fields.findIndex((x) => x.id === f.id);
    const fields = [...schema.fields];
    fields.splice(at + 1, 0, copy);
    change({ ...schema, fields });
    setSelected(copy.id);
  };
  const remove = (id: string) => {
    change({ ...schema, fields: schema.fields.filter((f) => f.id !== id) });
    if (selected === id) setSelected(null);
  };

  const run = async (what: string, body: Record<string, unknown>, done: string) => {
    setBusy(what);
    try {
      const { form: saved } = await api<{ form: FormFull }>(`/forms/${form.id}`, { method: 'PATCH', body });
      setSchema(cleanSchema(saved.schema));
      setName(saved.name);
      setDirty(false);
      toast.success(done);
      await onChanged();
    } catch (err) {
      say(err);
    } finally {
      setBusy(null);
    }
  };
  const save = () => run('save', { name, schema }, 'Design saved');
  const publish = () => run('publish', { name, schema, publish: true }, 'Published. The form can now be filled in.');
  const unpublish = () => {
    if (!confirm('Unpublish this form? Its link stops working until you publish again. Answers already given are kept.')) return;
    void run('unpublish', { publish: false }, 'Unpublished. You can change the design now.');
  };
  const restore = (version: number) => {
    if (!confirm(`Load version ${version} into the design? What is in the design now is replaced.`)) return;
    void run('restore', { restore: version }, `Version ${version} loaded into the design`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <input
          className={cn(inputClass, 'max-w-xs')}
          value={name}
          maxLength={80}
          disabled={locked}
          aria-label="Form name"
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setPreview(true)}>
            <Eye className="size-4" /> Preview
          </Button>
          {locked ? (
            <Button variant="outline" onClick={unpublish} disabled={!!busy}>
              {busy === 'unpublish' && <Loader2 className="size-4 animate-spin" />}
              Unpublish to edit
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => void save()} disabled={!!busy || !dirty}>
                {busy === 'save' ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save
              </Button>
              <Button onClick={() => void publish()} disabled={!!busy}>
                {busy === 'publish' ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {dirty ? 'Save and publish' : 'Publish'}
              </Button>
            </>
          )}
        </div>
      </div>
      {locked && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          This form is published, so its design is locked: what people are filling in must not change under them. Unpublish it to make changes.
        </p>
      )}

      <fieldset disabled={locked} className="grid min-w-0 gap-4 lg:grid-cols-[180px_minmax(0,1fr)_300px]">
        {/* What can be added */}
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Add a field</p>
          <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
            {FIELD_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => add(type)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted disabled:opacity-50"
              >
                <Plus className="size-3.5 shrink-0 text-primary" />
                {FIELD_TYPE_LABEL[type]}
              </button>
            ))}
          </div>
        </div>

        {/* The form, in order */}
        <div className="min-w-0 rounded-xl border border-border bg-card p-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Fields ({schema.fields.length})</p>
          {schema.fields.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Nothing here yet. Add the first field from the list.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {schema.fields.map((f, i) => (
                <li
                  key={f.id}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-2',
                    selected === f.id ? 'border-primary bg-primary/5' : 'border-border',
                  )}
                >
                  <button type="button" onClick={() => setSelected(f.id)} className="min-w-0 flex-1 text-left">
                    <span className={cn('block truncate text-sm text-foreground', f.type === 'heading' ? 'font-semibold' : 'font-medium')}>
                      {f.label}
                      {f.required && <span className="text-red-400"> *</span>}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {FIELD_TYPE_LABEL[f.type]}
                      {collectsAnswer(f) ? ` · ${f.key}` : ''}
                    </span>
                  </button>
                  <IconButton label="Move up" onClick={() => move(f.id, -1)} disabled={i === 0}>
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton label="Move down" onClick={() => move(f.id, 1)} disabled={i === schema.fields.length - 1}>
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton label="Duplicate" onClick={() => duplicate(f)}>
                    <Copy className="size-3.5" />
                  </IconButton>
                  <IconButton label="Delete" onClick={() => remove(f.id)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Details of the selected field, then of the form */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Selected field</p>
            {!field ? (
              <p className="text-sm text-muted-foreground">Click a field to change it.</p>
            ) : (
              <div className="space-y-3">
                <Prop label="Label">
                  <input className={inputClass} value={field.label} maxLength={120} onChange={(e) => setField(field.id, { label: e.target.value })} />
                </Prop>
                <Prop label="Type">
                  <select
                    className={inputClass}
                    value={field.type}
                    onChange={(e) => {
                      const type = e.target.value as FieldType;
                      setField(field.id, {
                        type,
                        options: hasOptions(type) ? (field.options.length ? field.options : ['Option 1', 'Option 2']) : [],
                        required: type === 'heading' ? false : field.required,
                      });
                    }}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {FIELD_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </Prop>
                {collectsAnswer(field) && (
                  <>
                    <Prop label="Stored as" hint="The column name in the answers and the export. Small letters, digits and _.">
                      <input
                        className={cn(inputClass, 'font-mono')}
                        value={field.key}
                        maxLength={40}
                        onChange={(e) => setField(field.id, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                      />
                    </Prop>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={field.required}
                        onChange={(e) => setField(field.id, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    {hasOptions(field.type) ? (
                      <Prop label="Choices" hint="One per line.">
                        <textarea
                          rows={5}
                          className={cn(inputClass, 'h-auto py-2')}
                          value={field.options.join('\n')}
                          onChange={(e) => setField(field.id, { options: e.target.value.split('\n') })}
                          onBlur={() => setField(field.id, { options: [...new Set(field.options.map((o) => o.trim()).filter(Boolean))] })}
                        />
                      </Prop>
                    ) : (
                      <>
                        <Prop label="Placeholder">
                          <input className={inputClass} value={field.placeholder} maxLength={120} onChange={(e) => setField(field.id, { placeholder: e.target.value })} />
                        </Prop>
                        <Prop label="Default value">
                          <input className={inputClass} value={field.defaultValue} maxLength={300} onChange={(e) => setField(field.id, { defaultValue: e.target.value })} />
                        </Prop>
                      </>
                    )}
                    <Prop label="Width">
                      <select className={inputClass} value={field.width} onChange={(e) => setField(field.id, { width: e.target.value as FormField['width'] })}>
                        <option value="full">Full row</option>
                        <option value="half">Half (two side by side)</option>
                        <option value="third">Third (three side by side)</option>
                      </select>
                    </Prop>
                  </>
                )}
                <Prop label="Help text" hint="Shown small under the field.">
                  <input className={inputClass} value={field.help} maxLength={300} onChange={(e) => setField(field.id, { help: e.target.value })} />
                </Prop>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Form settings</p>
            <div className="space-y-3">
              <Prop label="Introduction" hint="Shown above the fields.">
                <textarea rows={3} className={cn(inputClass, 'h-auto py-2')} value={schema.description} maxLength={600} onChange={(e) => change({ ...schema, description: e.target.value })} />
              </Prop>
              <Prop label="Button text">
                <input className={inputClass} value={schema.submitLabel} maxLength={40} onChange={(e) => change({ ...schema, submitLabel: e.target.value })} />
              </Prop>
              <Prop label="Message after sending">
                <input className={inputClass} value={schema.successMessage} maxLength={300} onChange={(e) => change({ ...schema, successMessage: e.target.value })} />
              </Prop>
              <Prop label="Stages" hint="One per line. A new answer gets the first; you move it on in Answers.">
                <textarea
                  rows={3}
                  className={cn(inputClass, 'h-auto py-2')}
                  value={schema.stages.join('\n')}
                  onChange={(e) => change({ ...schema, stages: e.target.value.split('\n') })}
                  onBlur={() => change({ ...schema, stages: [...new Set(schema.stages.map((s) => s.trim()).filter(Boolean))] })}
                />
              </Prop>
            </div>
          </div>
        </div>
      </fieldset>

      {versions.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Published versions</p>
          <ul className="flex flex-col gap-1.5">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                <span className="font-medium">Version {v.version}</span>
                <span className="text-muted-foreground">{when(v.published_at)}</span>
                {!locked && (
                  <Button size="sm" variant="outline" className="ml-auto" disabled={!!busy} onClick={() => restore(v.version)}>
                    Load into design
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{name || 'Preview'}</DialogTitle>
            <DialogDescription>A preview of the design as it is now. Nothing you send here is saved.</DialogDescription>
          </DialogHeader>
          {preview && (
            <FormRenderer
              schema={cleanSchema(schema)}
              onSubmit={async (answers) => {
                try {
                  if (dirty && !locked) await api(`/forms/${form.id}`, { method: 'PATCH', body: { name, schema } }).then(() => setDirty(false));
                  await api(`/forms/${form.id}/submissions`, { method: 'POST', body: { data: answers, preview: true } });
                  toast.success('The answer passed every check. Nothing was saved.');
                } catch (err) {
                  if (err instanceof ApiError && err.errors) return err.errors;
                  say(err);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function Prop({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

// ------------------------------------------------------------
// Fill in (from the portal)
// ------------------------------------------------------------

function FillIn({ form, go }: { form: FormFull; go: Go }) {
  const [done, setDone] = useState<Submission | null>(null);
  const [round, setRound] = useState(0);
  if (form.status !== 'published' || !form.published_schema) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="mb-3 text-sm text-muted-foreground">Publish the form first. Until then, use Preview in the Design tab to try it.</p>
        <Button variant="outline" onClick={() => go({ form: form.id, view: 'design' })}>
          Open the design
        </Button>
      </div>
    );
  }
  const submit = async (answers: Answers) => {
    try {
      const { submission } = await api<{ submission: Submission }>(`/forms/${form.id}/submissions`, { method: 'POST', body: { data: answers } });
      setDone(submission);
    } catch (err) {
      if (err instanceof ApiError && err.errors) return err.errors;
      say(err);
      return {};
    }
  };
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-5">
      {done ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-base font-medium text-foreground">{form.published_schema.successMessage}</p>
          <p className="text-sm text-muted-foreground">
            Reference: <span className="font-mono font-semibold text-foreground">{done.ref}</span>
          </p>
          <div className="flex justify-center gap-2">
            <Button
              onClick={() => {
                setDone(null);
                setRound((r) => r + 1);
              }}
            >
              Fill in another
            </Button>
            <Button variant="outline" onClick={() => go({ form: form.id, view: 'answers' })}>
              See the answers
            </Button>
          </div>
        </div>
      ) : (
        <FormRenderer key={round} schema={form.published_schema} onSubmit={submit} />
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Answers
// ------------------------------------------------------------

function AnswersView({ form }: { form: FormFull }) {
  const schema = form.published_schema ?? form.schema;
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [editing, setEditing] = useState<Submission | null>(null);
  const load = useCallback(
    () =>
      api<{ submissions: Submission[]; total: number }>(`/forms/${form.id}/submissions`)
        .then((d) => {
          setRows(d.submissions);
          setTotal(d.total);
        })
        .catch(say),
    [form.id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Columns: the fields of the design, plus anything older answers hold.
  const columns = useMemo(() => {
    const cols = schema.fields.filter(collectsAnswer).map((f) => ({ key: f.key, label: f.label }));
    const known = new Set(cols.map((c) => c.key));
    for (const r of rows ?? []) {
      for (const key of Object.keys(r.data ?? {})) {
        if (!known.has(key)) {
          known.add(key);
          cols.push({ key, label: key });
        }
      }
    }
    return cols;
  }, [schema, rows]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (stage && r.stage !== stage) return false;
      if (!q) return true;
      return (
        r.ref.toLowerCase().includes(q) ||
        (r.stage ?? '').toLowerCase().includes(q) ||
        Object.values(r.data ?? {}).some((v) => answerText(v).toLowerCase().includes(q))
      );
    });
  }, [rows, search, stage]);

  const setRowStage = async (r: Submission, next: string) => {
    setRows((prev) => (prev ?? []).map((x) => (x.id === r.id ? { ...x, stage: next } : x)));
    await api(`/forms/${form.id}/submissions`, { method: 'PATCH', body: { id: r.id, stage: next } }).catch(async (err) => {
      say(err);
      await load();
    });
  };
  const remove = async (r: Submission) => {
    if (!confirm(`Delete answer ${r.ref}? This cannot be undone.`)) return;
    await api(`/forms/${form.id}/submissions?sid=${r.id}`, { method: 'DELETE' }).catch(say);
    await load();
  };
  const download = () => {
    const head = ['Reference', 'Received', 'Stage', 'Source', 'Version', ...columns.map((c) => c.label)];
    const lines = shown.map((r) =>
      [r.ref, r.created_at, r.stage ?? '', r.source === 'link' ? 'Public link' : 'Portal', String(r.version), ...columns.map((c) => answerText(r.data?.[c.key]))]
        .map(csvCell)
        .join(','),
    );
    // The mark at the start makes Excel read Hindi and other scripts correctly.
    const blob = new Blob(['﻿' + [head.map(csvCell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${form.name.replace(/[^\w-]+/g, '_') || 'form'}-answers.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!rows) return <Spinner />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={cn(inputClass, 'max-w-xs')} placeholder="Search the answers" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={cn(inputClass, 'w-auto')} value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {schema.stages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">
          {shown.length} of {total}
        </span>
        <Button variant="outline" className="ml-auto" onClick={download} disabled={shown.length === 0}>
          <Download className="size-4" /> Download CSV
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No answers yet. Share the link of the form, or fill it in yourself from the Fill in tab.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-max text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                {columns.map((c) => (
                  <th key={c.key} className="max-w-[220px] truncate px-3 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-foreground">{r.ref}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{when(r.created_at)}</td>
                  <td className="px-3 py-2">
                    <select
                      className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
                      value={r.stage ?? ''}
                      aria-label={`Stage of ${r.ref}`}
                      onChange={(e) => void setRowStage(r, e.target.value)}
                    >
                      {r.stage && !schema.stages.includes(r.stage) && <option value={r.stage}>{r.stage}</option>}
                      {!r.stage && <option value="">—</option>}
                      {schema.stages.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} className="max-w-[220px] truncate px-3 py-2 text-foreground" title={answerText(r.data?.[c.key])}>
                      {answerText(r.data?.[c.key])}
                    </td>
                  ))}
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.source === 'link' ? 'Public link' : 'Portal'}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <IconButton label={`Edit ${r.ref}`} onClick={() => setEditing(r)}>
                        <Pencil className="size-3.5" />
                      </IconButton>
                      <IconButton label={`Delete ${r.ref}`} onClick={() => void remove(r)}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit answer {editing?.ref}</DialogTitle>
            <DialogDescription>
              {editing ? `Received ${when(editing.created_at)}${editing.modified_by ? ` · last changed by ${editing.modified_by}` : ''}` : ''}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <FormRenderer
              key={editing.id}
              schema={schema}
              initial={editing.data}
              submitLabel="Save changes"
              onSubmit={async (answers) => {
                try {
                  await api(`/forms/${form.id}/submissions`, { method: 'PATCH', body: { id: editing.id, data: answers } });
                  toast.success('Answer saved');
                  setEditing(null);
                  await load();
                } catch (err) {
                  if (err instanceof ApiError && err.errors) return err.errors;
                  say(err);
                  return {};
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
