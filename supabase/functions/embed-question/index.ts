import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { getAuthenticatedUser } from '../_shared/auth.ts'

Deno.serve(async (req) => {
  // CORS preflight: the browser asks permission before sending the real request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  // Only logged-in users may spend our OpenAI credits
  const user = await getAuthenticatedUser(req)
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  try {
    const { question } = await req.json()
    if (typeof question !== 'string' || question.trim() === '') {
      return jsonResponse({ error: 'A non-empty "question" string is required' }, 400)
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) {
      return jsonResponse({ error: 'OPENAI_API_KEY secret is not set' }, 500)
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: question,
      }),
    })

    if (!openaiResponse.ok) {
      const detail = await openaiResponse.text()
      console.error('OpenAI error:', openaiResponse.status, detail)
      return jsonResponse({ error: 'Failed to get embedding from OpenAI' }, 502)
    }

    const result = await openaiResponse.json()
    return jsonResponse({ embedding: result.data[0].embedding })
  } catch (err) {
    console.error('embed-question failed:', err)
    return jsonResponse({ error: 'Bad request' }, 400)
  }
})
