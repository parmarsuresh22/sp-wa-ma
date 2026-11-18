# Several WhatsApp numbers per account ("channels")

Since migration `061_channels.sql` an account can talk through more than
one WhatsApp number. Each number is a **channel**: a row of
`whatsapp_config` with a `provider`.

| provider | What it is | Templates / broadcasts | Buttons & lists | Inbound |
|---|---|---|---|---|
| `meta` | A WhatsApp Business API number (Meta Cloud API). The only kind that existed before 061. | Yes | Native | Meta webhook (`/api/whatsapp/webhook`) |
| `waha` | A WhatsApp Web session running on a [WAHA](https://waha.devlike.pro) bridge you host. Any normal WhatsApp number, paired by QR code. | **No** (refused) | Rendered as a numbered text list; a typed `2` or the label is mapped back to the option | Bridge webhook (`/api/whatsapp/bridge/webhook/<channel id>`) |

Everything above the transport — contacts, conversations, Flows,
automations, the AI auto-reply, the public API and webhooks — is shared.
A bot you build runs identically on every number.

## How threads and replies work

- One conversation per **contact per channel**. A customer who writes to
  two of your numbers has two threads, each badged with its number.
- A reply always leaves from the number the thread runs on. Nothing in
  the UI lets an agent answer a thread from a different number.
- Each account has exactly one **default channel** (the star in
  Settings → WhatsApp). It is used when a send names no channel: the
  public API without `channel_id`, "send template" from a contact's
  page, a thread created before 061, or a thread whose channel was
  removed.
- Removing a channel keeps its conversations and their history; they
  fall back to the default channel for new replies.

## Inbox

When the account has more than one number, the conversation list grows a
**number dropdown** next to the status filter ("All numbers" or one
number) and each row shows a small badge with the number's name. The
choice is remembered per browser, so every agent comes back to the
number they were working on.

## Settings → WhatsApp

The panel lists the account's numbers. Pick one to manage it.

- **Add Business API number** opens the familiar Meta form (phone number
  id, WABA id, token, verify token, PIN). Saving it creates a new channel.
  Numbers under the same WABA share one template catalogue; a number
  under another WABA needs its own "Sync from Meta".
- **Link WhatsApp Web** asks for your WAHA bridge URL and API key the
  first time only; later numbers just need a name and reuse the saved
  bridge. After a "Know the limits" confirmation it creates a session on
  the bridge with a webhook pointing back at this deployment and shows
  the QR code to scan from the phone (WhatsApp → Linked devices). Codes
  rotate every 20 seconds; the page refreshes them. Once the session
  reports `WORKING` the channel is connected. The bridge address and key
  are never shown in the UI or sent to the browser afterwards.
- The ⋯ menu on a channel offers **Rename**, **Make default** and
  **Remove**. A bridge channel also has Start / Restart / Unlink
  controls for its session.

## Working on one number

The inbox, dashboard and contacts page share one **number dropdown**.
Pick a number in any of them and all three show only that number's
threads, figures and people; "All numbers" shows everything. The choice
is remembered per browser.

Work can be pinned to a number too (migration 062). Everything defaults
to "All numbers", so nothing already built changes until you pick one:

- **Flows** — "Runs on number" in the flow's trigger panel. A pinned
  flow only starts for messages that arrive on that number.
- **Automations** — the number picker in the builder header. A pinned
  automation only fires for events on that number. Events that carry no
  number (a contact created through the API, a schedule) fire only
  unpinned automations.
- **AI agent** — "Auto-reply on" in Settings → AI Assistant. The bot
  only answers on that number; drafting in the inbox and the Playground
  work everywhere.

Removing a number unpins whatever was pinned to it.

## Running the WAHA bridge

WAHA is a Docker container that keeps a WhatsApp Web session open and
exposes it over HTTP. Since release 2026.6 every former paid feature,
including unlimited sessions and media download, is free in the Core
image.

```bash
docker run -d --name waha --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v waha-sessions:/app/.sessions \
  -v waha-media:/app/.media \
  -e WAHA_API_KEY=<a long random string> \
  -e WHATSAPP_DEFAULT_ENGINE=GOWS \
  -e WAHA_BASE_URL=https://waha.example.com \
  -e WAHA_EVENTS_DOWNLOAD_MEDIA=true \
  devlikeapro/waha:latest
```

Then put it behind your reverse proxy with TLS (nginx, Caddy) at
`https://waha.example.com`. That URL and the API key are what you enter
in **Link WhatsApp Web**. The bridge must be able to reach your wacrm
deployment, and wacrm must be able to reach the bridge: both calls go
over the public internet.

- `WAHA_BASE_URL` is what the bridge puts in media download links it
  sends to wacrm; it must be the public URL.
- `WAHA_EVENTS_DOWNLOAD_MEDIA=true` makes the bridge fetch attachments so
  wacrm can mirror them into `chat-media`. Without it, inbound
  attachments arrive as a text placeholder.
- The session store volume (`/app/.sessions`) is the WhatsApp Web login.
  Losing it means scanning the QR code again; nothing in wacrm is
  affected.

wacrm creates one session per channel on the bridge, named `wacrm-xxxx`,
and configures that session's webhook itself (`message`, `message.any`,
`message.ack`, `session.status`, signed with a per-channel HMAC key). You
do not need to set `WHATSAPP_HOOK_URL` on the container. If you set
`NEXT_PUBLIC_SITE_URL` on wacrm, that origin is used for the webhook URL;
otherwise the request's forwarded host is. **Make sure that variable is
your real address or unset** — a placeholder such as
`https://crm.example.com` sends every inbound message into the void. The
channel panel compares the bridge's webhook with the expected address on
every status check and shows a "Bridge is posting to the wrong address"
warning with a **Fix webhook** button when they differ.

## Security

- The bridge API key is stored encrypted (AES-256-GCM) in
  `whatsapp_config.access_token`, exactly like a Meta token.
- Every webhook POST from the bridge carries `X-Webhook-Hmac` (sha512
  over the raw body) with a key wacrm generated when the session was
  created. An unknown channel, a missing key or a bad signature is
  answered 401 and ignored.
- Only account admins can add, rename, re-default or remove channels.
  Every member can read the list (the inbox needs it).

## Public API

- `POST /api/v1/messages` and `POST /api/v1/broadcasts` accept an
  optional `channel_id`. Omitted → the account's default channel
  (broadcasts: the default **Meta** channel).
- Templates on a bridge channel answer `400 unsupported_on_channel`.
- Message ids on bridge channels look like `true_<chat>@c.us_<id>`
  rather than `wamid.…`; `reply_to_whatsapp_message_id` accepts either.

## Limits of WhatsApp Web channels

They are unofficial. WhatsApp can suspend numbers that behave like
bulk senders, so templates do not exist on them and a broadcast from one
is a plain message sent one per second to at most 25 recipients per
request, behind a warning. They are meant for conversational support. Messages the owner types on the
phone itself show up in the inbox as agent messages (no sender), so the
thread reads the way the customer sees it. Reactions, read receipts,
typing indicators and quoted replies work.
