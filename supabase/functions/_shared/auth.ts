import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// We deploy with --no-verify-jwt, so the platform does NOT check the token for us.
// Instead we read the JWT from the Authorization header and ask Supabase Auth
// whether it belongs to a real, logged-in user.
// Returns the user on success, or null if the request is not authenticated.
export async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null

  const token = authHeader.replace('Bearer ', '')

  // SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically into every Edge Function.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
  )

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}
