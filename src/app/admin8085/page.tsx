import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { getSuperAdmin } from '@/lib/admin/super-admin'
import { loadAdminHome } from '@/lib/admin/overview'
import { AdminConsole } from '@/components/admin/admin-console'

export const metadata: Metadata = {
  title: 'Platform admin',
  robots: { index: false, follow: false },
}

// Reads the session cookie on every request; never cached.
export const dynamic = 'force-dynamic'

/**
 * The platform owner's page: who signed up, what they use, and the
 * WhatsApp Web number requests waiting for approval.
 *
 * Deliberately outside the dashboard (no menu entry, not in the
 * middleware's protected list): anyone who is not the platform admin —
 * signed in or not — gets the ordinary 404 page, the same as for a URL
 * that does not exist. The data itself is served by /api/admin8085/*,
 * which repeats the check on every call.
 */
export default async function PlatformAdminPage() {
  const admin = await getSuperAdmin()
  if (!admin) notFound()
  // The list and the requests travel with the page itself, so it opens
  // already filled in; the usage counts follow from the browser. If this
  // read fails the page still opens and loads everything from there.
  const initial = await loadAdminHome(admin.db).catch(() => null)
  return <AdminConsole email={admin.email} initial={initial} />
}
