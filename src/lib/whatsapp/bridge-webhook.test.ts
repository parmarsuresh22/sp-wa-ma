import { describe, expect, it } from 'vitest'
import {
  ackToStatus,
  bridgeOwnPhone,
  normalizeBridgeAddressing,
  parseBridgeEnvelope,
  sessionStatusFromPayload,
  translateBridgeEcho,
  translateBridgeInbound,
  verifyBridgeSignature,
} from './bridge-webhook'

describe('verifyBridgeSignature', () => {
  // Test vector from the WAHA docs (Webhooks → HMAC authentication).
  const body = '{"event":"message","session":"default","engine":"WEBJS"}'
  const key = 'my-secret-key'
  const sig =
    '208f8a55dde9e05519e898b10b89bf0d0b3b0fdf11fdbf09b6b90476301b98d8097c462b2b17a6ce93b6b47a136cf2e78a33a63f6752c2c1631777076153fa89'

  it('accepts the documented sha512 vector', () => {
    expect(verifyBridgeSignature(body, sig, key, 'sha512')).toBe(true)
  })

  it('defaults to sha512 when the algorithm header is missing', () => {
    expect(verifyBridgeSignature(body, sig, key, null)).toBe(true)
  })

  it('rejects a tampered body, a wrong key, a missing header and an empty secret', () => {
    expect(verifyBridgeSignature(body + ' ', sig, key)).toBe(false)
    expect(verifyBridgeSignature(body, sig, 'other-key')).toBe(false)
    expect(verifyBridgeSignature(body, null, key)).toBe(false)
    expect(verifyBridgeSignature(body, sig, '')).toBe(false)
  })

  it('rejects unknown algorithms', () => {
    expect(verifyBridgeSignature(body, sig, key, 'md5')).toBe(false)
  })
})

const ENV = {
  event: 'message',
  session: 'wacrm-ab12',
  timestamp: 1741249702485,
  me: { id: '919999999999@c.us', pushName: 'Shop' },
  payload: null,
}

describe('translateBridgeInbound', () => {
  it('maps a text message into the Meta shape with the sender phone', () => {
    const out = translateBridgeInbound(ENV, {
      id: 'false_911234567890@c.us_ABC',
      timestamp: 1667561485,
      from: '911234567890@c.us',
      fromMe: false,
      to: '919999999999@c.us',
      body: 'Hi there!',
      hasMedia: false,
      _data: { pushName: 'Asha' },
    })
    expect(out).not.toBeNull()
    expect(out!.phone).toBe('+911234567890')
    expect(out!.message).toMatchObject({
      id: 'false_911234567890@c.us_ABC',
      from: '911234567890',
      timestamp: '1667561485',
      type: 'text',
      text: { body: 'Hi there!' },
    })
    expect(out!.contact).toEqual({ wa_id: '911234567890', profile: { name: 'Asha' } })
  })

  it('carries the quoted message id as Meta context', () => {
    const out = translateBridgeInbound(ENV, {
      id: 'x',
      from: '911234567890@c.us',
      body: 'yes',
      replyTo: { id: 'true_911234567890@c.us_PARENT' },
    })
    expect(out!.message.context).toEqual({ id: 'true_911234567890@c.us_PARENT' })
  })

  it('maps downloaded media by MIME type and keeps the caption + filename', () => {
    const doc = translateBridgeInbound(ENV, {
      id: 'd',
      from: '911234567890@c.us',
      body: 'invoice attached',
      hasMedia: true,
      media: { url: 'https://bridge/api/files/abc.pdf', mimetype: 'application/pdf', filename: 'invoice.pdf' },
    })
    expect(doc!.message.type).toBe('document')
    expect(doc!.message.document).toEqual({
      id: 'https://bridge/api/files/abc.pdf',
      mime_type: 'application/pdf',
      filename: 'invoice.pdf',
      caption: 'invoice attached',
    })

    const img = translateBridgeInbound(ENV, {
      id: 'i',
      from: '911234567890@c.us',
      hasMedia: true,
      media: { url: 'https://bridge/api/files/p.jpg', mimetype: 'image/jpeg' },
    })
    expect(img!.message.type).toBe('image')

    const voice = translateBridgeInbound(ENV, {
      id: 'v',
      from: '911234567890@c.us',
      hasMedia: true,
      media: { url: 'https://bridge/api/files/v.oga', mimetype: 'audio/ogg; codecs=opus' },
    })
    expect(voice!.message.type).toBe('audio')
  })

  it('skips channels, status broadcasts and our own sends', () => {
    const base = { id: 'x', body: 'hi' }
    expect(translateBridgeInbound(ENV, { ...base, from: '1203630@newsletter' })).toBeNull()
    expect(translateBridgeInbound(ENV, { ...base, from: 'status@broadcast' })).toBeNull()
    expect(translateBridgeInbound(ENV, { ...base, from: '911234567890@c.us', fromMe: true })).toBeNull()
  })

  it('leaves a placeholder when the bridge did not download the media', () => {
    const out = translateBridgeInbound(ENV, {
      id: 'm',
      from: '911234567890@c.us',
      hasMedia: true,
      media: { url: null, mimetype: 'image/jpeg' },
    })
    expect(out!.message.type).toBe('text')
    expect(out!.message.text?.body).toMatch(/not downloaded/)
  })
})

