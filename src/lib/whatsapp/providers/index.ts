import { decrypt } from '@/lib/whatsapp/encryption'
import type { ChannelRow } from '@/lib/whatsapp/channels'
import { createMetaSender } from './meta'
import { wahaSenderFromChannel } from './waha'
import type { ChannelSender } from './types'

export * from './types'
export { createMetaSender } from './meta'
export {
  createWahaClient,
  createWahaSender,
  WahaError,
  normalizeBridgeBaseUrl,
  toWahaChatId,
  chatIdToPhone,
  isGroupChatId,
  extractWahaMessageId,
  type WahaClient,
  type WahaSessionInfo,
} from './waha'

/**
 * The sender for a channel row. Decrypts the stored credential and
 * picks the transport. Throws if the row is malformed (should be
 * impossible under the 061 CHECK constraint, but the message is
 * clearer than a null deref).
 */
export function senderForChannel(channel: ChannelRow): ChannelSender {
  const credential = decrypt(channel.access_token)
  if (channel.provider === 'waha') {
    return wahaSenderFromChannel(channel, credential)
  }
  if (!channel.phone_number_id) {
    throw new Error('Meta channel is missing its phone_number_id')
  }
  return createMetaSender({
    channelId: channel.id,
    phoneNumberId: channel.phone_number_id,
    accessToken: credential,
  })
}
