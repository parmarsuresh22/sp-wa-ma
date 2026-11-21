// The languages an assistant can be told to answer in — used by the AI
// agent's settings and the appointment settings alike. Pure data.

/**
 * Languages the assistant can be told to answer in. The value is what
 * the model is told; the key is what is stored.
 */
export const REPLY_LANGUAGES: Record<string, string> = {
  english: 'English',
  hindi: 'Hindi (Devanagari script)',
  hinglish: 'Hinglish (Hindi written in English letters)',
  gujarati: 'Gujarati',
  marathi: 'Marathi',
  punjabi: 'Punjabi',
  bengali: 'Bengali',
  tamil: 'Tamil',
  telugu: 'Telugu',
  kannada: 'Kannada',
  malayalam: 'Malayalam',
  odia: 'Odia',
  assamese: 'Assamese',
  urdu: 'Urdu',
  nepali: 'Nepali',
  arabic: 'Arabic',
  spanish: 'Spanish',
  portuguese: 'Portuguese',
  french: 'French',
}

/** The stored value: a key of REPLY_LANGUAGES, or 'auto'. */
export function cleanReplyLanguage(value: unknown): string {
  return typeof value === 'string' && value in REPLY_LANGUAGES ? value : 'auto'
}
