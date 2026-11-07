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

## If the Meta App's callback URL keeps reverting

An n8n **WhatsApp Trigger** node is not a passive receiver. Its
credential holds the Meta App ID and App Secret, and every time its
workflow is activated or n8n restarts it calls
`POST /{app-id}/subscriptions` and sets the app's callback URL back to
its own address. Whatever you type in the Meta dashboard is overwritten
the next time that happens.

Meta's answer to this is a **WABA-level alternate callback URL**. It is
set on the WhatsApp Business Account rather than on the app, and Meta
delivers the WABA's `messages` webhooks there in preference to the
app-level URL, so the n8n node can rewrite the app setting as often as
it likes without effect.

Set it in the server environment and re-save the WhatsApp connection
once:

```
META_WEBHOOK_OVERRIDE_URL=https://<your wacrm host>/api/whatsapp/webhook
```

On every save of **Settings → WhatsApp connection**, wacrm now passes
this URL together with the verify token as `override_callback_uri` on
its `subscribed_apps` call. Meta validates it with the usual `GET`
handshake against wacrm, so the verify token you saved in wacrm is the
one that is used. The value must be public `https://` and at most 200
characters; anything else is ignored with a warning in the server log.

Keep the variable set once you rely on it: Meta documents that a
`subscribed_apps` call **without** these parameters clears the override,
and wacrm makes that plain call whenever the variable is absent.

To confirm it is in place, call Meta with the same System User token
wacrm uses and look for `override_callback_uri` in the result:

```
GET https://graph.facebook.com/v22.0/<WABA_ID>/subscribed_apps
```

The override covers message and status webhooks. Template and account
level webhooks always go to the app-level URL; wacrm reads those too, so
if you need them, leave the app-level URL pointing at wacrm when you can.

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
