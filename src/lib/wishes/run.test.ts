import { describe, expect, it } from 'vitest'

import {
  parseWishTemplateParams,
  renderWishTemplateParams,
  selectDueWishes,
  type ContactWishRow,
} from './run'

const TZ = 'Asia/Kolkata'

function wish(over: Partial<ContactWishRow>): ContactWishRow {
  return {
    id: 'w1',
    account_id: 'a1',
    contact_id: 'c1',
    channel_id: 'ch1',
    enabled: true,
    month: 11,
    day: 18,
    message_text: 'Happy birthday {{name}}',
    template_name: null,
    template_language: null,
    template_params: [],
    last_sent_year: null,
    last_sent_at: null,
    last_error: null,
    ...over,
  }
}

// 18 Nov 2026 10:00 IST
const NOW = new Date('2026-11-18T04:30:00Z')

describe('selectDueWishes', () => {
  it("includes today's wish when the previous run was earlier today", () => {
    const lastRun = new Date('2026-11-18T03:30:00Z') // 09:00 IST today
    expect(selectDueWishes([wish({})], lastRun, NOW, TZ)).toHaveLength(1)
  })

  it('does not reach back to yesterday when the previous run was today', () => {
    const lastRun = new Date('2026-11-18T03:30:00Z')
    expect(selectDueWishes([wish({ day: 17 })], lastRun, NOW, TZ)).toHaveLength(0)
  })

  it('catches dates between runs and skips ones already sent this year', () => {
    const lastRun = new Date('2026-11-14T03:30:00Z')
    const due = selectDueWishes(
      [
        wish({ id: 'mid', day: 16 }),
        wish({ id: 'sent', day: 17, last_sent_year: 2026 }),
        wish({ id: 'last-year', day: 18, last_sent_year: 2025 }),
        wish({ id: 'future', day: 19 }),
        wish({ id: 'off', day: 16, enabled: false }),
      ],
      lastRun,
      NOW,
      TZ,
    )
    expect(due.map((d) => d.wish.id).sort()).toEqual(['last-year', 'mid'])
    expect(due.every((d) => d.year === 2026)).toBe(true)
  })

  it('looks back at most a week on a first run', () => {
    const due = selectDueWishes(
      [wish({ id: 'old', day: 5 }), wish({ id: 'recent', day: 13 })],
      null,
      NOW,
      TZ,
    )
    expect(due.map((d) => d.wish.id)).toEqual(['recent'])
  })

  it('puts wishes that failed before behind the others', () => {
    const due = selectDueWishes(
      [wish({ id: 'failed', last_error: 'boom' }), wish({ id: 'fresh' })],
      null,
      NOW,
      TZ,
    )
    expect(due.map((d) => d.wish.id)).toEqual(['fresh', 'failed'])
  })
})

describe('wish template params', () => {
  it('reads both stored shapes', () => {
    expect(parseWishTemplateParams(['a', 'b'])).toEqual({ body: ['a', 'b'] })
    expect(
      parseWishTemplateParams({ body: ['a'], headerText: 'Hi', buttonParams: { '0': 'x', bad: 'y' } }),
    ).toEqual({ body: ['a'], headerText: 'Hi', buttonParams: { 0: 'x' } })
    expect(parseWishTemplateParams(null)).toEqual({ body: [] })
  })

  it('fills {{name}} per contact', () => {
    expect(
      renderWishTemplateParams({ body: ['{{name}}', 'fixed'], headerText: 'Dear {{ name }}' }, 'Asha'),
    ).toEqual({ body: ['Asha', 'fixed'], headerText: 'Dear Asha' })
  })
})
