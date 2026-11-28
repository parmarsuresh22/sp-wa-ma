import { describe, expect, it } from 'vitest'

import {
  coerce,
  computeNextRun,
  evalCondition,
  executeButton,
  genUuid,
  parseDt,
  template,
  type EngineStore,
  type Json,
} from './engine'
import { buildTableFile, parseCsv, parseTableFile } from './services'

const now = new Date('2026-11-28T10:00:00Z')

function node(id: number, name: string, data: Json, next: number | number[] | null) {
  const targets = next === null ? [] : Array.isArray(next) ? next : [next]
  const outputs: Json = {}
  targets.forEach((t, i) => {
    outputs[`output_${i + 1}`] = { connections: t ? [{ node: String(t), output: 'input_1' }] : [] }
  })
  if (targets.length === 0) outputs.output_1 = { connections: [] }
  return {
    id,
    name,
    data,
    inputs: name === 'button_start' ? {} : { input_1: { connections: [{ node: String(id - 1), input: 'output_1' }] } },
    outputs,
  }
}
const graph = (...nodes: ReturnType<typeof node>[]) => ({ drawflow: { Home: { data: Object.fromEntries(nodes.map((n) => [String(n.id), n])) } } })

/** A store that keeps everything in memory. */
function memoryStore() {
  const subs = new Map<number, { uuid: string; data: Json; stage: string; status: string; traces: Json[] }>()
  const emails: Json[] = []
  let nextIdNo = 1
  const store: EngineStore = {
    async hasDuplicate(key, value, currentId) {
      return [...subs.entries()].some(([id, s]) => id !== currentId && String(s.data[key] ?? '').trim() === value)
    },
    async saveSubmission(id, patch) {
      if (id === null) {
        const newId = nextIdNo++
        subs.set(newId, { uuid: patch.uuid ?? genUuid(), data: patch.data, stage: patch.stage, status: patch.status ?? 'submitted', traces: [] })
        return { id: newId, uuid: subs.get(newId)!.uuid }
      }
      const s = subs.get(id)!
      s.data = patch.data
      if (patch.status !== undefined || patch.stage) s.stage = patch.stage
      if (patch.status !== undefined) s.status = patch.status
      return { id, uuid: s.uuid }
    },
    async sendEmail(mail) {
      emails.push({ ...mail })
      return { row: { ...mail, id: emails.length }, sent: false, detail: 'simulated (no email account configured in Settings)' }
    },
    async httpCall(cfg) {
      return { method: 'GET', url: String(cfg.url), status: 200, error: null, text: '{"ok":true}', json: { ok: true } }
    },
    async saveTrace(id, entry) {
      subs.get(id)!.traces.unshift(entry)
    },
  }
  return { store, subs, emails }
}

const schema: Json = {
  elements: [
    { id: 'c1', type: 'text', key: 'name', label: 'Name', required: true, rules: {} },
    { id: 'c2', type: 'email', key: 'email', label: 'Email', required: true, rules: {} },
    {
      id: 'sec1',
      type: 'section',
      label: 'Manager Only',
      rules: { visibleRoles: ['Manager'] },
      children: [{ id: 'c4', type: 'text', key: 'note', label: 'Manager Note', required: true, rules: {} }],
    },
    { id: 'btn', type: 'button', key: 'submit', label: 'Submit', rules: {} },
  ],
  emails: [{ id: 'em1', name: 'Confirm', sender: 'hr@acme.com', recipient: '{{email}}', subject: 'Leave for {{name}}', body: 'Hi {{name}}, ref {{uuid}}.' }],
}
const workflow: Json = {
  submit: graph(
    node(1, 'button_start', { label: 'Submit' }, 2),
    node(2, 'validate', {}, 3),
    node(3, 'set_stage', { stage: 'In Review' }, 4),
    node(4, 'save', {}, 5),
    node(5, 'send_email', { emailId: 'em1' }, 6),
    node(6, 'dialog', { header: 'Thanks {{name}}', body: 'Saved.', showDismiss: 'yes' }, null),
  ),
}

