import { Connection, PublicKey, type Commitment } from "@solana/web3.js";

/** pump.fun bonding-curve program (mainnet). */
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

export const TOKEN_DECIMALS = 6;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const LAMPORTS = 1e9;

// Initial values from the pump Global account (same for every new coin).
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
export const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n;
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
export const TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;

const DEFAULT_PUBKEY = PublicKey.default.toBase58();

export interface CurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator?: string;
  /** pump.fun "Mayhem mode" coin (different reserves and dynamics). */
  isMayhem?: boolean;
  /** Present on newer accounts; undefined or the default key means the coin is paired with SOL. */
  quoteMint?: string;
}

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

/**
 * Decodes a BondingCurve account. Layout (after the 8-byte Anchor discriminator):
 * u64 virtual_token_reserves, u64 virtual_sol_reserves, u64 real_token_reserves,
 * u64 real_sol_reserves, u64 token_total_supply, bool complete, then fields that
 * were appended over time: pubkey creator, bool is_mayhem_mode, bool is_cashback_coin,
 * pubkey quote_mint, ...
 */
export function decodeCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  const state: CurveState = {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] === 1,
  };
  if (data.length >= 81) state.creator = new PublicKey(data.subarray(49, 81)).toBase58();
  if (data.length >= 82) state.isMayhem = data[81] === 1;
  if (data.length >= 115) state.quoteMint = new PublicKey(data.subarray(83, 115)).toBase58();
  return state;
}

export function isSolPaired(c: CurveState): boolean {
  return c.quoteMint === undefined || c.quoteMint === DEFAULT_PUBKEY;
}

/** Spot price in SOL per whole token. */
export function spotPriceSol(c: CurveState): number {
  if (c.virtualTokenReserves === 0n) return 0;
  return Number(c.virtualSolReserves) / LAMPORTS / (Number(c.virtualTokenReserves) / TOKEN_UNIT);
}

export function marketCapSol(c: CurveState): number {
  return (spotPriceSol(c) * Number(c.tokenTotalSupply)) / TOKEN_UNIT;
}

export function realSol(c: CurveState): number {
  return Number(c.realSolReserves) / LAMPORTS;
}

/** 0% = brand new, 100% = curve sold out (graduates to PumpSwap). */
export function curveProgressPct(c: CurveState): number {
  const sold = 1 - Number(c.realTokenReserves) / Number(INITIAL_REAL_TOKEN_RESERVES);
  return Math.min(100, Math.max(0, sold * 100));
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Raw tokens received for `solInLamports` going into the curve (fees already removed). */
export function quoteBuy(c: CurveState, solInLamports: bigint): bigint {
  if (solInLamports <= 0n) return 0n;
  const k = c.virtualSolReserves * c.virtualTokenReserves;
  const newVirtualToken = ceilDiv(k, c.virtualSolReserves + solInLamports);
  const out = c.virtualTokenReserves - newVirtualToken;
  return out < c.realTokenReserves ? out : c.realTokenReserves;
}

/** Gross lamports out of the curve for selling `tokensRaw` (before fees). */
export function quoteSell(c: CurveState, tokensRaw: bigint): bigint {
  if (tokensRaw <= 0n) return 0n;
  const k = c.virtualSolReserves * c.virtualTokenReserves;
  const newVirtualSol = ceilDiv(k, c.virtualTokenReserves + tokensRaw);
  const out = c.virtualSolReserves - newVirtualSol;
  return out < c.realSolReserves ? out : c.realSolReserves;
}

export function initialCurve(): CurveState {
  return {
    virtualTokenReserves: INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualSolReserves: INITIAL_VIRTUAL_SOL_RESERVES,
    realTokenReserves: INITIAL_REAL_TOKEN_RESERVES,
    realSolReserves: 0n,
    tokenTotalSupply: TOKEN_TOTAL_SUPPLY,
    complete: false,
  };
}

/** Curve state after a buy of `solInLamports` (fees removed). Used by tests. */
export function applyBuy(c: CurveState, solInLamports: bigint): CurveState {
  const out = quoteBuy(c, solInLamports);
  return {
    ...c,
    virtualSolReserves: c.virtualSolReserves + solInLamports,
    virtualTokenReserves: c.virtualTokenReserves - out,
    realSolReserves: c.realSolReserves + solInLamports,
    realTokenReserves: c.realTokenReserves - out,
  };
}

/** Fetch many curve accounts in as few RPC calls as possible (max 100 per call). */
export async function fetchCurves(
  conn: Connection,
  addresses: PublicKey[],
  commitment: Commitment = "processed",
): Promise<(CurveState | null)[]> {
  const out: (CurveState | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(addresses.slice(i, i + 100), commitment);
    for (const info of infos) out.push(info ? decodeCurve(info.data) : null);
  }
  return out;
}
