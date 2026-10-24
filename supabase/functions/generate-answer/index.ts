import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getAuthenticatedUser } from '../_shared/auth.ts'

interface ContextTalk {
  title: string
  speaker: string
  text: string
}

// Keep each talk under a cap so a few long talks can't blow past the model's context window
const MAX_CHARS_PER_TALK = 20000

const SYSTEM_PROMPT = `You answer questions about General Conference talks.
Use ONLY the talks provided in the user's message as your source material.
- Cite the talks you draw from by title and speaker, e.g. (Title, Speaker).
- If the talks do not contain enough information to answer, say so plainly instead of guessing.
- Do not invent quotes or attribute statements to speakers that are not in the provided text.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const user = await getAuthenticatedUser(req)
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  try {
    const { question, context_talks } = await req.json()

    if (typeof question !== 'string' || question.trim() === '') {
      return jsonResponse({ error: 'A non-empty "question" string is required' }, 400)
    }
    if (!Array.isArray(context_talks)) {
      return jsonResponse({ error: '"context_talks" must be an array' }, 400)
    }

    // The site's readiness check sends an empty context. Nothing to ground an answer in,
    // so skip the (paid) GPT-4o call.
    if (context_talks.length === 0) {
      return jsonResponse({ answer: 'No relevant talks were provided, so I cannot answer yet.' })
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return jsonResponse({ error: 'OPENAI_API_KEY secret is not set' }, 500)
    }

    const context = (context_talks as ContextTalk[])
      .map((talk, i) =>
        `--- Talk ${i + 1} ---\nTitle: ${talk.title}\nSpeaker: ${talk.speaker}\n\n${
          String(talk.text ?? '').slice(0, MAX_CHARS_PER_TALK)
        }`
      )
      .join('\n\n')

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Talks:\n\n${context}\n\nQuestion: ${question}` },
        ],
      }),
    })

    if (!openaiResponse.ok) {
      const detail = await openaiResponse.text()
      console.error('OpenAI error:', openaiResponse.status, detail)
      return jsonResponse({ error: 'Failed to generate answer from OpenAI' }, 502)
    }

    const result = await openaiResponse.json()
    return jsonResponse({ answer: result.choices[0].message.content })
  } catch (err) {
    console.error('generate-answer failed:', err)
    return jsonResponse({ error: 'Bad request' }, 400)
  }
})
