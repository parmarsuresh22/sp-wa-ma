import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WAKE_WORDS,
  cleanWakeMinutes,
  cleanWakeWords,
  messageWakes,
  wakeDecision,
  wakeWordsInForce,
} from './wake'

const now = new Date('2026-11-28T10:00:00Z')
const base = {
  wakeMode: true,
  words: DEFAULT_WAKE_WORDS,
  minutes: 30,
  awakeUntil: null as string | null,
  personal: false,
  now,
}

describe('messageWakes', () => {
  it('wakes on a wake word, whatever its ending or case', () => {
    expect(messageWakes('I need an Appointment tomorrow', DEFAULT_WAKE_WORDS)).toBe(true)
    expect(messageWakes('any appointments free?', DEFAULT_WAKE_WORDS)).toBe(true)
    expect(messageWakes('Booking for 2 please', DEFAULT_WAKE_WORDS)).toBe(true)
    expect(messageWakes('book me at 5', DEFAULT_WAKE_WORDS)).toBe(true)
    expect(messageWakes('कल का अपॉइंटमेंट चाहिए', DEFAULT_WAKE_WORDS)).toBe(true)
    expect(messageWakes('बुकिंग करनी है', DEFAULT_WAKE_WORDS)).toBe(true)
  })

  it('stays asleep on a personal message', () => {
    expect(messageWakes('Hi, where are you?', DEFAULT_WAKE_WORDS)).toBe(false)
    expect(messageWakes('saw it on facebook', DEFAULT_WAKE_WORDS)).toBe(false)
    expect(messageWakes('bring my notebook', DEFAULT_WAKE_WORDS)).toBe(false)
    expect(messageWakes('घर कब आओगे', DEFAULT_WAKE_WORDS)).toBe(false)
    expect(messageWakes('', DEFAULT_WAKE_WORDS)).toBe(false)
    expect(messageWakes(null, DEFAULT_WAKE_WORDS)).toBe(false)
  })

  it('uses the words the business chose, phrases included', () => {
    expect(messageWakes('doctor se milna hai', ['milna hai'])).toBe(true)
    expect(messageWakes('need an appointment', ['milna hai'])).toBe(false)
  })
})

describe('wakeDecision', () => {
  it('answers everything when the setting is off', () => {
    expect(wakeDecision({ ...base, wakeMode: false, text: 'hi' })).toEqual({ answer: true })
  })

  it('stays silent until a wake word arrives, then stays awake for the window', () => {
    expect(wakeDecision({ ...base, text: 'hi bro' })).toEqual({ answer: false })
    const woken = wakeDecision({ ...base, text: 'need an appointment' })
    expect(woken).toEqual({ answer: true, awakeUntil: '2026-11-28T10:30:00.000Z' })
    // The next message has no wake word but the chat is awake.
    const later = new Date('2026-11-28T10:20:00Z')
    expect(wakeDecision({ ...base, now: later, awakeUntil: woken.awakeUntil!, text: 'tomorrow 5 pm' })).toEqual({
      answer: true,
      awakeUntil: '2026-11-28T10:50:00.000Z',
    })
  })

  it('goes back to sleep after the window', () => {
    const later = new Date('2026-11-28T11:00:00Z')
    expect(wakeDecision({ ...base, now: later, awakeUntil: '2026-11-28T10:30:00.000Z', text: 'ok thanks' })).toEqual({
      answer: false,
    })
  })

  it('never answers a contact tagged Personal', () => {
    expect(wakeDecision({ ...base, personal: true, text: 'book an appointment' })).toEqual({ answer: false })
    expect(
      wakeDecision({ ...base, personal: true, awakeUntil: '2026-11-28T10:30:00.000Z', text: 'hello' }),
    ).toEqual({ answer: false })
  })
})

describe('settings input', () => {
  it('tidies the words and falls back to the suggested ones', () => {
    expect(cleanWakeWords(' Appointment, BOOK ,book,\n milna  hai , x ')).toEqual(['appointment', 'book', 'milna hai'])
    expect(cleanWakeWords(['Slot', 5, ''])).toEqual(['slot'])
    expect(wakeWordsInForce([])).toEqual(DEFAULT_WAKE_WORDS)
    expect(wakeWordsInForce(['Checkup'])).toEqual(['checkup'])
  })

  it('keeps the awake time within bounds', () => {
    expect(cleanWakeMinutes(45)).toBe(45)
    expect(cleanWakeMinutes('1')).toBe(5)
    expect(cleanWakeMinutes(99999)).toBe(1440)
    expect(cleanWakeMinutes(undefined)).toBe(30)
  })
})
