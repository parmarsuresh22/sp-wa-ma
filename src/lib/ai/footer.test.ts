import { describe, expect, it } from 'vitest'
import { aiFooter, stripAiFooter, withAiFooter } from './footer'

describe('the AI footer', () => {
  it('is plain without a business name, and names the business with one', () => {
    expect(aiFooter()).toBe('AI Assistant')
    expect(aiFooter('  ')).toBe('AI Assistant')
    expect(aiFooter('Parmar Clinic')).toBe('AI Assistant - Parmar Clinic')
  })
  it('goes under the reply, once', () => {
    expect(withAiFooter('Haan, 3 baje available hai.', 'AI Assistant - Parmar Clinic')).toBe(
      'Haan, 3 baje available hai.\n\nAI Assistant - Parmar Clinic',
    )
    // A reply that already ends with a footer is not given a second one.
    expect(withAiFooter('Namaste\n\nAI Assistant', 'AI Assistant - Parmar Clinic')).toBe(
      'Namaste\n\nAI Assistant - Parmar Clinic',
    )
  })
  it('is removed before the model sees an earlier reply', () => {
    expect(stripAiFooter('Aapka appointment book ho gaya.\n\nAI Assistant - Parmar Clinic')).toBe(
      'Aapka appointment book ho gaya.',
    )
    expect(stripAiFooter('Hello\n\nAI Assistant')).toBe('Hello')
    // Text that merely mentions the words is left alone.
    expect(stripAiFooter('I am the AI Assistant of the clinic. How can I help?')).toBe(
      'I am the AI Assistant of the clinic. How can I help?',
    )
    expect(stripAiFooter('No footer here')).toBe('No footer here')
  })
})
