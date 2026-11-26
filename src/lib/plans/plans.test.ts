import { describe, expect, it } from 'vitest'

import { parsePlanInput, pathLockedByPlan, planAllows, planHasFeature, roleHasRoom, toPlan } from './plans'

const STANDARD = ['dashboard', 'inbox', 'contacts', 'pipelines', 'broadcasts', 'automations', 'flows', 'agents']

describe('planAllows', () => {
  it('follows the list of the plan', () => {
    expect(planAllows(STANDARD, 'inbox')).toBe(true)
    expect(planAllows(STANDARD, 'appointments')).toBe(false)
    expect(planAllows([], 'dashboard')).toBe(false)
  })

  it('locks nothing when the plan is not known', () => {
    expect(planAllows(null, 'appointments')).toBe(true)
    expect(planAllows(undefined, 'events')).toBe(true)
  })
})

describe('pathLockedByPlan', () => {
  it('locks the pages of a module outside the plan, and its sub-pages', () => {
    expect(pathLockedByPlan(STANDARD, '/appointments')).toBe(true)
    expect(pathLockedByPlan(STANDARD, '/events/abc')).toBe(true)
    expect(pathLockedByPlan(STANDARD, '/service')).toBe(true)
    expect(pathLockedByPlan(STANDARD, '/data')).toBe(true)
  })

  it('leaves the modules of the plan open; Notifications go with the Inbox', () => {
    expect(pathLockedByPlan(STANDARD, '/inbox')).toBe(false)
    expect(pathLockedByPlan(STANDARD, '/notifications')).toBe(false)
    expect(pathLockedByPlan(STANDARD, '/flows/12')).toBe(false)
  })

  it('never locks pages that belong to no module', () => {
    expect(pathLockedByPlan([], '/settings')).toBe(false)
    expect(pathLockedByPlan([], '/plans')).toBe(false)
  })
})

describe('toPlan', () => {
  it('drops unknown modules and keeps the portal order', () => {
    const plan = toPlan({ key: 'standard', name: 'Standard', position: 1, web_number_limit: 1, sections: ['inbox', 'gone', 'dashboard'] })
    expect(plan.sections).toEqual(['dashboard', 'inbox'])
    expect(plan.description).toBeNull()
  })
})

describe('parsePlanInput', () => {
  it('accepts a name, a limit and modules', () => {
    const parsed = parsePlanInput({
      name: ' Premium ',
      description: ' All ',
      web_number_limit: 2,
      sections: ['events', 'nope', 'inbox'],
      features: ['api_keys', 'nope', 'branding'],
      max_agents: 1,
      max_viewers: '',
    })
    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'Premium',
        description: 'All',
        web_number_limit: 2,
        sections: ['inbox', 'events'],
        features: ['branding', 'api_keys'],
        max_admins: null,
        max_agents: 1,
        max_viewers: null,
      },
    })
    expect(parsePlanInput({ name: 'A', web_number_limit: 1, sections: [], max_agents: -1 }).ok).toBe(false)
  })

  it('knows the Settings features and the team room of a plan', () => {
    const standard = toPlan({ key: 'standard', name: 'Standard', sections: [], features: [], max_admins: 0, max_agents: 1, max_viewers: 1 })
    const premium = toPlan({ key: 'premium', name: 'Premium', sections: [], features: ['branding', 'wishes', 'api_keys'] })
    expect(planHasFeature(standard, 'branding')).toBe(false)
    expect(planHasFeature(premium, 'wishes')).toBe(true)
    // An unknown plan locks nothing.
    expect(planHasFeature(null, 'api_keys')).toBe(true)

    expect(roleHasRoom(standard, 'agent', 0)).toBe(true)
    expect(roleHasRoom(standard, 'agent', 1)).toBe(false)
    expect(roleHasRoom(standard, 'viewer', 1)).toBe(false)
    expect(roleHasRoom(standard, 'admin', 0)).toBe(false)
    expect(roleHasRoom(premium, 'agent', 500)).toBe(true)
    expect(roleHasRoom(null, 'agent', 500)).toBe(true)
  })

  it('refuses a missing name, a bad limit and a missing module list', () => {
    expect(parsePlanInput({ name: '', web_number_limit: 1, sections: [] }).ok).toBe(false)
    expect(parsePlanInput({ name: 'A', web_number_limit: 51, sections: [] }).ok).toBe(false)
    expect(parsePlanInput({ name: 'A', web_number_limit: 1.5, sections: [] }).ok).toBe(false)
    expect(parsePlanInput({ name: 'A', web_number_limit: 1 }).ok).toBe(false)
    // A plan with no modules at all is allowed (everything read-only).
    expect(parsePlanInput({ name: 'A', web_number_limit: 0, sections: [] }).ok).toBe(true)
  })
})
