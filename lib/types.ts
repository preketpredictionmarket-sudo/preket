export type UserRole = "user" | "admin";

export type EventStatus = "active" | "resolved" | "cancelled";
export type Outcome = "YES" | "NO";
export type BetStatus = "active" | "won" | "lost";
export type DepositStatus = "pending" | "verified" | "failed";
export type WithdrawalStatus = "pending" | "approved" | "rejected";

export type NetworkId = "polygon" | "bsc" | "arbitrum" | "base";

export interface User {
  id: string;
  email: string;
  balance_usd: number;
  role: UserRole;
  created_at: string;
}

export interface PublicProfile {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  title: string;
  description: string;
  category: string;
  status: EventStatus;
  winning_outcome: Outcome | null;
  total_yes_pool: number;
  total_no_pool: number;
  cpmm_ry: number;
  cpmm_rn: number;
  source_event_id?: string | null;
  polymarket_source_volume_usd?: number | null;
  simulated_volume_usd?: number | null;
  created_at: string;
}

export interface Bet {
  id: string;
  user_id: string;
  event_id: string;
  outcome: Outcome;
  amount_usd: number;
  entry_price: number | null;
  shares: number | null;
  trade_type: "buy" | "sell";
  fee_usd: number;
  payout_usd: number | null;
  status: BetStatus;
  created_at: string;
}

export interface Deposit {
  id: string;
  user_id: string;
  network: NetworkId;
  tx_hash: string;
  amount_crypto: number;
  amount_usd: number;
  status: DepositStatus;
  created_at: string;
}

export interface Withdrawal {
  id: string;
  user_id: string;
  network: NetworkId;
  wallet_address: string;
  amount_usd: number;
  status: WithdrawalStatus;
  created_at: string;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function formatPercent(prob: number): string {
  return `${(prob * 100).toFixed(1)}%`;
}

/**
 * Stable display-only volume derived from the latest Polymarket source volume.
 * It is intentionally high-looking and irregular, but is always strictly below
 * the real source volume. It must never be used for balances, bets, liquidity,
 * CPMM reserves, or settlement calculations.
 */
export function getDisplayVolume(sourceVolume: number | null | undefined, seed: string | null | undefined, simulatedVolume?: number | null): number {
  const volume = Number(sourceVolume);
  if (!Number.isFinite(volume) || volume < 50) {
    const simulated = Number(simulatedVolume);
    return Number.isFinite(simulated) && simulated >= 50 && simulated <= 100000 ? simulated : 0;
  }

  const input = seed || "preket";
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  // 72.00%–94.99% of source volume, stable per event.
  const ratio = 0.72 + (Math.abs(hash) % 2300) / 10000;
  let display = Math.floor(volume * ratio * 100) / 100;

  // Strictly below source volume even after rounding.
  if (display >= volume) display = Math.max(0, Math.floor((volume - 0.01) * 100) / 100);
  return display;
}