describe('template', () => {
  it('fills fields and the built-in tokens', () => {
    expect(template('Hi {{ name }}, {{missing}}!', { name: 'Asha' }, now)).toBe('Hi Asha, !')
    expect(template('{{_date}} {{_uuid}}', { uuid: 'ABC' }, now)).toBe('2026-11-28 ABC')
    expect(template('', {})).toBe('')
  })
})

describe('conditions', () => {
  it('compares by data type', () => {
    expect(evalCondition('n', '>', '9', { n: '10' }, 'number')).toBe(true)
    expect(evalCondition('n', '>', '9', { n: '10' }, 'string')).toBe(false)
    expect(evalCondition('d', '<', '2026-12-01', { d: '28/11/2026' }, 'date')).toBe(true)
    expect(evalCondition('e', '==', 'A@X.com ', { e: 'a@x.com' }, 'email')).toBe(true)
    expect(evalCondition('b', '==', 'yes', { b: true }, 'boolean')).toBe(true)
    expect(evalCondition('s', 'contains', 'URG', { s: 'very urgent' })).toBe(true)
    expect(evalCondition('s', 'empty', '', { s: '  ' })).toBe(true)
    expect(evalCondition('s', 'notempty', '', {})).toBe(false)
    expect(evalCondition('n', '>', 'x', { n: '10' }, 'number')).toBe(false)
    expect(evalCondition('n', '!=', '10.0', { n: '10' }, 'number')).toBe(false)
  })

  it('reads the date formats of the original, and refuses impossible dates', () => {
    expect(parseDt('2026-11-28')).toBe(Date.UTC(2026, 10, 28))
    expect(parseDt('2026-11-28T09:30')).toBe(Date.UTC(2026, 10, 28, 9, 30))
    expect(parseDt('28/11/2026')).toBe(Date.UTC(2026, 10, 28))
    expect(parseDt('2026-02-31')).toBeNull()
    expect(parseDt('soon')).toBeNull()
    expect(coerce('', 'number')).toBeNull()
  })
})

describe('executeButton', () => {
  it('stops at validation, counting only the fields the role can see', async () => {
    const { store, subs } = memoryStore()
    const r = await executeButton(store, { schema, workflow, buttonKey: 'submit', data: { name: 'Asha' }, role: 'Staff', stage: 'Draft', now })
    expect(r.errors).toEqual(["'Email' is required."])
    expect(r.stopped).toBe(true)
    expect(subs.size).toBe(0)
    // The manager sees the section, so its required note counts too.
    const m = await executeButton(store, { schema, workflow, buttonKey: 'submit', data: { name: 'A', email: 'a@x.com' }, role: 'Manager', stage: 'Draft', now })
    expect(m.errors).toEqual(["'Manager Note' is required."])
  })

  it('runs validate → stage → save → email → dialog and keeps the trace', async () => {
    const { store, subs, emails } = memoryStore()
    const r = await executeButton(store, {
      schema,
      workflow,
      buttonKey: 'submit',
      data: { name: 'Asha', email: 'asha@example.com' },
      role: 'Staff',
      stage: 'Draft',
      now,
    })
    expect(r.errors).toEqual([])
    expect(r.stage).toBe('In Review')
    expect(r.saved_submission_id).toBe(1)
    const saved = subs.get(1)!
    expect(saved.stage).toBe('In Review')
    expect(saved.uuid).toHaveLength(40)
    expect(saved.data.uuid).toBe(saved.uuid)
    expect(emails[0]).toMatchObject({ recipient: 'asha@example.com', subject: 'Leave for Asha', body: `Hi Asha, ref ${saved.uuid}.` })
    expect(r.dialogs[0]).toMatchObject({ header: 'Thanks Asha' })
    expect(saved.traces).toHaveLength(1)
    expect(saved.traces[0]).toMatchObject({ button: 'submit', ok: true, stage: 'In Review' })
    expect(r.log[0]).toBe('▶ Button clicked: Submit')
  })

  it('saves nothing and sends nothing in a preview', async () => {
    const { store, subs, emails } = memoryStore()
    const r = await executeButton(store, { schema, workflow, buttonKey: 'submit', data: { name: 'A', email: 'a@x.com' }, role: 'Staff', stage: '', preview: true, now })
    expect(subs.size).toBe(0)
    expect(emails).toHaveLength(0)
    expect(String(r.data.uuid)).toMatch(/^PREVIEW-/)
    expect(r.emails[0]).toMatchObject({ delivery: 'preview (not sent)' })
  })

  it('refuses a second answer on a single-submission form', async () => {
    const { store, subs } = memoryStore()
    const single = { ...schema, submission: { mode: 'single', key: 'email' } }
    const run = () => executeButton(store, { schema: single, workflow, buttonKey: 'submit', data: { name: 'A', email: 'a@x.com' }, role: 'Staff', stage: '', now })
    expect((await run()).errors).toEqual([])
    const second = await run()
    expect(second.errors[0]).toContain('single submission per Email')
    expect(subs.size).toBe(1)
  })

  it('branches on If and Switch', async () => {
    const { store } = memoryStore()
    const wf: Json = {
      go: graph(
        node(1, 'button_start', { label: 'Go' }, 2),
        node(2, 'if', { field: 'amount', op: '>', value: '100', dtype: 'number' }, [3, 4]),
        node(3, 'set_value', { key: 'tier', value: 'big {{amount}}' }, null),
        node(4, 'set_value', { key: 'tier', value: 'small' }, null),
      ),
    }
    const big = await executeButton(store, { schema, workflow: wf, buttonKey: 'go', data: { amount: '250' }, role: '', stage: '', now })
    expect(big.data.tier).toBe('big 250')
    const small = await executeButton(store, { schema, workflow: wf, buttonKey: 'go', data: { amount: '20' }, role: '', stage: '', now })
    expect(small.data.tier).toBe('small')
  })

  it('says so when a button has no workflow', async () => {
    const { store } = memoryStore()
    const r = await executeButton(store, { schema, workflow: {}, buttonKey: 'nope', data: {}, role: '', stage: '', now })
    expect(r.log).toEqual(["No workflow defined for button 'nope'. Nothing to do."])
  })
})

