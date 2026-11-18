import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannel } from '@/lib/whatsapp/channels'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { extractTemplateVariables } from '@/lib/whatsapp/template-validators'
import { parseWishTemplateParams } from '@/lib/wishes/run'
import { daysInMonth } from '@/lib/wishes/schedule'

type Params = { params: Promise<{ contactId: string }> }

const MAX_MESSAGE_CHARS = 4096
// A leap year, so 29 February is a valid day to pick.
const LEAP_YEAR = 2024

/** GET /api/wishes/contact/[contactId] — the contact's wish, or null. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { contactId } = await params
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('contact_wishes')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ wish: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PUT /api/wishes/contact/[contactId]
 *
 * Body: { enabled, month, day, channel_id,
 *         message_text?            — WhatsApp Web number
 *         template_name?, template_language?, template_params? — Business API number }
 *
 * `channel_id` is the number the wish goes out on (the one selected on
 * the contacts page). A Business API number takes an approved template;
 * a WhatsApp Web number takes free text. `{{name}}` in the text or in a
 * template value becomes the contact's name at send time.
 */
export async function PUT(request: Request, { params }: Params) {
  try {
    const { contactId } = await params
    const { supabase, accountId } = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 })
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    }

    const month = body.month
    const day = body.day
    if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: 'Pick a month' }, { status: 400 })
    }
    if (
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > daysInMonth(LEAP_YEAR, month)
    ) {
      return NextResponse.json({ error: 'Pick a day that exists in that month' }, { status: 400 })
    }

    const channelId = typeof body.channel_id === 'string' ? body.channel_id : ''
    const channel = channelId ? await loadChannel(supabase, accountId, channelId) : null
    if (!channel) {
      return NextResponse.json(
        { error: 'Pick the number this wish is sent from' },
        { status: 400 },
      )
    }

    const enabled = body.enabled === true
    // A wish can only be switched on while its number's Wish Scheduler
    // is on — otherwise it would look active and never be sent.
    if (enabled) {
      const { data: schedule } = await supabase
        .from('wish_schedules')
        .select('enabled')
        .eq('account_id', accountId)
        .eq('channel_id', channel.id)
        .maybeSingle()
      if (!schedule?.enabled) {
        return NextResponse.json(
          { error: 'Turn on the Wish Scheduler for this number first (Settings → Wish Scheduler)' },
          { status: 400 },
        )
      }
    }
    const isBridge = channel.provider === 'waha'

    let messageText: string | null = null
    let templateName: string | null = null
    let templateLanguage: string | null = null
    let templateParams: unknown = []

    if (isBridge) {
      messageText = typeof body.message_text === 'string' ? body.message_text.trim() : ''
      if (messageText.length > MAX_MESSAGE_CHARS) {
        return NextResponse.json({ error: 'Message is too long' }, { status: 400 })
      }
      if (enabled && !messageText) {
        return NextResponse.json({ error: 'Write the message to send' }, { status: 400 })
      }
      messageText = messageText || null
    } else {
      templateName = typeof body.template_name === 'string' ? body.template_name.trim() : ''
      templateLanguage =
        typeof body.template_language === 'string' && body.template_language.trim()
          ? body.template_language.trim()
          : null
      const parsed = parseWishTemplateParams(body.template_params)

      if (templateName) {
        const resolved = await resolveTemplateRow(supabase, accountId, templateName, templateLanguage)
        if (!resolved.row || resolved.row.status !== 'APPROVED') {
          return NextResponse.json(
            { error: 'That template is not approved on this account' },
            { status: 400 },
          )
        }
        const needed = extractTemplateVariables(resolved.row.body_text).length
        parsed.body = parsed.body.slice(0, needed)
        if (
          enabled &&
          (parsed.body.length < needed || parsed.body.some((v) => !v.trim()))
        ) {
          return NextResponse.json(
            { error: 'Fill in every template value' },
            { status: 400 },
          )
        }
        templateLanguage = resolved.row.language ?? templateLanguage
      } else if (enabled) {
        return NextResponse.json({ error: 'Pick a template' }, { status: 400 })
      }
      templateName = templateName || null
      templateParams = parsed
    }

    const { data: existing } = await supabase
      .from('contact_wishes')
      .select('id, month, day')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()

    const row: Record<string, unknown> = {
      account_id: accountId,
      contact_id: contactId,
      channel_id: channel.id,
      enabled,
      month,
      day,
      message_text: messageText,
      template_name: templateName,
      template_language: templateLanguage,
      template_params: templateParams,
      last_error: null,
    }
    // A new date is a new occasion: let it go out this year even if the
    // old date was already wished.
    if (existing && (existing.month !== month || existing.day !== day)) {
      row.last_sent_year = null
    }

    const { data, error } = await supabase
      .from('contact_wishes')
      .upsert(row, { onConflict: 'contact_id' })
      .select('*')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ wish: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/wishes/contact/[contactId] — remove the contact's wish. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { contactId } = await params
    const { supabase, accountId } = await requireRole('agent')
    const { error } = await supabase
      .from('contact_wishes')
      .delete()
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
