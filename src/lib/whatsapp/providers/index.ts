import { decrypt } from '@/lib/whatsapp/encryption'
import type { ChannelRow } from '@/lib/whatsapp/channels'
import { createMetaSender } from './meta'
import { wahaSenderFromChannel } from './waha'
import type { ChannelSender } from './types'
import { AccountBlockedSendError, accountIsBlocked } from '@/lib/auth/blocked-server'

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
  return refusingWhenBlocked(rawSenderForChannel(channel), channel.account_id)
}

function rawSenderForChannel(channel: ChannelRow): ChannelSender {
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

/**
 * Nothing leaves a number of a blocked account (migration 085): every
 * send first looks the account up and refuses. This is the one door
 * all replies, automations, flows, reminders and wishes go through, so
 * the stop holds whichever of them tries.
 */
function refusingWhenBlocked(sender: ChannelSender, accountId: string | null | undefined): ChannelSender {
  const check = async () => {
    if (await accountIsBlocked(accountId)) throw new AccountBlockedSendError()
  }
  return {
    provider: sender.provider,
    channelId: sender.channelId,
    capabilities: sender.capabilities,
    sendText: async (args) => (await check(), sender.sendText(args)),
    sendMedia: async (args) => (await check(), sender.sendMedia(args)),
    sendInteractive: async (args) => (await check(), sender.sendInteractive(args)),
    sendTemplate: async (args) => (await check(), sender.sendTemplate(args)),
    sendReaction: async (args) => (await check(), sender.sendReaction(args)),
    markReadAndTyping: async (args) => (await check(), sender.markReadAndTyping(args)),
    markRead: async (args) => (await check(), sender.markRead(args)),
  }
}
