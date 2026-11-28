// ============================================================
// AEDA Forms (migration 089): what a form is made of, and the rules
// an answer is checked against.
//
// Pure — used by the designer and the fill page in the browser and by
// the server, which checks every answer again whatever the browser
// sent.
// ============================================================

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'email',
  'phone',
  'dropdown',
  'radio',
  'checkbox',
  'heading',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  number: 'Number',
  date: 'Date',
  email: 'Email',
  phone: 'Phone',
  dropdown: 'Dropdown',
  radio: 'Choose one',
  checkbox: 'Tick boxes',
  heading: 'Section heading',
}

export const FIELD_WIDTHS = ['full', 'half', 'third'] as const
export type FieldWidth = (typeof FIELD_WIDTHS)[number]

export interface FormField {
  id: string
  type: FieldType
  /** The name the answer is stored under; unique in the form. */
  key: string
  label: string
  placeholder: string
  help: string
  required: boolean
  /** Choices of a dropdown, "choose one" or tick boxes. */
  options: string[]
  width: FieldWidth
  defaultValue: string
}

export interface FormSchema {
  fields: FormField[]
  /** Stages an answer moves through; the first is given to a new answer. */
  stages: string[]
  submitLabel: string
  successMessage: string
  description: string
}

export const MAX_FIELDS = 80
export const MAX_OPTIONS = 60

const CHOICE_TYPES: readonly FieldType[] = ['dropdown', 'radio', 'checkbox']
export const hasOptions = (type: FieldType): boolean => CHOICE_TYPES.includes(type)
/** A field that collects an answer (a heading does not). */
export const collectsAnswer = (field: Pick<FormField, 'type'>): boolean => field.type !== 'heading'

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** A label turned into a storage name: "First Name" → "first_name". */
export function keyFromLabel(label: string): string {
  const key = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return /^[a-z]/.test(key) ? key : key ? `f_${key}` : 'field'
}

export function emptySchema(): FormSchema {
  return {
    fields: [],
    stages: ['New'],
    submitLabel: 'Submit',
    successMessage: 'Thank you. Your answer has been saved.',
    description: '',
  }
}

/**
 * Tidy a design coming from the browser or the database: unknown types
 * dropped, texts trimmed, every key made unique. Never throws.
 */
export function cleanSchema(raw: unknown): FormSchema {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base = emptySchema()
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  const fields: FormField[] = []
  for (const item of Array.isArray(r.fields) ? r.fields.slice(0, MAX_FIELDS) : []) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const type = FIELD_TYPES.find((t) => t === f.type)
    if (!type) continue
    const label = text(f.label, 120) || FIELD_TYPE_LABEL[type]
    let key = keyFromLabel(text(f.key, 40) || label)
    for (let n = 2; seenKeys.has(key); n++) key = `${keyFromLabel(text(f.key, 36) || label).slice(0, 36)}_${n}`
    seenKeys.add(key)
    let id = text(f.id, 40) || `f${fields.length + 1}`
    for (let n = 2; seenIds.has(id); n++) id = `${id}_${n}`
    seenIds.add(id)
    const options = hasOptions(type)
      ? [...new Set((Array.isArray(f.options) ? f.options : []).map((o) => text(o, 100)).filter(Boolean))].slice(0, MAX_OPTIONS)
      : []
    fields.push({
      id,
      type,
      key,
      label,
      placeholder: text(f.placeholder, 120),
      help: text(f.help, 300),
      required: type !== 'heading' && f.required === true,
      options,
      width: FIELD_WIDTHS.find((w) => w === f.width) ?? 'full',
      defaultValue: text(f.defaultValue, 300),
    })
  }
  const stages = [...new Set((Array.isArray(r.stages) ? r.stages : []).map((s) => text(s, 40)).filter(Boolean))].slice(0, 20)
  return {
    fields,
    stages: stages.length > 0 ? stages : base.stages,
    submitLabel: text(r.submitLabel, 40) || base.submitLabel,
    successMessage: text(r.successMessage, 300) || base.successMessage,
    description: text(r.description, 600),
  }
}

/** Why a design cannot be published; empty when it can. */
export function publishProblems(schema: FormSchema): string[] {
  const problems: string[] = []
  if (!schema.fields.some(collectsAnswer)) problems.push('Add at least one field that collects an answer.')
  for (const f of schema.fields) {
    if (hasOptions(f.type) && f.options.length === 0) problems.push(`"${f.label}" needs at least one choice.`)
  }
  return problems
}

export type AnswerValue = string | string[]
export type Answers = Record<string, AnswerValue>

export interface Checked {
  ok: boolean
  /** The answers as they are stored: known fields only, tidied. */
  values: Answers
  /** Problems by field key. */
  errors: Record<string, string>
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Check answers against a design. Fields not in the design are dropped. */
export function checkAnswers(schema: FormSchema, raw: unknown): Checked {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const values: Answers = {}
  const errors: Record<string, string> = {}
  for (const f of schema.fields) {
    if (!collectsAnswer(f)) continue
    const given = input[f.key]
    if (f.type === 'checkbox') {
      const picked = (Array.isArray(given) ? given : typeof given === 'string' && given ? [given] : [])
        .filter((v): v is string => typeof v === 'string')
        .filter((v) => f.options.includes(v))
      values[f.key] = [...new Set(picked)]
      if (f.required && picked.length === 0) errors[f.key] = 'Choose at least one.'
      continue
    }
    const value = typeof given === 'number' ? String(given) : text(given, f.type === 'textarea' ? 5000 : 500)
    values[f.key] = value
    if (!value) {
      if (f.required) errors[f.key] = 'This is required.'
      continue
    }
    if (f.type === 'number' && !Number.isFinite(Number(value))) errors[f.key] = 'Enter a number.'
    else if (f.type === 'email' && !EMAIL.test(value)) errors[f.key] = 'Enter a valid email address.'
    else if (f.type === 'phone' && !/^\+?[\d\s()-]{6,20}$/.test(value)) errors[f.key] = 'Enter a valid phone number.'
    else if (f.type === 'date' && (!DATE.test(value) || Number.isNaN(Date.parse(value)))) errors[f.key] = 'Enter a valid date.'
    else if ((f.type === 'dropdown' || f.type === 'radio') && !f.options.includes(value)) errors[f.key] = 'Choose one of the options.'
  }
  return { ok: Object.keys(errors).length === 0, values, errors }
}

/** An answer as text, for a table cell or a CSV file. */
export function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

/** One CSV cell, quoted when needed; a leading = + - @ is defused. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
