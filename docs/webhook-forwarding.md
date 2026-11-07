# Forwarding Meta webhooks to another receiver (n8n, Make, a custom bot)

Meta allows **one callback URL per Meta App**. If something else already
receives the WhatsApp webhook — typically an n8n **WhatsApp Trigger**
node — pointing Meta at wacrm would cut that receiver off.

Instead of creating a second Meta App, let wacrm own the callback URL
and relay every delivery onward. wacrm re-POSTs the **exact bytes** Meta
sent together with Meta's own `X-Hub-Signature-256` header, so a
receiver that verifies Meta's signature against the same App Secret
keeps accepting the request unchanged. No edits to the n8n workflow are
needed; the trigger node keeps firing with Meta's native payload.

## Setup

1. In your Meta App → **WhatsApp → Configuration**, change the callback
   URL from the old receiver to
   `https://<your wacrm host>/api/whatsapp/webhook`, with the verify
   token you saved in wacrm's **Settings → WhatsApp connection**. Keep
   the `messages` field subscribed.
2. `META_APP_SECRET` stays set to this same app's secret — wacrm uses it
   to verify the delivery before relaying anything.
3. Set the target URL(s) in the server environment:

   ```
   WEBHOOK_FORWARD_URL=https://n8n.example.com/webhook/<trigger-id>/webhook
   ```

   For an n8n WhatsApp Trigger, copy the **Production URL** from the
   node's Webhook URLs panel. Several receivers: comma-separate them.
4. Restart wacrm.

wacrm must be reachable from the internet over HTTPS (Meta calls it).
The forward target may be anywhere wacrm can reach, including a private
network.

## Behaviour

- The relay runs **after** Meta's signature has been verified and
  **after** Meta has been acknowledged with `200`, concurrently with
  wacrm's own inbox processing. A slow or failing receiver never delays
  the inbox, and a wacrm processing error never stops the relay.
- Only `Content-Type` and `X-Hub-Signature-256` are copied to the
  outbound request; the body is untouched.
- One attempt per target, 10 s timeout, redirects are not followed.
  Non-2xx responses and network errors are logged as
  `[webhook-forward] …` and otherwise ignored. There is no retry queue:
  if the receiver is down the event is lost for that receiver (wacrm
  itself still has it).
- Meta's `GET` verification handshake is answered by wacrm; the
  receiver never needs to see it.
- Unset or empty `WEBHOOK_FORWARD_URL` disables the relay entirely.

## Limitations to be aware of

- Messages the other receiver **sends** (e.g. n8n bot replies via the
  Meta API) go straight to Meta and do **not** appear in the wacrm
  inbox. Meta's delivery/read status callbacks for those messages are
  delivered to the webhook, but wacrm has no matching row and skips
  them. To see bot replies in the inbox the receiver would have to send
  through wacrm's public API (`POST /api/v1/messages`) instead.
- Turn off wacrm's AI auto-reply bot if the other receiver already
  answers customers, otherwise customers get two replies.
- Code lives in `src/lib/whatsapp/webhook-forward.ts` and is called
  from `src/app/api/whatsapp/webhook/route.ts`.
