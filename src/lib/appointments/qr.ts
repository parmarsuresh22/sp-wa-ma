// ============================================================
// The QR on an appointment card. Pure — used by the card, the scan
// route and the tests.
//
// The code is the appointment's own id (a random UUID, so it cannot be
// guessed) behind a prefix that tells it apart from an event pass or a
// payment QR. Scanning only does anything for a signed-in team member
// of the account the appointment belongs to.
// ============================================================

export const APPOINTMENT_QR_PREFIX = 'ATLASAPPT:'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function appointmentQrText(id: string): string {
  return `${APPOINTMENT_QR_PREFIX}${id.toLowerCase()}`
}

/** The appointment id inside a scanned or typed code, or null. */
export function parseAppointmentQr(raw: string): string | null {
  let text = (raw ?? '').trim()
  if (text.toUpperCase().startsWith(APPOINTMENT_QR_PREFIX)) text = text.slice(APPOINTMENT_QR_PREFIX.length)
  text = text.trim().toLowerCase()
  return UUID_RE.test(text) ? text : null
}

/** The short reference printed on the card: the first 8 characters of the id. */
export function appointmentRef(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase()
}

export type AppointmentScanResult =
  | 'ok'
  | 'already_completed'
  | 'cancelled'
  | 'pending'
  | 'other_day'
  | 'unknown'

/**
 * What a scan means, before anything is written. `apptDay` and `today`
 * are calendar dates (YYYY-MM-DD) in the business's own time zone.
 * Only an `ok` completes the visit.
 */
export function judgeAppointmentScan(input: {
  status: 'pending' | 'booked' | 'completed' | 'cancelled' | 'no_show'
  apptDay: string
  today: string
}): AppointmentScanResult {
  if (input.status === 'cancelled') return 'cancelled'
  if (input.status === 'completed') return 'already_completed'
  if (input.status === 'pending') return 'pending'
  // A card for another day is not a visit today: nothing is completed.
  if (input.apptDay !== input.today) return 'other_day'
  // Booked, or marked "did not come" earlier today and arrived late.
  return 'ok'
}

/**
 * Whether the drawing library can write this text correctly. It places
 * letters one by one, which is right for Latin letters but breaks
 * scripts whose letters join or stack (Hindi, Gujarati, Arabic…): a
 * name would come out misspelt. Such a text is left off the card — the
 * message under the picture still carries it.
 */
export function drawable(text: string | null | undefined): text is string {
  if (!text) return false
  // What the card's typeface holds: Latin letters with the common
  // accents, digits and punctuation.
  return /^[\u0020-\u007E\u00A0-\u00FF\u2010-\u2027]+$/.test(text)
}
