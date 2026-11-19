// ============================================================
// Resolve (or create) the conversation for a phone number.
//
// The dashboard composer always has a `conversation_id` in hand. The
// public API doesn't — an external automation knows a *phone number*,
// not an internal UUID. This helper bridges that: given an E.164
// phone, it finds-or-creates the contact and its conversation so the
// shared `sendMessageToConversation` core can run unchanged.
//
// It deliberately reuses the exact find-or-create logic the inbound
// webhook uses (the `findExistingContact` dedupe helper, the
// one-conversation-per-(account, contact) convention, the
// account_id-tenancy / user_id-audit split) so a contact created via
// the API is indistinguishable from one created by an inbound message.
//
// Audit user: created rows need a NOT NULL `user_id`. As with the
// webhook (where there's no logged-in human either), we attribute
// them to the WhatsApp config owner — a stable account-level default.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { resolveSendChannel } from '@/lib/whatsapp/channels';

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  /** The channel (whatsapp_config row) the conversation runs on. */
  channelId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
  conversationCreated: boolean;
}

/**
 * Find or create the contact + conversation for `phone` within
 * `accountId`, on `channelId` (or the account's default channel).
 * Throws `SendMessageError` (shared with the send core, so the route
 * maps one error family) on a bad phone, a missing WhatsApp config, an
 * unknown channel, or a DB failure.
 */
export async function resolveConversationByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string,
  name?: string | null,
  channelId?: string | null
): Promise<ResolvedConversation> {
  // Raw integrator input: the leading `+` is required so the country
  // code is explicit — "4155551212" would otherwise be delivered to
  // Switzerland, not the US (issue #586).
  const sanitized = parseInternationalPhone(phone);
  if (!sanitized) {
    throw new SendMessageError(
      'bad_request',
      "'to' must be an international phone number with a leading + and country code (e.g. +14155550123)",
      400
    );
  }

  // Fail fast (and create nothing) when the account has no WhatsApp
  // connected, or names a channel it does not own — the same errors
  // the send would raise anyway.
  const channel = await resolveSendChannel(db, accountId, { channelId });
  if (!channel) {
    throw new SendMessageError(
      channelId ? 'channel_not_found' : 'whatsapp_not_configured',
      channelId
        ? 'channel_id does not name a WhatsApp number on this account'
        : 'WhatsApp not configured. Please set up your WhatsApp integration first.',
      channelId ? 404 : 400
    );
  }

  // Audit user for created rows = the single account-wide default used
  // by every public-API write (see resolveAuditUserId), so a contact
  // created here is attributed identically to one created via
  // POST /api/v1/contacts. resolveAuditUserId throws ContactError only
  // if the owner can't be resolved — remap it to the send error family
  // the callers already handle.
  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        phone: sanitized,
        name: name || sanitized,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      // Lost a race against a concurrent inbound/API create — the
      // unique index (migration 022) rejected the duplicate. Re-resolve.
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendMessageError(
            'db_error',
            'Failed to create contact',
            500
          );
        }
      } else {
        console.error(
          '[resolve-conversation] contact create error:',
          createErr
        );
        throw new SendMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact, channel) — same convention
  // as the webhook. Order oldest-first and take one row rather than
  // `.maybeSingle()`, which errors on ≥2 rows: if duplicates predate the
  // unique index (migration 036/061), we resolve to the canonical
  // survivor instead of falling through and creating yet another
  // (issue #363).
  const conversation = await findOrCreateConversationRow(
    db,
    accountId,
    contactId,
    ownerUserId,
    channel.id
  );

  return {
    conversationId: conversation.id,
    contactId,
    channelId: channel.id,
    contactCreated,
    conversationCreated: conversation.created,
  };
}

/**
 * Find (oldest-first) or create the single conversation for
 * `(accountId, contactId, channelId)`. Handles the unique-index race
 * the same way the inbound webhook does: on a 23505 from a concurrent
 * create, re-resolve the winning row rather than failing the send.
 *
 * A thread created before migration 061 has `channel_id IS NULL`; it
 * is adopted (and stamped) rather than duplicated when the account's
 * channel is looked up, so existing inboxes do not fork on upgrade.
 */
export async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string,
  channelId: string
): Promise<{ id: string; created: boolean }> {
  const lookup = async () => {
    const { data, error } = await db
      .from('conversations')
      .select('id, channel_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .or(`channel_id.eq.${channelId},channel_id.is.null`)
      // The number's own thread first; a thread left without a number
      // (its number was removed) is only adopted when there is no own one.
      .order('channel_id', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      console.error('[resolve-conversation] conversation lookup error:', error);
      throw new SendMessageError('db_error', 'Failed to resolve conversation', 500);
    }
    type Row = { id: string; channel_id?: string | null };
    const rows: Row[] = Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];
    return rows[0] ?? null;
  };

  const existing = await lookup();
  if (existing) {
    if (!existing.channel_id) {
      await db
        .from('conversations')
        .update({ channel_id: channelId })
        .eq('id', existing.id)
        .is('channel_id', null);
    }
    return { id: existing.id, created: false };
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel_id: channelId,
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const raced = await lookup();
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[resolve-conversation] conversation create error:', convErr);
    throw new SendMessageError('db_error', 'Failed to create conversation', 500);
  }

  return { id: newConv.id, created: true };
}
