import { describe, expect, it } from 'vitest'

import { AI_KEY_PAGES, HELP_TOPICS, helpTopicForPage, isOutsideLink, type HelpTopic } from './topics'

describe('help topics', () => {
  it('has every topic in both languages, step for step', () => {
    for (const [key, raw] of Object.entries(HELP_TOPICS)) {
      const topic = raw as HelpTopic
      expect(topic.title.en, key).toBeTruthy()
      expect(topic.title.hi, key).toBeTruthy()
      expect(topic.intro.en, key).toBeTruthy()
      expect(topic.intro.hi, key).toBeTruthy()
      expect(topic.steps.en.length, key).toBeGreaterThan(0)
      expect(topic.steps.hi.length, key).toBe(topic.steps.en.length)
      for (const link of topic.links ?? []) {
        expect(link.label.en && link.label.hi, key).toBeTruthy()
        expect(isOutsideLink(link.url) || link.url.startsWith('/'), `${key}: ${link.url}`).toBe(true)
      }
    }
  })

  it('finds the topic of a page', () => {
    expect(helpTopicForPage('/dashboard')).toBe('dashboard')
    expect(helpTopicForPage('/inbox/abc')).toBe('inbox')
    expect(helpTopicForPage('/agents')).toBe('agents')
    expect(helpTopicForPage('/settings', 'whatsapp')).toBe('whatsapp')
    expect(helpTopicForPage('/settings', 'api')).toBe('apiKeys')
    expect(helpTopicForPage('/settings', 'menu')).toBe('menu')
    expect(helpTopicForPage('/settings', null)).toBe('settings')
    expect(helpTopicForPage('/settings', 'nonsense')).toBe('settings')
    expect(helpTopicForPage('/somewhere-else')).toBeNull()
  })

  it('points each AI provider at its own key page', () => {
    expect(AI_KEY_PAGES.openai.url).toContain('platform.openai.com')
    expect(AI_KEY_PAGES.anthropic.url).toContain('anthropic.com')
    expect(AI_KEY_PAGES.gemini.url).toContain('aistudio.google.com')
  })

  it('tells outside links from pages of the portal', () => {
    expect(isOutsideLink('https://example.com')).toBe(true)
    expect(isOutsideLink('mailto:someone@example.com')).toBe(true)
    expect(isOutsideLink('/settings?tab=whatsapp')).toBe(false)
  })
})
