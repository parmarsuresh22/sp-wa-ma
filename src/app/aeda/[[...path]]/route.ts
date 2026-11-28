import { fomsAccess } from '@/lib/foms/api'
import { AEDA_PAGES, type AedaPage } from '@/lib/foms/pages.generated'

type Params = { params: Promise<{ path?: string[] }> }

const ID = /^\d{1,15}$/

/** Which original page an address shows, and the id it carries. */
function resolve(path: string[]): { page: AedaPage; id?: string } | null {
  const [a, b, c, ...rest] = path
  if (rest.length > 0) return null
  if (!a) return { page: 'landing' }
  if (a === 'settings' && !b) return { page: 'settings' }
  if (a === 'projects' && b && ID.test(b) && !c) return { page: 'project', id: b }
  if (a === 'forms' && b && ID.test(b)) {
    if (c === 'design') return { page: 'designer', id: b }
    if (c === 'summary') return { page: 'summary', id: b }
    if (c === 'fill') return { page: 'fill', id: b }
  }
  return null
}

const notFound = () =>
  new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:14px system-ui;padding:24px">This page is not available.</p>', {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/**
 * /aeda/**  — the pages of AEDA Forms: the original FOMS screens, as
 * they are (built by scripts/build-aeda.mjs). They are whole documents
 * with their own styles, so the portal shows them in a frame on
 * /aeda-forms; "New Form" opens one in its own tab.
 *
 * Platform admin only while the module is being tried out.
 */
export async function GET(_request: Request, { params }: Params) {
  if (!(await fomsAccess().catch(() => null))) return notFound()
  const found = resolve((await params).path ?? [])
  if (!found) return notFound()
  const html = AEDA_PAGES[found.page].replaceAll('__FORM_ID__', found.id ?? '0').replaceAll('__PROJECT_ID__', found.id ?? '0')
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      // Shown inside the portal's own page, never inside anybody else's.
      'X-Frame-Options': 'SAMEORIGIN',
    },
  })
}
