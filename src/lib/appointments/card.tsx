// ============================================================
// The appointment card: one picture sent with every confirmation and
// every change of time, carrying the business's name and logo, who the
// appointment is for, the date, the time, the address and a QR the
// reception scans to mark the visit as completed.
//
// Server-only. The picture is drawn with next/og (JSX to PNG), saved in
// the account's own folder of the public media bucket under a path
// holding the appointment's random id, and sent as an ordinary image.
// It is drawn afresh from the appointment each time, so it always shows
// the latest date and time.
// ============================================================

import { ImageResponse } from 'next/og'
import QRCode from 'qrcode'
import type { SupabaseClient } from '@supabase/supabase-js'

import { formatDay, formatTime, type AppointmentSettings } from './time'
import { appointmentQrText, appointmentRef, drawable } from './qr'
import { INTER_REGULAR, INTER_SEMIBOLD } from './card-fonts'

const BUCKET = 'chat-media'
const WIDTH = 1080
const HEIGHT = 1350
const LOGO_MAX_BYTES = 2 * 1024 * 1024
/** The kinds the drawing library can place; anything else is left out. */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif']

// One quiet palette: dark ink, grey labels, hairlines, one accent.
const INK = '#0f172a'
const SOFT = '#475569'
const MUTED = '#94a3b8'
const LINE = '#e2e8f0'
const PANEL = '#f8fafc'
const ACCENT = '#2563eb'

const fontBytes = (b64: string): ArrayBuffer => {
  const buf = Buffer.from(b64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
// Read once; the typeface does not depend on the appointment.
const FONTS = [
  { name: 'Inter', data: fontBytes(INTER_REGULAR), weight: 400 as const, style: 'normal' as const },
  { name: 'Inter', data: fontBytes(INTER_SEMIBOLD), weight: 600 as const, style: 'normal' as const },
]

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

function Caption({ children }: { children: string }) {
  return <div style={{ display: 'flex', fontSize: 22, fontWeight: 600, letterSpacing: 3, color: MUTED }}>{children}</div>
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
          backgroundColor: '#f1f5f9',
          padding: 40,
          fontFamily: 'Inter',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            // A fixed width: a long business name wraps instead of
            // pushing the card past the edge of the picture.
            width: WIDTH - 80,
            backgroundColor: '#ffffff',
            border: `2px solid ${LINE}`,
            borderRadius: 32,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', height: 10, backgroundColor: ACCENT }} />

          {/* Who the card is from. */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '40px 48px 36px 48px' }}>
            {card.logo && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 104,
                  height: 104,
                  borderRadius: 22,
                  border: `2px solid ${LINE}`,
                  backgroundColor: '#ffffff',
                  marginRight: 26,
                  flexShrink: 0,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img src={card.logo} width={84} height={84} style={{ objectFit: 'contain' }} />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', width: card.logo ? 770 : 900 }}>
              <div style={{ display: 'flex', fontSize: 42, fontWeight: 600, color: INK, lineHeight: 1.18 }}>
                {card.businessName ? cut(card.businessName, 48) : 'Your appointment'}
              </div>
              <div style={{ display: 'flex', fontSize: 25, color: SOFT, marginTop: 6 }}>Appointment card</div>
            </div>
          </div>
          <div style={{ display: 'flex', height: 2, backgroundColor: LINE, margin: '0 48px' }} />

          {/* The appointment. */}
          <div style={{ display: 'flex', flexDirection: 'column', padding: '36px 48px 0 48px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Caption>NAME</Caption>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 22,
                  fontWeight: 600,
                  letterSpacing: 2,
                  color: '#047857',
                  backgroundColor: '#ecfdf5',
                  border: '2px solid #a7f3d0',
                  borderRadius: 999,
                  padding: '6px 18px',
                }}
              >
                <div style={{ display: 'flex', width: 12, height: 12, borderRadius: 6, backgroundColor: '#10b981', marginRight: 10 }} />
                CONFIRMED
              </div>
            </div>
            <div style={{ display: 'flex', fontSize: 50, fontWeight: 600, color: INK, marginTop: 8, lineHeight: 1.18 }}>
              {cut(card.customerName, 36)}
            </div>

            <div
              style={{
                display: 'flex',
                backgroundColor: PANEL,
                border: `2px solid ${LINE}`,
                borderRadius: 24,
                marginTop: 30,
                padding: '26px 30px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                <Caption>DATE</Caption>
                <div style={{ display: 'flex', fontSize: 34, fontWeight: 600, color: INK, marginTop: 8 }}>{card.day}</div>
              </div>
              <div style={{ display: 'flex', width: 2, backgroundColor: LINE, margin: '0 28px' }} />
              <div style={{ display: 'flex', flexDirection: 'column', width: 200, flexShrink: 0 }}>
                <Caption>TIME</Caption>
                <div style={{ display: 'flex', fontSize: 34, fontWeight: 600, color: ACCENT, marginTop: 8 }}>{card.time}</div>
              </div>
            </div>

            {card.address && (
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 28 }}>
                <Caption>ADDRESS</Caption>
                <div style={{ display: 'flex', fontSize: 29, color: SOFT, marginTop: 8, lineHeight: 1.35 }}>
                  {cut(card.address.replace(/\s+/g, ' '), 110)}
                </div>
              </div>
            )}
          </div>

          {/* What the reception scans. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginTop: 'auto',
              padding: '32px 48px 30px 48px',
              borderTop: `2px dashed ${LINE}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                padding: 14,
                border: `2px solid ${LINE}`,
                borderRadius: 22,
                backgroundColor: '#ffffff',
                flexShrink: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
              <img src={card.qr} width={270} height={270} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 36, flexShrink: 1 }}>
              <div style={{ display: 'flex', fontSize: 34, fontWeight: 600, color: INK, lineHeight: 1.22 }}>
                Show this QR at the reception
              </div>
              <div style={{ display: 'flex', fontSize: 25, color: SOFT, marginTop: 10, lineHeight: 1.35 }}>
                It is scanned once, when you arrive.
              </div>
              <div style={{ display: 'flex', marginTop: 20 }}>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 23,
                    fontWeight: 600,
                    letterSpacing: 2,
                    color: SOFT,
                    backgroundColor: PANEL,
                    border: `2px solid ${LINE}`,
                    borderRadius: 12,
                    padding: '6px 14px',
                  }}
                >
                  {`REF ${card.reference}`}
                </div>
              </div>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              fontSize: 22,
              color: MUTED,
              backgroundColor: PANEL,
              borderTop: `2px solid ${LINE}`,
              padding: '16px 48px',
            }}
          >
            Need to change or cancel? Reply to this message on WhatsApp.
          </div>
        </div>
      </div>
    ),
    { width: WIDTH, height: HEIGHT, fonts: FONTS },
  )
  return Buffer.from(await image.arrayBuffer())
}

/**
 * Draw and save the card of one appointment as it stands now, and
 * return its public address — or null when it could not be made (the
 * confirmation then goes out as words alone).
 */
export async function appointmentCardUrl(
  db: SupabaseClient,
  appt: CardAppointment,
  settings: AppointmentSettings,
): Promise<string | null> {
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
      width: 540,
      margin: 0,
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