describe('computeNextRun', () => {
  const base = { minute: 30, hour: 9, weekday: 0, day: 31, timezone: 'Asia/Kolkata' }
  // 2026-11-28 10:00 UTC is Saturday 15:30 in India.
  it('books the next hourly, daily, weekly and monthly run in the task time zone', () => {
    expect(computeNextRun({ ...base, schedule: 'hourly' }, now)?.toISOString()).toBe('2026-11-28T11:00:00.000Z')
    expect(computeNextRun({ ...base, schedule: 'daily' }, now)?.toISOString()).toBe('2026-11-29T04:00:00.000Z')
    expect(computeNextRun({ ...base, schedule: 'weekly' }, now)?.toISOString()).toBe('2026-11-30T04:00:00.000Z')
    // Day 31 in a 30-day month is the last day; that has passed, so December 31.
    expect(computeNextRun({ ...base, schedule: 'monthly' }, new Date('2026-11-30T10:00:00Z'))?.toISOString()).toBe('2026-12-31T04:00:00.000Z')
    expect(computeNextRun({ ...base, schedule: 'never' }, now)).toBeNull()
  })
})

describe('tables', () => {
  it('writes CSV as the original does and reads it back', () => {
    const { content, ext } = buildTableFile(['Name', 'Note'], [['Asha, V', 'said "hi"'], ['Ravi', 'line1\nline2']], 'csv', 'S')
    expect(ext).toBe('csv')
    const text = content.toString('utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(parseCsv(text.slice(1))).toEqual([
      ['Name', 'Note'],
      ['Asha, V', 'said "hi"'],
      ['Ravi', 'line1\nline2'],
    ])
  })

  it('reads an uploaded lookup file, CSV or Excel', () => {
    const csv = parseTableFile('staff.csv', Buffer.from('﻿code,name\r\nE1,Asha\r\nE2,Ravi\r\n'))
    expect(csv.headers).toEqual(['code', 'name'])
    expect(csv.rows).toEqual([{ code: 'E1', name: 'Asha' }, { code: 'E2', name: 'Ravi' }])
    const xlsx = buildTableFile(['code', 'qty'], [['E1', 5]], 'xlsx', 'S')
    const back = parseTableFile('staff.xlsx', xlsx.content)
    expect(back.headers).toEqual(['code', 'qty'])
    expect(back.rows).toEqual([{ code: 'E1', qty: 5 }])
  })
})
