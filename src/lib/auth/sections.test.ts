import { describe, expect, it } from 'vitest'
import { canSeeSection, cleanSections, firstAllowedPath, roleCanBeRestricted, sectionForPath } from './sections'

describe('sections a member may open', () => {
  it('owners and admins always see everything', () => {
    expect(canSeeSection('owner', [], 'inbox')).toBe(true)
    expect(canSeeSection('admin', ['appointments'], 'inbox')).toBe(true)
  })
  it('an agent or viewer with no list sees everything (how it worked before)', () => {
    expect(canSeeSection('agent', null, 'inbox')).toBe(true)
    expect(canSeeSection('viewer', undefined, 'contacts')).toBe(true)
  })
  it('a viewer limited to appointments sees appointments and nothing else', () => {
    const only = ['appointments']
    expect(canSeeSection('viewer', only, 'appointments')).toBe(true)
    for (const s of ['inbox', 'contacts', 'dashboard', 'broadcasts', 'posts', 'pipelines'] as const) {
      expect(canSeeSection('viewer', only, s)).toBe(false)
    }
  })
  it('an empty list means nothing at all', () => {
    expect(canSeeSection('agent', [], 'dashboard')).toBe(false)
    expect(firstAllowedPath('agent', [])).toBe('/settings')
  })
  it('maps pages to their section, sub-pages and notifications included', () => {
    expect(sectionForPath('/inbox')).toBe('inbox')
    expect(sectionForPath('/broadcasts/abc')).toBe('broadcasts')
    expect(sectionForPath('/notifications')).toBe('inbox')
    expect(sectionForPath('/appointments')).toBe('appointments')
    expect(sectionForPath('/settings')).toBeNull()
    expect(sectionForPath('/inboxes')).toBeNull()
  })
  it('sends a blocked member to their first allowed page', () => {
    expect(firstAllowedPath('viewer', ['appointments'])).toBe('/appointments')
    expect(firstAllowedPath('agent', null)).toBe('/dashboard')
  })
  it('keeps only known sections from what the browser sends', () => {
    expect(cleanSections(['inbox', 'hack', 'appointments', 7])).toEqual(['inbox', 'appointments'])
    expect(cleanSections(null)).toBeNull()
    expect(cleanSections('inbox')).toBeNull()
    expect(cleanSections([])).toEqual([])
  })
  it('only agents and viewers can be limited', () => {
    expect(roleCanBeRestricted('agent')).toBe(true)
    expect(roleCanBeRestricted('viewer')).toBe(true)
    expect(roleCanBeRestricted('admin')).toBe(false)
    expect(roleCanBeRestricted('owner')).toBe(false)
  })
})
