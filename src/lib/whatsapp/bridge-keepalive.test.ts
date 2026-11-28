import { describe, expect, it } from 'vitest'

import { STARTING_STALE_MS, recoveryStep } from './bridge-keepalive'

describe('recoveryStep', () => {
  it('starts a stopped session and restarts a failed one', () => {
    expect(recoveryStep('STOPPED', 0)).toBe('start')
    expect(recoveryStep('FAILED', 0)).toBe('restart')
    expect(recoveryStep('failed', 0)).toBe('restart')
  })

  it('gives a start time to finish, then starts it over', () => {
    expect(recoveryStep('STARTING', 10_000)).toBe('wait')
    expect(recoveryStep('STARTING', STARTING_STALE_MS + 1)).toBe('restart')
  })

  it('only records a session that works or waits for a QR scan', () => {
    expect(recoveryStep('WORKING', 0)).toBe('sync')
    expect(recoveryStep('SCAN_QR_CODE', 999_999_999)).toBe('sync')
    expect(recoveryStep(null, 0)).toBe('sync')
  })
})
