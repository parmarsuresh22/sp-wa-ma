// ============================================================
// The appointment card: one picture sent with a confirmation, carrying
// the business's name and logo, who the appointment is for, the date,
// the time, the address and a QR the reception scans to mark the visit
// as completed.
//
// Server-only. The picture is drawn with next/og (JSX to PNG), saved in
// the account's own folder of the public media bucket under a path
// holding the appointment's random id, and sent as an ordinary image.
// ============================================================

import { ImageResponse } from 'next/og'
import QRCode from 'qrcode'
import type { SupabaseClient } from '@supabase/supabase-js'

import { formatDay, formatTime, type AppointmentSettings } from './time'
import { appointmentQrText, appointmentRef, drawable } from './qr'

const BUCKET = 'chat-media'
const WIDTH = 1080
const HEIGHT = 1350
const LOGO_MAX_BYTES = 2 * 1024 * 1024
/** The kinds the drawing library can place; anything else is left out. */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif']

export interface CardAppointment {
  id: string
  account_id: string
  customer_name: string | null
  phone_key: string
  starts_at: string
}

export interface CardContent {
  businessName: string | null
  logo: string | null
  customerName: string
  day: string
  time: string
  address: string | null
  qr: string
  reference: string
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** The logo as a data URL, or null when it cannot be used. */
async function logoData(url: string): Promise<string | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!LOGO_TYPES.includes(type)) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 26 }}>
      <div style={{ display: 'flex', fontSize: 26, letterSpacing: 3, color: '#64748b' }}>{label}</div>
      <div style={{ display: 'flex', fontSize: 44, fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>{value}</div>
    </div>
  )
}

/** The card as PNG bytes. */
export async function renderAppointmentCard(card: CardContent): Promise<Buffer> {
  const image = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#e2e8f0',
          padding: 36,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            backgroundColor: '#ffffff',
            borderRadius: 36,
            overflow: 'hidden',
          }}
        >
          {/* Who the card is from. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: '#0f172a',
              padding: '36px 44px',
              height: 190,
            }}
          >
            {card.logo && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 118,
                  height: 118,
                  borderRadius: 24,
                  backgroundColor: '#ffffff',
                  marginRight: 28,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img src={card.logo} width={98} height={98} style={{ objectFit: 'contain' }} />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1 }}>
              <div style={{ display: 'flex', fontSize: 50, fontWeight: 700, color: '#ffffff', lineHeight: 1.15 }}>
                {card.businessName ? cut(card.businessName, 44) : 'Appointment'}
              </div>
              <div style={{ display: 'flex', fontSize: 26, letterSpacing: 4, color: '#94a3b8', marginTop: 6 }}>
                APPOINTMENT CARD
              </div>
            </div>
          </div>

          {/* The appointment. */}
          <div style={{ display: 'flex', flexDirection: 'column', padding: '34px 44px 0 44px' }}>
            <div style={{ display: 'flex' }}>
              <div
                style={{
                  display: 'flex',
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: 3,
                  color: '#047857',
                  backgroundColor: '#d1fae5',
                  borderRadius: 999,
                  padding: '8px 22px',
                }}
              >
                CONFIRMED
              </div>
            </div>
            <div style={{ display: 'flex', fontSize: 58, fontWeight: 700, color: '#0f172a', marginTop: 18, lineHeight: 1.15 }}>
              {cut(card.customerName, 34)}
            </div>
            <Row label="DATE" value={card.day} />
            <Row label="TIME" value={card.time} />
            {card.address && <Row label="ADDRESS" value={cut(card.address.replace(/\s+/g, ' '), 84)} />}
          </div>

          {/* What the reception scans. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginTop: 'auto',
              padding: '30px 44px 36px 44px',
              borderTop: '3px dashed #cbd5e1',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
            <img src={card.qr} width={330} height={330} />
            <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 36, flexShrink: 1 }}>
              <div style={{ display: 'flex', fontSize: 38, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>
                Show this QR at the reception
              </div>
              <div style={{ display: 'flex', fontSize: 26, color: '#64748b', marginTop: 12, lineHeight: 1.3 }}>
                It is scanned once, when you arrive.
              </div>
              <div style={{ display: 'flex', fontSize: 26, letterSpacing: 2, color: '#64748b', marginTop: 20 }}>
                {`REF ${card.reference}`}
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    { width: WIDTH, height: HEIGHT },
  )
  return Buffer.from(await image.arrayBuffer())
}

/**
 * Draw and save the card of one appointment and return its public
 * address — or null when the card is switched off for the number, or it
 * could not be made (the confirmation then goes out as words alone).
 */
export async function appointmentCardUrl(
  db: SupabaseClient,
  appt: CardAppointment,
  settings: AppointmentSettings,
): Promise<string | null> {
  if (!settings.send_brand_logo) return null
  try {
    const { data } = await db
      .from('accounts')
      .select('brand_enabled, brand_name, brand_logo_url')
      .eq('id', appt.account_id)
      .maybeSingle()
    const brand = data as { brand_enabled?: boolean; brand_name?: string | null; brand_logo_url?: string | null } | null
    const branded = brand?.brand_enabled === true
    const at = new Date(appt.starts_at)

    const qr = await QRCode.toDataURL(appointmentQrText(appt.id), {
      width: 660,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    // The first of the two names that can be written on the card.
    const names = [settings.business_name?.trim(), branded ? brand?.brand_name?.trim() : null]
    const customer = appt.customer_name?.trim()
    const address = settings.address?.trim()
    const png = await renderAppointmentCard({
      businessName: names.find((n) => drawable(n)) ?? null,
      logo: branded && brand?.brand_logo_url ? await logoData(brand.brand_logo_url) : null,
      customerName: drawable(customer) ? customer : `+${appt.phone_key}`,
      day: formatDay(at, settings.timezone),
      time: formatTime(at, settings.timezone).toUpperCase(),
      address: drawable(address) ? address : null,
      qr,
      reference: appointmentRef(appt.id),
    })

    // A new file each time: a moved appointment gets a card with the new
    // time, and no phone shows an old one from its cache.
    const path = `account-${appt.account_id}/appointments/${appt.id}/card-${Date.now()}.png`
    const { error } = await db.storage.from(BUCKET).upload(path, png, {
      contentType: 'image/png',
      cacheControl: '31536000',
      upsert: true,
    })
    if (error) throw new Error(error.message)
    return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
  } catch (err) {
    console.warn('[appointments] the appointment card could not be made:', err instanceof Error ? err.message : err)
    return null
  }
}