describe('translateBridgeEcho', () => {
  it('describes a message the owner sent from the phone', () => {
    const echo = translateBridgeEcho(ENV, {
      id: 'true_911234567890@c.us_OWN',
      timestamp: 1667561485,
      from: '919999999999@c.us',
      fromMe: true,
      to: '911234567890@c.us',
      body: 'On my way',
    })
    expect(echo).toEqual({
      id: 'true_911234567890@c.us_OWN',
      phone: '+911234567890',
      text: 'On my way',
      timestampIso: '2022-11-04T11:31:25.000Z',
      hasMedia: false,
      mediaUrl: null,
      mimeType: null,
      filename: null,
    })
  })

  it('ignores inbound and group traffic', () => {
    expect(translateBridgeEcho(ENV, { id: 'a', fromMe: false, to: '911234567890@c.us' })).toBeNull()
    expect(translateBridgeEcho(ENV, { id: 'b', fromMe: true, to: '123@g.us' })).toBeNull()
  })
})

describe('ackToStatus', () => {
  it('maps WAHA acks onto Meta status words', () => {
    expect(ackToStatus({ id: 'm', ack: 1, ackName: 'SERVER' })).toEqual({ id: 'm', status: 'sent' })
    expect(ackToStatus({ id: 'm', ack: 2, ackName: 'DEVICE' })).toEqual({ id: 'm', status: 'delivered' })
    expect(ackToStatus({ id: 'm', ack: 3, ackName: 'READ' })).toEqual({ id: 'm', status: 'read' })
    expect(ackToStatus({ id: 'm', ack: 4, ackName: 'PLAYED' })).toEqual({ id: 'm', status: 'read' })
    expect(ackToStatus({ id: 'm', ack: -1, ackName: 'ERROR' })).toEqual({ id: 'm', status: 'failed' })
  })

  it('ignores pending and malformed acks', () => {
    expect(ackToStatus({ id: 'm', ack: 0, ackName: 'PENDING' })).toBeNull()
    expect(ackToStatus({ ack: 2 })).toBeNull()
    expect(ackToStatus(null)).toBeNull()
  })
})

describe('envelope helpers', () => {
  it('parses a well-formed envelope and rejects the rest', () => {
    expect(parseBridgeEnvelope(JSON.stringify(ENV))).toMatchObject({ event: 'message', session: 'wacrm-ab12' })
    expect(parseBridgeEnvelope('{"event":1}')).toBeNull()
    expect(parseBridgeEnvelope('not json')).toBeNull()
  })

  it('reads the session status and the logged-in number', () => {
    expect(sessionStatusFromPayload({ status: 'working' })).toBe('WORKING')
    expect(sessionStatusFromPayload({ status: 'SCAN_QR_CODE' })).toBe('SCAN_QR_CODE')
    expect(sessionStatusFromPayload({ status: 'WHATEVER' })).toBeNull()
    expect(bridgeOwnPhone(ENV)).toBe('+919999999999')
    expect(bridgeOwnPhone({ ...ENV, me: null })).toBeNull()
  })
})

