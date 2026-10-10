import Link from "next/link";
import type { Event } from "@/lib/types";
import { formatUsd, getDisplayLiquidity, getDisplayVolume } from "@/lib/types";
import { getMarketPricesFromReserves } from "@/lib/market-math";
import { getCategoryMeta } from "@/lib/market-ui";
import { MarketOdds } from "@/components/MarketOdds";
import { ArrowUpRight, Ban, CheckCircle2, Users } from "lucide-react";

export function EventCard({ event }: { event: Event }) {
  const meta = getCategoryMeta(event.category);
  const isActive = event.status === "active";
  const isResolved = event.status === "resolved";
  const isCancelled = event.status === "cancelled";
  const yesPool = Number(event.total_yes_pool);
  const noPool = Number(event.total_no_pool);
  const cpmmRy = Number(event.cpmm_ry ?? yesPool + 500);
  const cpmmRn = Number(event.cpmm_rn ?? noPool + 500);
  const { yesProb, noProb } = getMarketPricesFromReserves(cpmmRy, cpmmRn);
  const totalVolume = getDisplayVolume(event.polymarket_source_volume_usd) + Number(event.preket_trade_volume_usd ?? 0);
  const totalLiquidity = getDisplayLiquidity(event.polymarket_source_liquidity_usd);

  return (
    <Link
      href={`/events/${event.id}`}
      className="pm-market-card group flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800/80 bg-[#141414] transition-all duration-200 hover:-translate-y-0.5 hover:border-zinc-600 hover:bg-[#181818] hover:shadow-[0_12px_32px_rgba(0,0,0,.3)]"
    >
      <div className="flex flex-1 flex-col p-3.5 sm:p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[.08em] text-zinc-600">
          <span className="truncate text-zinc-500 normal-case tracking-normal">{meta.label}</span>
          <span className="text-zinc-700">•</span>
          <span className="truncate normal-case tracking-normal">{isActive ? "Live" : event.status}</span>
          {isActive && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.65)]" />}
        </div>

        <h3 className="line-clamp-3 min-h-[60px] text-[15px] font-semibold leading-[1.34] tracking-[-0.015em] text-zinc-100 transition-colors group-hover:text-white">
          {event.title}
        </h3>
        {event.description && <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-zinc-600">{event.description}</p>}

        {isActive && (
          <div className="mt-4">
            <div className="mb-2 flex items-end justify-between">
              <div>
                <div className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">Yes</div>
                <div className="text-lg font-bold tabular-nums text-emerald-400">{Math.round(yesProb * 100)}%</div>
              </div>
              <div className="text-right">
                <div className="text-[9px] font-medium uppercase tracking-wider text-zinc-600">No</div>
                <div className="text-lg font-bold tabular-nums text-rose-400">{Math.round(noProb * 100)}%</div>
              </div>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-rose-500/55">
              <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${yesProb * 100}%` }} />
            </div>
            <div className="mt-2.5"><MarketOdds yesProb={yesProb} noProb={noProb} size="sm" /></div>
          </div>
        )}

        {isResolved && (
          <div className={`mt-4 flex items-center gap-2 rounded-lg border px-3 py-2 ${event.winning_outcome === "YES" ? "border-emerald-500/20 bg-emerald-500/5" : "border-rose-500/20 bg-rose-500/5"}`}>
            <CheckCircle2 className={`h-4 w-4 ${event.winning_outcome === "YES" ? "text-emerald-400" : "text-rose-400"}`} />
            <span className="text-xs text-zinc-500">Resolved</span>
            <span className={`text-xs font-semibold ${event.winning_outcome === "YES" ? "text-emerald-400" : "text-rose-400"}`}>{event.winning_outcome} won</span>
          </div>
        )}

        {isCancelled && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
            <Ban className="h-4 w-4 text-zinc-500" />
            <span className="text-xs text-zinc-500">Cancelled · Trading closed</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-zinc-800/70 px-3.5 py-2.5 text-[10px] text-zinc-500 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span className="inline-flex items-center gap-1"><Users className="h-3 w-3 shrink-0" /><span>Total Volume <strong className="font-semibold text-zinc-300">{formatUsd(totalVolume)}</strong></span></span><span className="inline-flex items-center gap-1"><span>Total Liquidity <strong className="font-semibold text-zinc-300">{formatUsd(totalLiquidity)}</strong></span></span></div>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-zinc-500 transition-colors group-hover:text-white">Trade <ArrowUpRight className="h-3 w-3" /></span>
      </div>
    </Link>
  );
}
