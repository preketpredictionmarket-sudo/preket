import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchNewTopEvents, fetchRecentlyClosedEvents, fetchRecentlyUpdatedEvents, getBinaryOutcomePrices, mapCategory, toBinaryCompatibleMarket } from "@/lib/polymarket/gamma";

const POLYMARKET_CURSOR_KEY = "polymarket_cursor";
export const maxDuration = 60;

function checkCronAuth(request: Request) {
  if (request.headers.get("x-preket-supabase-cron") === "true") return true;
  const secret = process.env.CRON_SECRET?.trim();
  const auth = request.headers.get("authorization");
  const header = request.headers.get("x-cron-secret");
  const query = new URL(request.url).searchParams.get("secret");
  return Boolean(secret && (auth === `Bearer ${secret}` || header === secret || query === secret));
}

type GammaMarketLike = Parameters<typeof getBinaryOutcomePrices>[0];
function selectBestMarket(markets: GammaMarketLike[]) {
  return [...markets].sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))[0] ?? null;
}

async function resolveRecentlyClosedPolymarketEvents(admin: ReturnType<typeof createAdminClient>, closedEvents: Awaited<ReturnType<typeof fetchRecentlyClosedEvents>>) {
  // Keep the closed-event scan deliberately bounded because this route runs every minute.
  // The newest closed markets are enough for timely resolution; older ones are revisited by
  // the next runs if they remain active locally.
  const sourceIds = closedEvents.map(e => e.id).filter(Boolean);
  if (!sourceIds.length) return { resolved: [], needsReview: [], errors: [] as { id: string; error: string }[] };

  const { data: openRows, error } = await admin
    .from("events")
    .select("id, source_event_id, source_condition_id")
    .eq("status", "active")
    .eq("source_platform", "polymarket")
    .in("source_event_id", sourceIds);
  if (error) throw new Error(error.message);

  const openBySourceId = new Map(
    (openRows ?? []).map(row => [row.source_event_id as string, row.source_condition_id as string | null])
  );
  const resolved: string[] = [];
  const needsReview: string[] = [];
  const errors: { id: string; error: string }[] = [];

  const processClosedEvent = async (gammaEvent: (typeof closedEvents)[number]) => {
    const sourceId = gammaEvent.id;
    if (!openBySourceId.has(sourceId)) return;
    try {
      const conditionId = openBySourceId.get(sourceId);
      const market = conditionId
        ? gammaEvent.markets?.find(item => item.conditionId === conditionId)
        : selectBestMarket(gammaEvent.markets ?? []);
      if (!market) {
        errors.push({ id: sourceId, error: "Matching market not found on Polymarket" });
        return;
      }
      const compatible = toBinaryCompatibleMarket(market, gammaEvent.title);
      if (!compatible) {
        needsReview.push(sourceId);
        return;
      }
      const prices = getBinaryOutcomePrices(compatible);
      if (!prices) {
        needsReview.push(sourceId);
        return;
      }
      const yes = prices.yes > 0.9 && prices.no < 0.1;
      const no = prices.no > 0.9 && prices.yes < 0.1;
      if (!yes && !no) {
        needsReview.push(sourceId);
        return;
      }
      const result = await admin.rpc("resolve_external_event", {
        p_source_platform: "polymarket",
        p_source_event_id: sourceId,
        p_winning_outcome: yes ? "YES" : "NO",
      });
      if (result.error) errors.push({ id: sourceId, error: result.error.message });
      else resolved.push(sourceId);
    } catch (err) {
      errors.push({ id: sourceId, error: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  const CONCURRENCY = 8;
  for (let i = 0; i < closedEvents.length; i += CONCURRENCY) {
    await Promise.all(closedEvents.slice(i, i + CONCURRENCY).map(processClosedEvent));
  }

  return { resolved, needsReview, errors };
}

async function syncActiveEvents(
  admin: ReturnType<typeof createAdminClient>,
  events: Awaited<ReturnType<typeof fetchNewTopEvents>>["events"],
  allowNewImports: boolean
) {
  const results = {
    imported: [] as string[],
    updated: [] as string[],
    skipped: [] as string[],
    importErrors: [] as { id: string; error: string }[],
    skipReasons: {
      noBinaryMarket: [] as string[],
      noPrices: [] as string[],
      unchangedExisting: [] as string[],
      rpcReturnedFalse: [] as string[],
      missingHouseAccount: [] as string[],
    },
  };

  const CONCURRENCY = 8;
  const sourceIds = [...new Set(events.map(e => e.id))];
  if (!sourceIds.length) return results;

  const { data: existingRows, error } = await admin
    .from("events")
    .select("id, source_event_id, source_condition_id, title, description, category, polymarket_source_volume_usd, polymarket_source_liquidity_usd, polymarket_source_updated_at, polymarket_synced_at, total_yes_pool, total_no_pool, cpmm_ry, cpmm_rn")
    .eq("source_platform", "polymarket")
    .in("source_event_id", sourceIds);
  if (error) throw new Error(error.message);

  const existingBySourceId = new Map((existingRows ?? []).map(row => [row.source_event_id as string, row]));
  const existingEventIds = (existingRows ?? []).map(row => row.id as string);
  const eventIdsWithTrades = new Set<string>();
  if (existingEventIds.length) {
    for (let i = 0; i < existingEventIds.length; i += 100) {
      const { data: tradeRows, error: tradeError } = await admin
        .from("bets")
        .select("event_id")
        .in("event_id", existingEventIds.slice(i, i + 100));
      if (tradeError) throw new Error(tradeError.message);
      for (const row of tradeRows ?? []) eventIdsWithTrades.add(row.event_id as string);
    }
  }

  const processEvent = async (event: (typeof events)[number]) => {
    const market = selectBestMarket(event.markets ?? []);
    if (!market) {
      results.skipped.push(event.id);
      results.skipReasons.noBinaryMarket.push(event.id);
      return;
    }

    const compatible = toBinaryCompatibleMarket(market, event.title);
    if (!compatible) {
      results.skipped.push(event.id);
      results.skipReasons.noBinaryMarket.push(event.id);
      return;
    }

    const prices = getBinaryOutcomePrices(compatible);
    if (!prices) {
      results.skipped.push(event.id);
      results.skipReasons.noPrices.push(event.id);
      return;
    }

    // Use Polymarket's event-level totals first. A selected market's own volume is often
    // zero even when the parent event has substantial volume; using it made newly imported
    // event cards incorrectly display $0. Fall back to the selected market only if needed.
    const eventVolume = Number(event.volume);
    const marketVolume = Number(compatible.volume);
    const volume = Number.isFinite(eventVolume) && eventVolume > 0
      ? eventVolume
      : Number.isFinite(marketVolume) && marketVolume > 0 ? marketVolume : 0;
    const roundedVolume = Math.round(volume * 100) / 100;
    const eventLiquidity = Number(event.liquidity);
    const marketLiquidity = Number(compatible.liquidity);
    const sourceLiquidity = Number.isFinite(eventLiquidity) && eventLiquidity > 0
      ? eventLiquidity
      : Number.isFinite(marketLiquidity) && marketLiquidity > 0 ? marketLiquidity : 0;
    const roundedSourceLiquidity = Math.round(sourceLiquidity * 100) / 100;
    const sourceUpdatedAt = compatible.updatedAt ?? event.updatedAt ?? null;
    const initialLiquidity = Math.round((roundedSourceLiquidity / 5) * 100) / 100;
    const existing = existingBySourceId.get(event.id);

    try {
      const title = compatible.question || event.title;
      const description = (event.description || "").slice(0, 2000);
      const category = mapCategory(event.category, event.title, event.description);

      if (existing) {
        const hasLocalTrades = eventIdsWithTrades.has(existing.id as string);
        const targetPool = initialLiquidity;
        const priceTotal = Math.max(prices.yes + prices.no, 0.02);
        const targetYesPool = targetPool > 0
          ? Math.round((targetPool * prices.yes / priceTotal) * 100) / 100
          : 0;
        const targetNoPool = Math.round((targetPool - targetYesPool) * 100) / 100;
        const poolChanged = !hasLocalTrades && (
          Number(existing.total_yes_pool ?? 0) !== targetYesPool ||
          Number(existing.total_no_pool ?? 0) !== targetNoPool ||
          Number(existing.cpmm_ry ?? 0) !== 500 + targetYesPool ||
          Number(existing.cpmm_rn ?? 0) !== 500 + targetNoPool
        );
        const changed =
          existing.title !== title ||
          existing.description !== description ||
          existing.category !== category ||
          existing.source_condition_id !== compatible.conditionId ||
          existing.polymarket_source_volume_usd == null ||
          Number(existing.polymarket_source_volume_usd) !== roundedVolume ||
          existing.polymarket_source_liquidity_usd == null ||
          Number(existing.polymarket_source_liquidity_usd) !== roundedSourceLiquidity ||
          (sourceUpdatedAt !== null && existing.polymarket_source_updated_at !== sourceUpdatedAt) ||
          !existing.polymarket_synced_at ||
          poolChanged;

        if (!changed) {
          results.skipped.push(event.id);
          results.skipReasons.unchangedExisting.push(event.id);
          return;
        }

        const result = await admin.rpc("sync_external_event", {
          p_event_id: existing.id,
          p_title: title,
          p_description: description,
          p_category: category,
          p_source_condition_id: compatible.conditionId,
          p_source_volume_usd: roundedVolume,
          p_source_liquidity_usd: roundedSourceLiquidity,
          p_source_updated_at: sourceUpdatedAt,
          p_yes_price: prices.yes,
          p_no_price: prices.no,
        });

        if (result.error) results.importErrors.push({ id: event.id, error: result.error.message });
        else if (result.data) results.updated.push(event.id);
        else results.skipped.push(event.id);
        return;
      }

      // Do not repeatedly trigger a known database exception on every minute's cron run.
      // Existing markets still update; new imports resume automatically once an admin/house
      // account is configured in the database.
      if (!allowNewImports) {
        results.skipped.push(event.id);
        results.skipReasons.missingHouseAccount.push(event.id);
        return;
      }

      const result = await admin.rpc("import_external_event", {
        p_source_platform: "polymarket",
        p_source_event_id: event.id,
        p_source_condition_id: compatible.conditionId,
        p_title: title,
        p_description: description,
        p_category: category,
        p_yes_price: prices.yes,
        p_no_price: prices.no,
        p_initial_liquidity_usd: initialLiquidity,
      });

      if (result.error) {
        results.importErrors.push({ id: event.id, error: result.error.message });
        return;
      }

      if (!result.data) {
        results.skipped.push(event.id);
        results.skipReasons.rpcReturnedFalse.push(event.id);
        return;
      }

      const volumeResult = await admin
        .from("events")
        .update({
          polymarket_source_volume_usd: roundedVolume,
          polymarket_source_liquidity_usd: roundedSourceLiquidity,
          polymarket_source_updated_at: sourceUpdatedAt,
          polymarket_synced_at: new Date().toISOString(),
          simulated_volume_usd: null,
        })
        .eq("source_platform", "polymarket")
        .eq("source_event_id", event.id);

      if (volumeResult.error) results.importErrors.push({ id: event.id, error: volumeResult.error.message });
      else results.imported.push(event.id);
    } catch (err) {
      results.importErrors.push({ id: event.id, error: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  for (let i = 0; i < events.length; i += CONCURRENCY) {
    await Promise.all(events.slice(i, i + CONCURRENCY).map(processEvent));
  }

  return results;
}

async function runSync(request: Request) {
  const startedAt = new Date().toISOString();
  if (!checkCronAuth(request)) return NextResponse.json({ error: "Forbidden", startedAt }, { status: 403 });

  const admin = createAdminClient();
  try {
    const { data: state, error: stateError } = await admin
      .from("sync_state")
      .select("value")
      .eq("key", POLYMARKET_CURSOR_KEY)
      .maybeSingle();
    if (stateError) throw new Error(stateError.message);

    const newestPagePromise = fetchNewTopEvents(null);
    const cursorPagePromise = state?.value ? fetchNewTopEvents(state.value) : newestPagePromise;
    const updatedEventsPromise = fetchRecentlyUpdatedEvents(100);
    const closedEventsPromise = fetchRecentlyClosedEvents(100);
    const [newestPage, cursorPage, updatedEvents, closedEvents] = await Promise.all([newestPagePromise, cursorPagePromise, updatedEventsPromise, closedEventsPromise]);

    const byId = new Map<string, (typeof newestPage.events)[number]>();
    for (const event of newestPage.events) byId.set(event.id, event);
    for (const event of cursorPage.events) byId.set(event.id, event);
    for (const event of updatedEvents) byId.set(event.id, event);
    for (const event of closedEvents) byId.set(event.id, event);
    const events = [...byId.values()];

    const { data: adminRows, error: adminLookupError } = await admin
      .from("users")
      .select("id")
      .eq("role", "admin")
      .limit(1);
    if (adminLookupError) throw new Error(adminLookupError.message);
    const allowNewImports = Boolean(adminRows?.length);

    const sync = await syncActiveEvents(admin, events, allowNewImports);
    const resolution = await resolveRecentlyClosedPolymarketEvents(admin, closedEvents);
    const nextCursor = cursorPage.nextCursor;
    // Keep the current cursor while new imports are blocked, so the page is retried after
    // an admin/house account is configured instead of silently advancing past those markets.
    const persistedCursor = allowNewImports ? nextCursor : (state?.value ?? null);
    if (allowNewImports) {
      const r = await admin
        .from("sync_state")
        .upsert({ key: POLYMARKET_CURSOR_KEY, value: nextCursor, updated_at: new Date().toISOString() });
      if (r.error) throw new Error(r.error.message);
    }

    const durationMs = Date.now() - new Date(startedAt).getTime();
    const skipSummary = Object.fromEntries(Object.entries(sync.skipReasons).map(([k, v]) => [k, v.length]));

    console.log(
      `[Polymarket Sync] ${new Date().toISOString()} | status=OK | newest=${newestPage.events.length} | cursor_page=${cursorPage.events.length} | updated_page=${updatedEvents.length} | closed_page=${closedEvents.length} | fetched_unique=${events.length} | imported=${sync.imported.length} | updated=${sync.updated.length} | skipped=${sync.skipped.length} | import_errors=${sync.importErrors.length} | allow_new_imports=${allowNewImports} | resolved=${resolution.resolved.length} | needs_review=${resolution.needsReview.length} | resolution_errors=${resolution.errors.length} | duration_ms=${durationMs} | cursor_advanced=${allowNewImports} | skip_reasons=${JSON.stringify(skipSummary)}`
    );

    return NextResponse.json({
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      cursor: persistedCursor,
      newestScanned: newestPage.events.length,
      cursorPageScanned: cursorPage.events.length,
      recentlyUpdatedScanned: updatedEvents.length,
      recentlyClosedScanned: closedEvents.length,
      fetched: events.length,
      imported: sync.imported.length,
      updated: sync.updated.length,
      skipped: sync.skipped.length,
      importErrors: sync.importErrors.length,
      resolutionChecked: true,
      resolved: resolution.resolved.length,
      needsReview: resolution.needsReview.length,
      resolutionErrors: resolution.errors.length,
      skipReasons: skipSummary,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Polymarket Sync] ${new Date().toISOString()} | status=FAILED | error=${error}`);
    return NextResponse.json({ error: "Polymarket sync failed", details: error, startedAt }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runSync(request);
}

export async function POST(request: Request) {
  return runSync(request);
}
