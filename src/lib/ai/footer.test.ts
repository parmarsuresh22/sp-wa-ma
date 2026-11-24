import { describe, expect, it } from 'vitest'
import { aiFooter, stripAiFooter, withAiFooter } from './footer'

describe('the AI footer', () => {
  it('is italic and carries no business name', () => {
    expect(aiFooter()).toBe('_AI Powered_')
  })
  it('goes under the reply, once', () => {
    expect(withAiFooter('Haan, 3 baje available hai.', aiFooter())).toBe(
      'Haan, 3 baje available hai.\n\n_AI Powered_',
    )
    // A reply that already ends with a footer, also the older one with
    // a business name, is not given a second one.
    expect(withAiFooter('Namaste\n\n_AI Powered_', aiFooter())).toBe('Namaste\n\n_AI Powered_')
    expect(withAiFooter('Namaste\n\n_AI Powered - Parmar Clinic_', aiFooter())).toBe('Namaste\n\n_AI Powered_')
  })
  it('is removed before the model sees an earlier reply, in the new and the old wording', () => {
    expect(stripAiFooter('Aapka appointment book ho gaya.\n\n_AI Powered - Parmar Clinic_')).toBe(
      'Aapka appointment book ho gaya.',
    )
    expect(stripAiFooter('Hello\n\n_AI Powered_')).toBe('Hello')
    expect(stripAiFooter('Hello\n\nAI Assistant - Parmar Clinic')).toBe('Hello')
    expect(stripAiFooter('Hello\n\nAI Assistant')).toBe('Hello')
    // Text that merely mentions the words is left alone.
    expect(stripAiFooter('This clinic is AI Powered and open today.')).toBe('This clinic is AI Powered and open today.')
    expect(stripAiFooter('No footer here')).toBe('No footer here')
  })
})
