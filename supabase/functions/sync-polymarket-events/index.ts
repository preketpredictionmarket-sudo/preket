import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

Deno.serve(() => new Response(
  JSON.stringify({ ok: false, error: 'This endpoint is retired. The active Polymarket sync runs through the Vercel cron route.' }),
  { status: 410, headers: { 'content-type': 'application/json' } }
))
