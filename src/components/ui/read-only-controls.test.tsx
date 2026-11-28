import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ReadOnlyArea } from '@/lib/plans/read-only-context'
import { Checkbox } from './checkbox'
import { Switch } from './switch'

/**
 * A part of the portal outside the plan is wrapped in a disabled
 * <fieldset>. The switch and the tick box are drawn with <span>
 * elements, which a fieldset does not switch off, so on a Standard
 * account the Wish Scheduler switch could still be flipped. Inside a
 * ReadOnlyArea they must come out disabled.
 */
describe('controls inside a read-only area', () => {
  const html = (node: React.ReactElement) => renderToStaticMarkup(node)

  it('leaves a switch usable outside one', () => {
    expect(html(React.createElement(Switch, { checked: false }))).not.toContain('data-disabled')
  })

  it('switches a switch off inside one', () => {
    const out = html(React.createElement(ReadOnlyArea, null, React.createElement(Switch, { checked: false })))
    expect(out).toContain('data-disabled')
    expect(out).toContain('aria-disabled="true"')
  })

  it('switches a tick box off inside one', () => {
    const out = html(React.createElement(ReadOnlyArea, null, React.createElement(Checkbox, { checked: false })))
    expect(out).toContain('data-disabled')
  })

  it('keeps a control disabled by its own page disabled outside one', () => {
    expect(html(React.createElement(Switch, { checked: false, disabled: true }))).toContain('data-disabled')
  })
})
