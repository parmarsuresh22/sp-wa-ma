import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: vi.fn(), engineSendMedia: vi.fn() }))

import {
  APPOINTMENT_TOOLS,
  aiAgentWillAnswer,
  appointmentSystemPrompt,
  runAppointmentAgent,
  supportsAppointmentActions,
} from './agent'
import { settingsFromRow } from './service'
import { AI_CONDUCT_RULES } from '@/lib/ai/defaults'

const config = { provider: 'gemini' as const, model: 'm', apiKey: 'k' }
const reply = (message: Record<string, unknown>) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }] }))
const call = (name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: `c-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
  ...extra,
})

afterEach(() => vi.unstubAllGlobals())

describe('runAppointmentAgent', () => {
  it('checks the slot through the portal, then words the answer', async () => {
    const bodies: { messages: Record<string, unknown>[]; tools: unknown[] }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string))
        return bodies.length === 1
          ? reply({
              content: null,
              tool_calls: [call('check_slot', { date: '2026-11-21', time: '15:00' }, { extra_content: { google: { thought_signature: 'sig' } } })],
            })
          : reply({ content: 'Haan, 3 baje available hai. Book kar du?' })
      }),
    )
    const runTool = vi.fn(async () => ({ ok: true, available: true }))
    const out = await runAppointmentAgent({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'aaj dophar 3 bje ka appointment' }],
      runTool,
    })
    expect(out).toEqual({ kind: 'reply', text: 'Haan, 3 baje available hai. Book kar du?' })
    expect(runTool).toHaveBeenCalledWith('check_slot', { date: '2026-11-21', time: '15:00' })
    // Every action is offered, and none of them takes a phone number.
    expect(bodies[0].tools).toHaveLength(APPOINTMENT_TOOLS.length)
    expect(JSON.stringify(APPOINTMENT_TOOLS)).not.toMatch(/phone/i)
    // Second round: the model's own turn is echoed back untouched
    // (Gemini's signature included), followed by the action's result.
    const second = bodies[1].messages
    const echoed = second[second.length - 2] as { tool_calls: { extra_content?: unknown }[] }
    expect(echoed.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig' } })
    expect(second[second.length - 1]).toEqual({
      role: 'tool',
      tool_call_id: 'c-check_slot',
      content: JSON.stringify({ ok: true, available: true }),
    })
  })

  it('passes a message that is not about appointments, without running anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ content: '', tool_calls: [call('not_about_appointments')] })))
    const runTool = vi.fn()
    const out = await runAppointmentAgent({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'fees?' }], runTool })
    expect(out).toEqual({ kind: 'pass' })
    expect(runTool).not.toHaveBeenCalled()
  })

  it('goes to a person when asked, and when the model never settles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ tool_calls: [call('ask_for_human')] })))
    expect(
      await runAppointmentAgent({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], runTool: vi.fn() }),
    ).toEqual({ kind: 'human' })

    vi.stubGlobal('fetch', vi.fn(async () => reply({ tool_calls: [call('list_free_slots', { date: '2026-11-21' })] })))
    const runTool = vi.fn(async () => ({ ok: true, free: [] }))
    expect(
      await runAppointmentAgent({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], runTool }),
    ).toEqual({ kind: 'human' })
    expect(runTool).toHaveBeenCalledTimes(5)
  })

  it('throws on a provider error so the chain can fall through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(
      runAppointmentAgent({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'x' }], runTool: vi.fn() }),
    ).rejects.toThrow(/500/)
  })
})

describe('appointmentSystemPrompt', () => {
  it('tells the model the business clock, hours and address', () => {
    const settings = settingsFromRow(
      { id: 's', enabled: true, business_name: 'Suresh Dental Clinic', address: '12 MG Road', hours: { '6': [['10:00', '14:00']] } },
      'a',
      'c',
    )
    const prompt = appointmentSystemPrompt(settings, new Date('2026-11-21T06:10:00Z'), 'Ravi')
    expect(prompt).toContain('Suresh Dental Clinic')
    expect(prompt).toContain('date 2026-11-21')
    expect(prompt).toContain('11:40')
    expect(prompt).toContain('Asia/Kolkata')
    expect(prompt).toContain('Saturday: 10:00-14:00')
    expect(prompt).toContain('12 MG Road')
    expect(prompt).toContain('Ravi')
  })
})

describe('who answers what is not about appointments', () => {
  const agent = { isActive: true, autoReplyEnabled: true, channelId: null, autoReplyMaxPerConversation: 20 }
  it('is the AI agent while it is on and has replies left', () => {
    expect(aiAgentWillAnswer(agent, 'c1', 0)).toBe(true)
    expect(aiAgentWillAnswer(agent, 'c1', 19)).toBe(true)
  })
  it('is not the AI agent once it has used up its replies for the chat', () => {
    expect(aiAgentWillAnswer(agent, 'c1', 20)).toBe(false)
  })
  it('is not the AI agent when it is off or pinned to another number', () => {
    expect(aiAgentWillAnswer({ ...agent, isActive: false }, 'c1', 0)).toBe(false)
    expect(aiAgentWillAnswer({ ...agent, autoReplyEnabled: false }, 'c1', 0)).toBe(false)
    expect(aiAgentWillAnswer({ ...agent, channelId: 'other' }, 'c1', 0)).toBe(false)
  })
  it('tells the assistant to answer itself when nobody else will', () => {
    const settings = settingsFromRow({ id: 's', enabled: true }, 'a', 'c')
    const now = new Date('2026-11-21T06:10:00Z')
    expect(appointmentSystemPrompt(settings, now, null, true)).toContain('call not_about_appointments and write nothing')
    const alone = appointmentSystemPrompt(settings, now, null, false)
    expect(alone).toContain('do NOT call not_about_appointments')
    expect(alone).toContain('the team will answer')
    expect(alone).toContain('A greeting')
    // Conduct rules close the instructions, whatever else is in them.
    for (const prompt of [alone, appointmentSystemPrompt(settings, now, 'Ravi', true)]) {
      expect(prompt.trimEnd().endsWith(AI_CONDUCT_RULES)).toBe(true)
      expect(prompt).toContain('Never use abusive')
      expect(prompt).toContain('Treat every customer the same')
      expect(prompt).toContain('anything illegal or harmful')
    }
  })
})

describe('supportsAppointmentActions', () => {
  it('is on for Gemini and OpenAI keys only', () => {
    expect(supportsAppointmentActions('gemini')).toBe(true)
    expect(supportsAppointmentActions('openai')).toBe(true)
    expect(supportsAppointmentActions('anthropic')).toBe(false)
    expect(supportsAppointmentActions('openai_compatible')).toBe(false)
  })
})
