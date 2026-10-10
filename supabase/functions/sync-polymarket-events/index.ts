import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

type Market = {
  id?: string
  question: string
  conditionId: string
  closed: boolean
  active: boolean
  outcomes: string
  outcomePrices: string
  volume?: string | number
  liquidity?: string | number
  updatedAt?: string
}
type SourceEvent = {
  id: string
  title: string
  description?: string
  category?: string
  active: boolean
  closed: boolean
  volume?: number | string
  liquidity?: number | string
  updatedAt?: string
  markets: Market[]
}
type Candidate = { market: Market; yes: number; no: number; title: string }
const CRON_TOKEN = 'PREKET-NIGHTLY-SYNC-1155-BDT-2026'
const GAMMA = 'https://gamma-api.polymarket.com'
const PAGE_SIZE = 100
const KEYSET_PAGE_SIZE = 50
const CURSOR_KEY = 'polymarket_cursor'

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}
function parseMarket(m: Market, eventTitle: string): Candidate | null {
  try {
    const outcomes: string[] = JSON.parse(m.outcomes)
    const prices: number[] = JSON.parse(m.outcomePrices).map(Number)
    if (outcomes.length !== prices.length || prices.some(p => !Number.isFinite(p))) return null
    if (outcomes.length === 2) {
      const yi = outcomes.findIndex(x => x.toLowerCase() === 'yes')
      const ni = outcomes.findIndex(x => x.toLowerCase() === 'no')
      if (yi >= 0 && ni >= 0) return { market: m, yes: prices[yi], no: prices[ni], title: m.question || eventTitle }
    }
    if (outcomes.length >= 2) {
      const ranked = outcomes.map((outcome, i) => ({ outcome, price: prices[i] })).sort((a, b) => b.price - a.price)
      return { market: m, yes: ranked[0].price, no: ranked[1].price, title: `Will ${ranked[0].outcome} win? (from: ${eventTitle})` }
    }
  } catch { /* malformed source market */ }
  return null
}
function chooseCandidate(event: SourceEvent, conditionId?: string | null): Candidate | null {
  const markets = event.markets ?? []
  if (conditionId) {
    const exact = markets.find(m => m.conditionId === conditionId)
    if (exact) return parseMarket(exact, event.title)
  }
  const sorted = [...markets].sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
  for (const m of sorted) {
    const candidate = parseMarket(m, event.title)
    if (candidate) return candidate
  }
  return null
}
function mapCategory(raw = '', title = '', description = ''): string {
  const c = raw.toLowerCase()
  const t = (title + ' ' + description).toLowerCase()
  if (c.includes('sport') || /\b(nfl|nba|soccer|football|basketball|tennis|cricket|ufc|fifa|esports)\b/.test(t)) return 'sports'
  if (c.includes('crypto') || /\b(bitcoin|ethereum|crypto|solana|dogecoin|xrp)\b/.test(t)) return 'crypto'
  if (c.includes('politic') || c.includes('election') || /\b(president|election|senate|congress|trump|parliament|prime minister)\b/.test(t)) return 'politics'
  if (c.includes('tech') || c.includes('science') || /\b(ai|openai|chatgpt|google|apple|microsoft|nvidia|technology)\b/.test(t)) return 'tech'
  if (c.includes('entertain') || c.includes('culture') || /\b(movie|film|music|actor|grammy|oscar|netflix)\b/.test(t)) return 'entertainment'
  if (c.includes('finance') || c.includes('market') || /\b(stock|nasdaq|fed|inflation|gdp|interest rate|earnings)\b/.test(t)) return 'finance'
  if (c.includes('business') || c.includes('economy')) return 'business'
  if (c.includes('world') || c.includes('international')) return 'world'
  return 'general'
}
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Polymarket Gamma ${response.status}: ${url}`)
  return await response.json() as T
}
async function fetchKeyset(after?: string | null) {
  const params = new URLSearchParams({ active: 'true', closed: 'false', limit: String(KEYSET_PAGE_SIZE) })
  if (after) params.set('after_cursor', after)
  const data = await fetchJson<{ events?: SourceEvent[]; next_cursor?: string | null }>(`${GAMMA}/events/keyset?${params}`)
  return { events: data.events ?? [], nextCursor: data.next_cursor ?? null }
}
async function fetchWithFallback(urls: string[]): Promise<SourceEvent[]> {
  let lastError: Error | null = null
  for (const url of urls) {
    try { return await fetchJson<SourceEvent[]>(url) }
    catch (err) { lastError = err instanceof Error ? err : new Error('Unknown Gamma API error') }
  }
  throw lastError ?? new Error('Gamma API error')
}
async function fetchRecentlyUpdated() {
  return await fetchWithFallback([
    `${GAMMA}/events?active=true&closed=false&order=updatedAt&ascending=false&limit=${PAGE_SIZE}`,
    `${GAMMA}/events?active=true&closed=false&order=volume&ascending=false&limit=${PAGE_SIZE}`,
    `${GAMMA}/events?active=true&closed=false&limit=${PAGE_SIZE}`
  ])
}
async function fetchRecentlyClosed() {
  return await fetchWithFallback([
    `${GAMMA}/events?closed=true&order=endDate&ascending=false&limit=${PAGE_SIZE}`,
    `${GAMMA}/events?closed=true&order=updatedAt&ascending=false&limit=${PAGE_SIZE}`,
    `${GAMMA}/events?closed=true&limit=${PAGE_SIZE}`
  ])
}
function roundUsd(n: number) { return Math.round(n * 100) / 100 }

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  if (req.headers.get('x-preket-cron-token') !== CRON_TOKEN) return new Response('Forbidden', { status: 403 })
  const startedAt = new Date().toISOString()
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !key) throw new Error('Supabase service environment is missing')
    const admin = createClient(url, key, { auth: { persistSession: false } })

    const { data: state, error: stateError } = await admin.from('sync_state').select('value').eq('key', CURSOR_KEY).maybeSingle()
    if (stateError) throw new Error(stateError.message)
    const newestPromise = fetchKeyset(null)
    const cursorPromise = state?.value ? fetchKeyset(state.value) : newestPromise
    const updatedPromise = fetchRecentlyUpdated()
    const [newest, cursorPage, updated] = await Promise.all([newestPromise, cursorPromise, updatedPromise])
    const byId = new Map<string, SourceEvent>()
    for (const e of newest.events) byId.set(e.id, e)
    for (const e of cursorPage.events) byId.set(e.id, e)
    for (const e of updated) byId.set(e.id, e)
    const events = [...byId.values()]

    const ids = events.map(e => e.id)
    const existingRows: any[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      const { data, error } = await admin.from('events')
        .select('id,source_event_id,source_condition_id,title,description,category,polymarket_source_volume_usd,polymarket_source_liquidity_usd,polymarket_source_updated_at,polymarket_synced_at')
        .eq('source_platform', 'polymarket').in('source_event_id', batch)
      if (error) throw new Error(error.message)
      existingRows.push(...(data ?? []))
    }
    const existingBySource = new Map(existingRows.map(row => [row.source_event_id as string, row]))
    const { data: admins, error: adminError } = await admin.from('users').select('id').eq('role', 'admin').limit(1)
    if (adminError) throw new Error(adminError.message)
    const allowImports = Boolean(admins?.length)

    const summary = { ok: true, startedAt, fetched: events.length, imported: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] as { id: string; error: string }[] }
    const processEvent = async (event: SourceEvent) => {
      try {
        const existing = existingBySource.get(event.id)
        const candidate = chooseCandidate(event, existing?.source_condition_id)
        if (!candidate) { summary.skipped++; return }
        const market = candidate.market
        const sourceVolumeRaw = num(market.volume) ?? num(event.volume) ?? 0
        const sourceLiquidityRaw = num(market.liquidity) ?? num(event.liquidity) ?? 0
        const sourceVolume = roundUsd(sourceVolumeRaw)
        const sourceLiquidity = roundUsd(sourceLiquidityRaw)
        const sourceUpdatedAt = market.updatedAt ?? event.updatedAt ?? null
        const title = candidate.title
        const description = (event.description ?? '').slice(0, 2000)
        const category = mapCategory(event.category ?? '', event.title, event.description ?? '')
        const syncedAt = new Date().toISOString()
        if (existing) {
          const changed = existing.title !== title ||
            existing.description !== description ||
            existing.category !== category ||
            existing.source_condition_id !== market.conditionId ||
            Number(existing.polymarket_source_volume_usd ?? 0) !== sourceVolume ||
            Number(existing.polymarket_source_liquidity_usd ?? 0) !== sourceLiquidity ||
            (sourceUpdatedAt !== null && existing.polymarket_source_updated_at !== sourceUpdatedAt) ||
            !existing.polymarket_synced_at
          if (!changed) { summary.unchanged++; return }
          const { error } = await admin.from('events').update({
            title, description, category, source_condition_id: market.conditionId,
            polymarket_source_volume_usd: sourceVolume,
            polymarket_source_liquidity_usd: sourceLiquidity,
            polymarket_source_updated_at: sourceUpdatedAt,
            polymarket_synced_at: syncedAt,
            simulated_volume_usd: null
          }).eq('id', existing.id)
          if (error) throw new Error(error.message)
          summary.updated++
          return
        }
        if (!allowImports) { summary.skipped++; return }
        const initialLiquidity = roundUsd(sourceLiquidity / 5)
        const { data: newId, error: importError } = await admin.rpc('import_external_event', {
          p_source_platform: 'polymarket',
          p_source_event_id: event.id,
          p_source_condition_id: market.conditionId,
          p_title: title,
          p_description: description,
          p_category: category,
          p_yes_price: candidate.yes,
          p_no_price: candidate.no,
          p_initial_liquidity_usd: initialLiquidity
        })
        if (importError) throw new Error(importError.message)
        if (!newId) { summary.skipped++; return }
        const { error: updateError } = await admin.from('events').update({
          polymarket_source_volume_usd: sourceVolume,
          polymarket_source_liquidity_usd: sourceLiquidity,
          polymarket_source_updated_at: sourceUpdatedAt,
          polymarket_synced_at: syncedAt,
          simulated_volume_usd: null
        }).eq('id', newId)
        if (updateError) throw new Error(updateError.message)
        summary.imported++
      } catch (err) {
        summary.errors.push({ id: event.id, error: err instanceof Error ? err.message : 'Unknown error' })
      }
    }
    for (let i = 0; i < events.length; i += 8) await Promise.all(events.slice(i, i + 8).map(processEvent))

    const closedEvents = await fetchRecentlyClosed()
    const closedIds = closedEvents.map(e => e.id)
    let activeLocal: any[] = []
    for (let i = 0; i < closedIds.length; i += 100) {
      const { data, error } = await admin.from('events').select('id,source_event_id,source_condition_id')
        .eq('status', 'active').eq('source_platform', 'polymarket').in('source_event_id', closedIds.slice(i, i + 100))
      if (error) throw new Error(error.message)
      activeLocal.push(...(data ?? []))
    }
    const localBySource = new Map(activeLocal.map(e => [e.source_event_id as string, e]))
    let resolved = 0, needsReview = 0
    for (const event of closedEvents) {
      const local = localBySource.get(event.id)
      if (!local) continue
      const candidate = chooseCandidate(event, local.source_condition_id)
      if (!candidate) { needsReview++; continue }
      const yesWon = candidate.yes > 0.9 && candidate.no < 0.1
      const noWon = candidate.no > 0.9 && candidate.yes < 0.1
      if (!yesWon && !noWon) { needsReview++; continue }
      const { error } = await admin.rpc('resolve_external_event', {
        p_source_platform: 'polymarket', p_source_event_id: event.id,
        p_winning_outcome: yesWon ? 'YES' : 'NO'
      })
      if (error) summary.errors.push({ id: event.id, error: error.message })
      else resolved++
    }

    const { error: cursorError } = await admin.from('sync_state').upsert({
      key: CURSOR_KEY, value: cursorPage.nextCursor, updated_at: new Date().toISOString()
    })
    if (cursorError) throw new Error(cursorError.message)

    const result = { ...summary, newestScanned: newest.events.length, cursorPageScanned: cursorPage.events.length, updatedScanned: updated.length, resolved, needsReview, sourceRatio: '1:5', completedAt: new Date().toISOString() }
    console.log('[sync-polymarket-events]', JSON.stringify(result))
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error'
    console.error('[sync-polymarket-events] failed', error)
    return new Response(JSON.stringify({ ok: false, startedAt, error }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
