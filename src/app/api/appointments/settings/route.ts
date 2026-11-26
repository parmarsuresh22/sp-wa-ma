import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadChannel } from '@/lib/whatsapp/channels'
import { loadAiConfig } from '@/lib/ai/config'
import { supportsAppointmentActions } from '@/lib/appointments/agent'
import { loadAppointmentSettings, saveClosedDates, TEMPLATE_EXAMPLES } from '@/lib/appointments/service'
import { parseSettingsInput } from '@/lib/appointments/time'

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/appointments/settings?channel_id=   (agent+)
 *
 * The appointment settings of one WhatsApp number (defaults when none
 * are saved yet), plus what the screen needs to explain itself: the
 * number's type, the approved templates a Business API number may use,
 * and whether the saved AI key can take bookings in chat.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent', 'appointments')
    const channelId = new URL(request.url).searchParams.get('channel_id') ?? ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })

    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, channelId)
    if (!channel) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })

    const [settings, ai, templates] = await Promise.all([
      loadAppointmentSettings(db, accountId, channelId),
      loadAiConfig(db, accountId, { requireActive: false }).catch(() => null),
      channel.provider === 'waha'
        ? Promise.resolve({ data: [] as { name: string; language: string | null }[] })
        : db
            .from('message_templates')
            .select('name, language, status')
            .eq('account_id', accountId)
            .eq('status', 'Approved')
            .order('name')
            .limit(200),
    ])

    return NextResponse.json({
      settings,
      provider: channel.provider === 'waha' ? 'waha' : 'meta',
      templates: ((templates.data ?? []) as { name: string; language: string | null }[]).map((t) => ({
        name: t.name,
        language: t.language ?? 'en_US',
      })),
      template_examples: TEMPLATE_EXAMPLES,
      ai: {
        has_key: !!ai,
        provider: ai?.provider ?? null,
        model: ai?.model ?? null,
        can_book: !!ai && supportsAppointmentActions(ai.provider),
        agent_on: !!ai && ai.isActive && ai.autoReplyEnabled,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PUT /api/appointments/settings   (admin+)
 *
 * Body: { channel_id, enabled, business_name, address, timezone,
 *         slot_minutes, slot_capacity, days_ahead, hours, holidays,
 *         reminder_mode, reminder_time, confirm_template(+_language),
 *         reminder_template(+_language) }
 */
export async function PUT(request: Request) {
  try {
    const { accountId } = await requireRole('admin', 'appointments')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }
    const channelId = typeof body.channel_id === 'string' ? body.channel_id : ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })

    const db = supabaseAdmin()
    const channel = await loadChannel(db, accountId, channelId)
    if (!channel) return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })

    const parsed = parseSettingsInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (parsed.value.enabled && Object.keys(parsed.value.hours).length === 0) {
      return NextResponse.json({ error: 'Set working hours for at least one day' }, { status: 400 })
    }

    const { error } = await db.from('appointment_settings').upsert(
      {
        account_id: accountId,
        channel_id: channelId,
        ...parsed.value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_id' },
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ settings: await loadAppointmentSettings(db, accountId, channelId) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/appointments/settings   (admin+)
 *
 * Body: { channel_id, holidays: ['YYYY-MM-DD', ...] }
 *
 * Save only the closed dates. The screen calls this the moment a date
 * is added or removed, so a closed date never depends on remembering to
 * press "Save settings".
 */
export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin', 'appointments')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const channelId = typeof body?.channel_id === 'string' ? body.channel_id : ''
    if (!UUID.test(channelId)) return NextResponse.json({ error: 'Choose a WhatsApp number' }, { status: 400 })
    if (!Array.isArray(body?.holidays)) return NextResponse.json({ error: 'holidays must be a list of dates' }, { status: 400 })

    const db = supabaseAdmin()
    if (!(await loadChannel(db, accountId, channelId))) {
      return NextResponse.json({ error: 'WhatsApp number not found' }, { status: 404 })
    }
    const settings = await saveClosedDates(db, accountId, channelId, body.holidays as string[])
    return NextResponse.json({ settings })
  } catch (err) {
    return toErrorResponse(err)
  }
}
