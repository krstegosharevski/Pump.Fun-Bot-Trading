import { PublicKey } from "@solana/web3.js";

/** PumpSwap: the AMM pump.fun coins move to after they graduate from the bonding curve. */
export const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const LAMPORTS = 1e9;
const TOKEN_UNIT = 1e6;

export interface PoolInfo {
  baseMint: string;
  quoteMint: string;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Added to the quote vault balance for pricing (can be negative). */
  virtualQuoteReserves: bigint;
}

/** Reserves used for pricing: raw base vault, and quote vault + virtual quote reserves. */
export interface PoolState {
  baseReserve: bigint;
  quoteReserve: bigint;
  /** SOL actually in the quote vault: the most a sale can pay out. */
  realQuote: bigint;
}

/**
 * Pool layout (after the 8-byte discriminator): u8 pool_bump, u16 index, pubkey creator,
 * pubkey base_mint, pubkey quote_mint, pubkey lp_mint, pubkey pool_base_token_account,
 * pubkey pool_quote_token_account, u64 lp_supply, pubkey coin_creator, bool is_mayhem_mode,
 * bool is_cashback_coin, i128 virtual_quote_reserves (appended later), ...
 */
export function decodePool(data: Buffer): PoolInfo | null {
  if (data.length < 203) return null;
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  let virtualQuoteReserves = 0n;
  if (data.length >= 261) {
    const low = data.readBigUInt64LE(245);
    const high = data.readBigInt64LE(253);
    virtualQuoteReserves = (high << 64n) + low;
  }
  return {
    baseMint: pk(43).toBase58(),
    quoteMint: pk(75).toBase58(),
    baseVault: pk(139),
    quoteVault: pk(171),
    virtualQuoteReserves,
  };
}

/** Amount held by an SPL Token or Token-2022 account. */
export function tokenAccountAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

export function poolState(info: PoolInfo, baseVaultData: Buffer, quoteVaultData: Buffer): PoolState {
  const realQuote = tokenAccountAmount(quoteVaultData);
  return {
    baseReserve: tokenAccountAmount(baseVaultData),
    quoteReserve: realQuote + info.virtualQuoteReserves,
    realQuote,
  };
}

/** SOL per whole token (6-decimal coins paired with SOL). */
export function poolPriceSol(s: PoolState): number {
  if (s.baseReserve === 0n) return 0;
  return Number(s.quoteReserve) / LAMPORTS / (Number(s.baseReserve) / TOKEN_UNIT);
}

/** Raw tokens out for `quoteIn` lamports going into the pool (fees already removed). */
export function quoteBuyAmm(s: PoolState, quoteIn: bigint): bigint {
  if (quoteIn <= 0n) return 0n;
  return (s.baseReserve * quoteIn) / (s.quoteReserve + quoteIn);
}

/** Gross lamports out for selling `baseIn` raw tokens (before fees). */
export function quoteSellAmm(s: PoolState, baseIn: bigint): bigint {
  if (baseIn <= 0n) return 0n;
  const out = (s.quoteReserve * baseIn) / (s.baseReserve + baseIn);
  return out < s.realQuote ? out : s.realQuote;
}

/** Pool state after a buy of `quoteIn` lamports. */
export function applyBuyAmm(s: PoolState, quoteIn: bigint): PoolState {
  const out = quoteBuyAmm(s, quoteIn);
  return { baseReserve: s.baseReserve - out, quoteReserve: s.quoteReserve + quoteIn, realQuote: s.realQuote + quoteIn };
}
