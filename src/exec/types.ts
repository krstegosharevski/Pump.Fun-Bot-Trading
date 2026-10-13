export interface BuyRequest {
  mint: string;
  /** SOL to spend on the trade (fees come on top / out of it as the venue charges them). */
  solAmount: number;
  /** Spot price when the strategy decided; used for the slippage check. */
  expectedPriceSol: number;
}

export interface SellRequest {
  mint: string;
  /** Tokens to sell (raw units, 6 decimals). Sells always close the whole position. */
  tokensRaw: bigint;
  expectedPriceSol: number;
}

export interface Fill {
  ok: boolean;
  error?: string;
  /** Net change in wallet SOL: negative for buys, positive for sells. Failed txs still cost fees. */
  solDelta: number;
  /** Tokens bought or sold (raw units). */
  tokensRaw: bigint;
  /** Average curve price of the fill, SOL per whole token (excludes fees). */
  priceSol: number;
  /** All fees paid: venue % fees + network/priority fees. Excludes rent. */
  feesSol: number;
  /** Token-account rent included in solDelta (locked on buy, refunded on sell). */
  rentSol: number;
  signature?: string;
}

export interface Executor {
  readonly name: "paper" | "live";
  buy(req: BuyRequest): Promise<Fill>;
  sell(req: SellRequest): Promise<Fill>;
}

export function failedFill(error: string, costSol = 0): Fill {
  return { ok: false, error, solDelta: -costSol, tokensRaw: 0n, priceSol: 0, feesSol: costSol, rentSol: 0 };
}
