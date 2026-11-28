'use client'

import { createContext, useContext, type ReactNode } from 'react'

// A part of the portal the plan does not include is shown read-only.
// The browser switches off real form controls inside a disabled
// <fieldset> by itself, but the portal's switches, tick boxes and radio
// buttons are drawn with <span> elements, which a fieldset does not
// reach: they stayed clickable. Those controls ask here instead.

const ReadOnlyContext = createContext(false)

/** Everything inside is read-only, whatever it is made of. */
export function ReadOnlyArea({ children }: { children: ReactNode }) {
  return <ReadOnlyContext.Provider value={true}>{children}</ReadOnlyContext.Provider>
}

/** True inside a read-only part of the portal. */
export function useReadOnlyArea(): boolean {
  return useContext(ReadOnlyContext)
}
