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
  polymarket_source_liquidity_usd?: number | null;
  polymarket_source_updated_at?: string | null;
  polymarket_synced_at?: string | null;
  preket_trade_volume_usd?: number | null;
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
 * Polymarket source metrics are displayed at exactly 20% (source / 5).
 * Preket's own trades are stored and displayed separately.
 */
export function getDisplayVolume(sourceVolume: number | null | undefined): number {
  const volume = Number(sourceVolume);
  if (!Number.isFinite(volume) || volume < 0) return 0;
  return Math.round((volume / 5) * 100) / 100;
}

export function getDisplayLiquidity(sourceLiquidity: number | null | undefined): number {
  const liquidity = Number(sourceLiquidity);
  if (!Number.isFinite(liquidity) || liquidity < 0) return 0;
  return Math.round((liquidity / 5) * 100) / 100;
}
