# Automated wishes — agreed design and current state

Status: groundwork only. Nothing here is wired into the app yet, and
migration 067 has **not** been applied to the production database.

## What exists in the repo

- `supabase/migrations/067_wishes.sql` — tables `contact_wishes` (one
  per contact: day, month, sending number, message or template, last
  sent year) and `wish_schedules` (one per number: frequency, time zone,
  time of day, next/last run). RLS: members read, agents edit wishes,
  admins edit schedules.
- `src/lib/wishes/schedule.ts` (+ tests) — pure date math: next run per
  frequency (hourly/daily/weekly/monthly/yearly) in a time zone, the
  run window since the previous run (max 7 days look-back), which year
  a wish is due in a window, 29 Feb → 28 Feb.
- `src/lib/cron-auth.ts` — shared-secret check for cron routes that
  accepts `x-cron-secret: AUTOMATION_CRON_SECRET` or Vercel Cron's
  `Authorization: Bearer CRON_SECRET`.

## Agreed behaviour (from the product owner)

1. **Settings → "Wish Scheduler"**: one card per connected number. Per
   card: on/off, frequency, time zone, time of day (plus weekday / day
   of month / month where needed), last and next run, "Run now".
2. **Contact → "Wish" tab**: enable switch; day and month as two
   dropdowns (day list limited to the month); message; Save. All fields
   required when enabled. **No time zone on the contact** — the
   schedule owns it.
3. **Sending number = the number selected in the contacts page
   dropdown** when the wish is saved (stored as `channel_id`). No
   guessing. If "All numbers" is selected, ask the user to pick one.
4. **Business API number**: instead of free text, a dropdown of that
   account's APPROVED templates (24-hour window rule); inputs for the
   template's `{{n}}` variables, with `{{name}}` resolved per contact.
   **WhatsApp Web number**: free text with `{{name}}`.
5. A run sends every enabled wish on that number whose date fell since
   the previous run (so weekly/monthly still catch mid-period dates),
   at most once per year per contact (`last_sent_year`), paced ~1/s,
   persisting through the normal send path so it shows in the inbox.

## Remaining work

- `src/lib/wishes/run.ts` — run one schedule (load channel, window,
  due wishes, send via `sendMessageToConversation` with `channelId`,
  update rows, book next run).
- Routes: `GET /api/wishes/cron` (uses `cron-auth`), `GET/PUT
  /api/wishes/schedules`, `POST /api/wishes/schedules/[channelId]/run`,
  `GET/PUT/DELETE /api/wishes/contact/[contactId]`.
- UI: `contact-wish-tab.tsx` in the contact detail view (new tab),
  `wish-scheduler.tsx` as a new settings section `wishes`.
- Locales (en/es/ko/pt), CHANGELOG, apply 067 with
  `npx supabase db query --remote --yes --file`.
- Scheduling: Vercel Hobby allows only daily cron jobs, so call
  `/api/wishes/cron` hourly from an n8n Schedule node with the
  `x-cron-secret` header, and set `AUTOMATION_CRON_SECRET` on Vercel.
