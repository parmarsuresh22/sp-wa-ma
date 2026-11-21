import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ findOrCreateConversationRow: vi.fn() }))
vi.mock('@/lib/whatsapp/channels', () => ({ loadChannel: vi.fn() }))
vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: vi.fn() }))

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  appointmentMessageText,
  localizeAppointmentText,
  numbersIn,
  settingsFromRow,
  translationPrompt,
} from './service'

const settings = (language: string) =>
  settingsFromRow(
    { id: 's', business_name: 'Parmar Clinic', address: '12 MG Road, Jaipur 302001', reply_language: language },
    'acct',
    'chan',
  )
const appt = { starts_at: '2026-11-23T04:30:00.000Z', customer_name: 'Suresh' }
const english = appointmentMessageText('cancelled', appt, settings('hindi'))

/** A db whose only table is the customer's recent messages. */
function dbWithCustomerMessages(texts: string[]): SupabaseClient {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order']) chain[m] = () => chain
  chain.limit = async () => ({ data: texts.map((content_text) => ({ content_text })) })
  return { from: () => chain } as unknown as SupabaseClient
}

beforeEach(() => {
  h.loadAiConfig.mockReset().mockResolvedValue({ provider: 'gemini', model: 'm', apiKey: 'k' })
  h.generateReply.mockReset()
})

describe('localizeAppointmentText', () => {
  it('sends the message in the language chosen in the settings', async () => {
    const hindi = 'नमस्ते Suresh, Parmar Clinic में Monday, 23 November 2026 को 10:00 am का आपका अपॉइंटमेंट रद्द कर दिया गया है।'
    h.generateReply.mockResolvedValue({ text: hindi })
    const out = await localizeAppointmentText(dbWithCustomerMessages([]), 'acct', 'conv', settings('hindi'), english)
    expect(out).toBe(hindi)
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain('Translate it into Hindi')
    expect(h.generateReply.mock.calls[0][0].messages).toEqual([{ role: 'user', content: english }])
  })

  it('leaves English alone without spending a call', async () => {
    expect(await localizeAppointmentText(dbWithCustomerMessages([]), 'a', 'c', settings('english'), english)).toBe(english)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('on Auto, follows the language the customer has been writing in', async () => {
    h.generateReply.mockResolvedValue({ text: 'Namaste Suresh, aapka 23 November 2026 ko 10:00 am ka appointment cancel ho gaya hai.' })
    const out = await localizeAppointmentText(
      dbWithCustomerMessages(['Muje 23 tarik ka krna h']),
      'a',
      'c',
      settings('auto'),
      english,
    )
    expect(out).toContain('cancel ho gaya')
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain('Muje 23 tarik ka krna h')
  })

  it('on Auto with nothing written by the customer yet, stays in English', async () => {
    expect(await localizeAppointmentText(dbWithCustomerMessages([]), 'a', 'c', settings('auto'), english)).toBe(english)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('falls back to English when the translation lost or changed a number', async () => {
    // The time became 11:00: never send that.
    h.generateReply.mockResolvedValue({ text: 'नमस्ते Suresh, 23 November 2026 को 11:00 am का अपॉइंटमेंट रद्द।' })
    expect(await localizeAppointmentText(dbWithCustomerMessages([]), 'a', 'c', settings('hindi'), english)).toBe(english)
  })

  it('falls back to English when there is no key, or the provider fails', async () => {
    h.loadAiConfig.mockResolvedValueOnce(null)
    expect(await localizeAppointmentText(dbWithCustomerMessages([]), 'a', 'c', settings('tamil'), english)).toBe(english)
    h.generateReply.mockRejectedValue(new Error('provider down'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await localizeAppointmentText(dbWithCustomerMessages([]), 'a', 'c', settings('tamil'), english)).toBe(english)
    quiet.mockRestore()
  })
})

describe('helpers', () => {
  it('finds every number in a message', () => {
    expect(numbersIn('Date: Monday, 23 November 2026\nTime: 10:00 am\n302001')).toEqual(['23', '2026', '10', '00', '302001'])
  })
  it('names the target language, or shows the customer sample on Auto', () => {
    expect(translationPrompt('Gujarati', '')).toContain('Translate it into Gujarati')
    expect(translationPrompt(null, 'kem cho')).toContain('kem cho')
  })
})
