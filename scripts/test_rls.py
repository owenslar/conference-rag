from supabase import create_client
import json

with open('config.public.json') as f:
    public = json.load(f)

# Connect with the ANON key (not service key!)
client = create_client(public['SUPABASE_URL'], public['SUPABASE_ANON_KEY'])

# This works — page_views has a public SELECT policy
result = client.table('page_views').select('*').limit(5).execute()
print(f"page_views: {len(result.data)} rows ✅")

# This returns nothing — sentence_embeddings requires authentication
result = client.table('sentence_embeddings').select('*').limit(5).execute()
print(f"sentence_embeddings: {len(result.data)} rows (expected: 0) 🔒")