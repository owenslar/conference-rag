import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getAuthenticatedUser } from '../_shared/auth.ts'
import { embedText } from '../_shared/openai.ts'

interface Candidate {
  talk_id: string
  title: string
  speaker: string
  text: string
  similarity: number
  url: string
}

const RETRIEVE_COUNT = 40 // sentences pulled from the vector search
const MAX_PER_TALK = 3 // keeps one talk from dominating the candidates
const MAX_CANDIDATES = 24
const MAX_TOPIC_CHARS = 300

const SYSTEM_PROMPT = `You help someone outline a short talk in the style of a General Conference address.
You will receive a TOPIC and a numbered list of CANDIDATE QUOTES taken verbatim from real talks.

Produce a barebones outline with exactly these five sections, in this order:
1. Opening
2. Foundation (a scriptural or doctrinal anchor)
3. Main Point
4. Application (a story or personal example to include)
5. Closing & Invitation

For each section give a short heading and 1-2 sentences of guidance on what to write.
Attach quotes ONLY by their candidate number, in "quote_ids". Choose 0-2 quotes per section, only when
a quote genuinely fits that section. Never reuse a quote across sections. Never write quote text yourself.`

// Strict JSON schema: the model must return exactly this shape.
const OUTLINE_SCHEMA = {
  name: 'talk_outline',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['talk_title', 'sections'],
    properties: {
      talk_title: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'guidance', 'quote_ids'],
          properties: {
            heading: { type: 'string' },
            guidance: { type: 'string' },
            quote_ids: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
    },
  },
}

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
    const { topic } = await req.json()
    if (typeof topic !== 'string' || topic.trim() === '') {
      return jsonResponse({ error: 'A non-empty "topic" string is required' }, 400)
    }
    if (topic.length > MAX_TOPIC_CHARS) {
      return jsonResponse({ error: `Topic must be ${MAX_TOPIC_CHARS} characters or fewer` }, 400)
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return jsonResponse({ error: 'OPENAI_API_KEY secret is not set' }, 500)
    }

    // Database client that acts AS THE USER (forwards their JWT), so RLS still applies.
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    )

    // 1. Embed the topic
    const embedding = await embedText(topic, apiKey)

    // 2. Retrieve similar sentences (most similar first)
    const { data: matches, error: matchError } = await db.rpc('match_sentences', {
      query_embedding: embedding,
      match_count: RETRIEVE_COUNT,
    })
    if (matchError) {
      console.error('match_sentences failed:', matchError)
      return jsonResponse({ error: 'Database search failed' }, 500)
    }

    // 3. Diversify: at most MAX_PER_TALK sentences per talk
    const perTalk = new Map<string, number>()
    const picked: Omit<Candidate, 'url'>[] = []
    for (const m of matches ?? []) {
      const n = perTalk.get(m.talk_id) ?? 0
      if (n >= MAX_PER_TALK) continue
      perTalk.set(m.talk_id, n + 1)
      picked.push(m)
      if (picked.length >= MAX_CANDIDATES) break
    }

    if (picked.length === 0) {
      return jsonResponse({ error: 'No related talks found for that topic' }, 404)
    }

    // 4. match_sentences doesn't return URLs, so look them up (one row per talk)
    const talkIds = [...new Set(picked.map((p) => p.talk_id))]
    const { data: urlRows } = await db
      .from('sentence_embeddings')
      .select('talk_id, url')
      .in('talk_id', talkIds)
      .eq('sentence_num', 1)
    const urlByTalk = new Map<string, string>((urlRows ?? []).map((r) => [r.talk_id, r.url]))

    const candidates: Candidate[] = picked.map((p) => ({ ...p, url: urlByTalk.get(p.talk_id) ?? '' }))

    // 5. Ask GPT-4o for the outline, referring to quotes by number only
    const candidateList = candidates
      .map((c, i) => `[${i + 1}] "${c.text}" — ${c.speaker}, "${c.title}"`)
      .join('\n')

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.4,
        response_format: { type: 'json_schema', json_schema: OUTLINE_SCHEMA },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `TOPIC: ${topic}\n\nCANDIDATE QUOTES:\n${candidateList}` },
        ],
      }),
    })

    if (!openaiResponse.ok) {
      console.error('OpenAI error:', openaiResponse.status, await openaiResponse.text())
      return jsonResponse({ error: 'Failed to generate outline from OpenAI' }, 502)
    }

    const completion = await openaiResponse.json()
    const outline = JSON.parse(completion.choices[0].message.content)

    // 6. Swap quote numbers for the verbatim database text. Unknown/duplicate ids are dropped,
    //    so the model can never put words in a speaker's mouth.
    const used = new Set<number>()
    const sections = outline.sections.map((s: { heading: string; guidance: string; quote_ids: number[] }) => ({
      heading: s.heading,
      guidance: s.guidance,
      quotes: s.quote_ids
        .filter((id) => Number.isInteger(id) && id >= 1 && id <= candidates.length && !used.has(id))
        .map((id) => {
          used.add(id)
          const c = candidates[id - 1]
          return { text: c.text, speaker: c.speaker, title: c.title, url: c.url, similarity: c.similarity }
        }),
    }))

    return jsonResponse({ talk_title: outline.talk_title, sections })
  } catch (err) {
    console.error('generate-talk-outline failed:', err)
    return jsonResponse({ error: 'Failed to generate outline' }, 500)
  }
})