describe('WhatsApp groups', () => {
  const GROUP = '120363025246125486@g.us'

  it('files a group message under the group, not under the member who wrote it', async () => {
    // The engine reports the member (as a linked id) in `from`; only the
    // raw payload names the group. It must not become a private chat.
    const raw = {
      id: 'g1',
      from: '77777777777@lid',
      body: 'Kal meeting hai',
      _data: { Info: { Chat: GROUP, Sender: '77777777777@lid', SenderAlt: '919782048273@s.whatsapp.net', PushName: 'Ravi' } },
    }
    const resolve = async () => {
      throw new Error('a group message must not be resolved to a private chat')
    }
    const payload = await normalizeBridgeAddressing(raw, resolve)
    expect(payload.from).toBe(GROUP)
    expect(payload.group).toEqual({ id: GROUP, senderId: '919782048273@s.whatsapp.net' })

    const out = translateBridgeInbound(ENV, payload, { groupName: 'Family (group)' })!
    expect(out.isGroup).toBe(true)
    expect(out.phone).toBe('')
    // The group is the contact, addressed by its chat id; no phone number.
    expect(out.message.from).toBeUndefined()
    expect(out.message.from_user_id).toBe(GROUP)
    expect(out.contact).toEqual({ user_id: GROUP, profile: { name: 'Family (group)' } })
    // The member's name leads the text.
    expect(out.message.text?.body).toBe('Ravi: Kal meeting hai')
  })

  it('keeps every member of one group in the same chat', async () => {
    const from = (sender: string, name: string, body: string) =>
      normalizeBridgeAddressing(
        { id: body, from: GROUP, participant: sender, body, _data: { pushName: name } },
        async () => null,
      )
    const a = translateBridgeInbound(ENV, await from('911111111111@c.us', 'Asha', 'one'))!
    const b = translateBridgeInbound(ENV, await from('922222222222@c.us', 'Bina', 'two'))!
    expect(a.message.from_user_id).toBe(GROUP)
    expect(b.message.from_user_id).toBe(GROUP)
    expect(a.message.text?.body).toBe('Asha: one')
    expect(b.message.text?.body).toBe('Bina: two')
    // No group name known: a plain label rather than a member's name.
    expect(a.contact.profile?.name).toBe('WhatsApp group')
  })

  it('names the member by phone when there is no display name, and on media captions', async () => {
    const payload = await normalizeBridgeAddressing(
      { id: 'm', from: GROUP, participant: '919782048273@c.us', body: 'photo', hasMedia: true, media: { url: 'https://bridge/f.jpg', mimetype: 'image/jpeg' } },
      async () => null,
    )
    const out = translateBridgeInbound(ENV, payload)!
    expect(out.message.type).toBe('image')
    expect(out.message.image?.caption).toBe('+919782048273: photo')
  })

  it('leaves private chats exactly as before', async () => {
    const payload = await normalizeBridgeAddressing({ id: 'p', from: '911234567890@c.us', body: 'hi' }, async () => null)
    expect(payload.group).toBeUndefined()
    const out = translateBridgeInbound(ENV, payload)!
    expect(out.isGroup).toBe(false)
    expect(out.message.from).toBe('911234567890')
    expect(out.message.text?.body).toBe('hi')
  })
})

describe('normalizeBridgeAddressing (linked ids)', () => {
  const never = async () => null

  it('uses SenderAlt from the raw payload for a customer message on a @lid chat', async () => {
    const out = await normalizeBridgeAddressing(
      {
        id: 'false_325@lid_A',
        from: '32598936015048@lid',
        fromMe: false,
        to: null as unknown as undefined,
        body: 'Hi',
        _data: { Info: { Chat: '32598936015048@lid', Sender: '32598936015048@lid', SenderAlt: '919782048273@s.whatsapp.net' } },
      },
      never,
    )
    expect(out.from).toBe('919782048273@c.us')
    expect(translateBridgeInbound(ENV, out)?.phone).toBe('+919782048273')
  })

  it('falls back to the bridge lookup when the raw payload has no alt', async () => {
    const calls: string[] = []
    const out = await normalizeBridgeAddressing(
      { id: 'x', from: '32598936015048@lid', fromMe: false, body: 'Hi' },
      async (lid) => {
        calls.push(lid)
        return '919782048273@c.us'
      },
    )
    expect(calls).toEqual(['32598936015048@lid'])
    expect(out.from).toBe('919782048273@c.us')
  })

  it('resolves the recipient of our own message from RecipientAlt or the chat lid', async () => {
    const viaAlt = await normalizeBridgeAddressing(
      { id: 'y', from: '32598936015048@lid', fromMe: true, body: 'Ok', _data: { Info: { Chat: '32598936015048@lid', RecipientAlt: '919782048273@s.whatsapp.net' } } },
      never,
    )
    expect(viaAlt.to).toBe('919782048273@c.us')
    const viaLookup = await normalizeBridgeAddressing(
      { id: 'z', from: '32598936015048@lid', fromMe: true, body: 'Ok' },
      async () => '919782048273@c.us',
    )
    expect(viaLookup.to).toBe('919782048273@c.us')
    expect(translateBridgeEcho(ENV, viaLookup)?.phone).toBe('+919782048273')
  })

  it('leaves phone-addressed payloads untouched and unresolvable lids skipped', async () => {
    const same = await normalizeBridgeAddressing({ id: 'p', from: '911234567890@c.us', body: 'hi' }, never)
    expect(same.from).toBe('911234567890@c.us')
    const unknown = await normalizeBridgeAddressing({ id: 'q', from: '1@lid', body: 'hi' }, never)
    expect(translateBridgeInbound(ENV, unknown)).toBeNull()
  })
})

describe('bridge message id helpers', () => {
  it('parses WAHA ids and re-addresses them to another chat', async () => {
    const { parseBridgeMessageId, bridgeMessageIdWithChat } = await import('./bridge-webhook')
    expect(parseBridgeMessageId('true_32598936015048@lid_3EB084348C0DDEE9E3B768')).toEqual({
      fromMe: true,
      chat: '32598936015048@lid',
      rest: '3EB084348C0DDEE9E3B768',
    })
    expect(
      bridgeMessageIdWithChat('true_32598936015048@lid_3EB084348C0DDEE9E3B768', '919782048273@c.us'),
    ).toBe('true_919782048273@c.us_3EB084348C0DDEE9E3B768')
    expect(parseBridgeMessageId('wamid.HBgM')).toBeNull()
    expect(bridgeMessageIdWithChat('garbage', 'x@c.us')).toBeNull()
  })
})
