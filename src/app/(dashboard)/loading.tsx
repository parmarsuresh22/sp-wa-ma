/**
 * Shown the instant a dashboard link is clicked, while the next
 * screen's code and data arrive. Without it the old screen stays frozen
 * until everything is ready, which reads as "the click did nothing".
 * The sidebar and header belong to the layout and stay interactive.
 */
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-48 rounded-md bg-muted" />
        <div className="h-4 w-80 max-w-full rounded-md bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card" />
        ))}
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-9 rounded-md bg-muted" />
        ))}
      </div>
    </div>
  )
}
