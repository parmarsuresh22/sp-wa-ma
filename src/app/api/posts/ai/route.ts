import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError } from '@/lib/ai/types'
import { accountMediaPath, MAX_CAPTION_LENGTH } from '@/lib/posts/post'
import { aiImage } from '@/lib/posts/ai-image'
import { isPostImageMime, readAccountImage, storeAccountImage } from '@/lib/posts/publish'

// Image models routinely take 20–40 s.
export const maxDuration = 60

const CAPTION_SYSTEM_PROMPT = [
  'You write short social-media posts for a business: a WhatsApp Status and a message broadcast to its customers.',
  'Write one post, ready to publish. Keep it under 500 characters, warm and clear, in the language the request is written in.',
  'A few fitting emoji are fine. No hashtags unless asked. Never invent prices, dates, offers or facts that the request does not give you.',
  'Do not add a phone number or a link: a "chat with us on WhatsApp" line is appended automatically.',
  'Output only the post text — no quotes, no title, no explanation.',
].join(' ')

/**
 * POST /api/posts/ai   (agent+)
 *
 *   { mode: 'caption', prompt: string, current?: string }
 *       → { caption }           write or rewrite the post text
 *   { mode: 'image', prompt: string, media_url?: string }
 *       → { media_url, media_mime }   edit that image, or create one
 *
 * Runs on the account's own AI key (Settings → AI agent). Captions work
 * with every provider; images need a Gemini or OpenAI key.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const mode = body?.mode
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : ''
    if (mode !== 'caption' && mode !== 'image') {
      return NextResponse.json({ error: "mode must be 'caption' or 'image'" }, { status: 400 })
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[posts/ai] loadAiConfig error:', err)
      throw new AiError('The saved AI key could not be read. Save it again in Settings → AI agent.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'Set up and switch on the AI agent first (AI Agent in the menu) — posts use its API key.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    if (mode === 'caption') {
      const current = typeof body?.current === 'string' ? body.current.trim().slice(0, MAX_CAPTION_LENGTH) : ''
      if (!prompt && !current) {
        return NextResponse.json({ error: 'Say what the post is about' }, { status: 400 })
      }
      const ask = [
        prompt ? `What the post is about / what to do: ${prompt}` : 'Improve this post.',
        current ? `Current text of the post:\n${current}` : '',
        config.systemPrompt?.trim()
          ? `About the business (for tone and facts):\n${config.systemPrompt.trim().slice(0, 1500)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')

      const { text, usage } = await generateReply({
        config,
        systemPrompt: CAPTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: ask }],
      })
      try {
        void logAiUsage(supabaseAdmin(), {
          accountId,
          conversationId: null,
          mode: 'draft',
          provider: config.provider,
          model: config.model,
          usage,
        })
      } catch (logErr) {
        console.error('[posts/ai] usage log skipped:', logErr)
      }
      return NextResponse.json({ caption: text.slice(0, MAX_CAPTION_LENGTH) })
    }

    // mode === 'image'
    if (!prompt) {
      return NextResponse.json(
        { error: 'Describe the change you want, or the image to create' },
        { status: 400 },
      )
    }
    const db = supabaseAdmin()
    let source: { bytes: Buffer; mime: string } | null = null
    if (typeof body?.media_url === 'string' && body.media_url) {
      const path = accountMediaPath(body.media_url, process.env.NEXT_PUBLIC_SUPABASE_URL, accountId)
      if (!path) return NextResponse.json({ error: 'Upload the image again' }, { status: 400 })
      source = await readAccountImage(db, path)
    }

    const out = await aiImage(config, { instruction: prompt, image: source })
    if (!isPostImageMime(out.mime)) {
      return NextResponse.json(
        { error: `The AI returned an image type that cannot be posted (${out.mime})` },
        { status: 502 },
      )
    }
    const stored = await storeAccountImage(db, accountId, out, 'ai-image')
    return NextResponse.json({ media_url: stored.url, media_mime: stored.mime, model: out.model })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    if (err instanceof Error && !('status' in err)) {
      console.error('[posts/ai] failed:', err)
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    return toErrorResponse(err)
  }
}
