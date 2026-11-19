// ============================================================
// In-memory "last seen" cache for the browser.
//
// A screen that fetched its data, was left, and is opened again would
// otherwise start from a blank spinner every time. Keeping the last
// result in module memory lets it paint at once with what it showed
// before, then replace that with fresh data when the fetch returns
// (stale-while-revalidate).
//
// Memory only, on purpose: nothing is written to disk, and signing out
// does a full page load (see `signOut` in use-auth), which empties it.
// Keys still carry the user id so two sessions can never share a value.
// ============================================================

const store = new Map<string, unknown>()

export function readCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined
}

export function writeCache<T>(key: string, value: T): void {
  store.set(key, value)
}

export function clearClientCache(): void {
  store.clear()
}
