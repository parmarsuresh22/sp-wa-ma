# Automated wishes — design and how it works

Status: built and wired in. Migration 067 is applied to production.
What remains is operational: something has to call the cron endpoint
(see "Scheduling" at the end).

## Pieces

- `supabase/migrations/067_wishes.sql` — tables `contact_wishes` (one
  per contact: day, month, sending number, message or template, last
  sent year) and `wish_schedules` (one per number: frequency, time zone,
  time of day, next/last run). RLS: members read, agents edit wishes,
  admins edit schedules.
- `src/lib/wishes/schedule.ts` — pure date math: next run per frequency
  (hourly/daily/weekly/monthly/yearly) in a time zone, the run window
  since the previous run (max 7 days look-back), which year a wish is
  due in a window, 29 Feb → 28 Feb.
- `src/lib/wishes/run.ts` — runs one schedule: loads the number, picks
  the due wishes, sends each through `sendMessageToConversation` on that
  number, records the result, books the next run.
- `src/lib/cron-auth.ts` — shared-secret check for cron routes:
  `x-cron-secret: AUTOMATION_CRON_SECRET` or Vercel Cron's
  `Authorization: Bearer CRON_SECRET`.
- Routes: `GET /api/wishes/cron`, `GET/PUT /api/wishes/schedules`,
  `POST /api/wishes/schedules/[channelId]/run`,
  `GET/PUT/DELETE /api/wishes/contact/[contactId]`.
- UI: `src/components/contacts/contact-wish-tab.tsx` (contact sheet →
  "Wish" tab) and `src/components/settings/wish-scheduler.tsx`
  (Settings → "Wish Scheduler", section id `wishes`).

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

## Decisions made while building

- **Today always counts.** The window excludes the previous run's own
  day, so when the previous run was earlier today the runner steps the
  window back to include today. A wish saved at 10:00 for today still
  goes out at the next run (or "Run now") instead of waiting a year.
- **Claim before send.** `last_sent_year` is moved up *before* the
  message is sent, with a conditional update, so a cron call racing
  "Run now" cannot wish someone twice. A failed send puts the old value
  back and stores `last_error` (shown in the Wish tab); it is retried
  by later runs while its date is still inside the window.
- **Time budget.** A run stops after ~4 minutes (serverless limit). It
  then leaves `last_run_at` alone and marks itself due, so the next
  cron call continues; the claim keeps the already-sent ones out.
- **A run that could not start** (number removed or disconnected)
  records the error and moves to the next slot without advancing the
  window.
- **Changing a wish's date clears `last_sent_year`**: the new date is
  treated as a new occasion and can go out in the same year.
- **With a single number** there is no dropdown on the contacts page,
  so that number is used. With "All numbers" selected, an existing wish
  keeps its saved number; a new one asks the user to pick.
- **"Run now"** works whether or not the schedule is switched on, and
  uses the same window and once-a-year rule.
- **Template values** are stored in `template_params` as
  `{ body: [...], headerText?, buttonParams? }` (a plain array is still
  read as body values).
- `contact_wishes` / `wish_schedules` are listed as exempt in
  `redeem-invitation-migration.test.ts`: neither can have rows without
  a contact / a number, which `redeem_invitation` already checks.

## Scheduling

Vercel Hobby allows only daily cron jobs, so `/api/wishes/cron` is
called from outside:

1. Set `AUTOMATION_CRON_SECRET` on Vercel (any long random string) and
   redeploy.
2. In n8n, a Schedule node (every hour) → HTTP Request:
   `GET https://<app>/api/wishes/cron` with the header
   `x-cron-secret: <the same string>`.

A schedule fires at the first call after its chosen time, so hourly
calls mean "within the hour after". Until the secret is set the
endpoint answers 503 and nothing is sent automatically; "Run now" in
Settings works regardless.
