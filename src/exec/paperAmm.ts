import type { Config } from "../config";
import { TOKEN_DECIMALS } from "../chain/curve";
import { applyBuyAmm, quoteBuyAmm, quoteSellAmm, type PoolState } from "../chain/pumpswap";
import { sleep } from "../log";
import { failedFill, type BuyRequest, type Executor, type Fill, type SellRequest } from "./types";

const LAMPORTS = 1e9;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const toLamports = (sol: number) => BigInt(Math.floor(sol * LAMPORTS));

/**
 * Fake-money executor for graduated coins: the PumpSwap version of PaperExecutor.
 * Same delay, failures, slippage check and rent; fees are the pool fee + PumpPortal's.
 */
export class AmmPaperExecutor implements Executor {
  readonly name = "paper" as const;

  constructor(
    private cfg: Config,
    private fetchPool: (mint: string) => Promise<PoolState | null>,
    private rng: () => number = Math.random,
    private wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private get txCostSol() {
    return this.cfg.BASE_FEE_SOL + this.cfg.PRIORITY_FEE_SOL;
  }

  async buy(req: BuyRequest): Promise<Fill> {
    const cfg = this.cfg;
    await this.wait(cfg.SIM_LATENCY_MS);
    if (this.rng() < cfg.SIM_FAIL_RATE) return failedFill("simulated transaction failure", this.txCostSol);

    const pool = await this.fetchPool(req.mint);
    if (!pool) return failedFill("could not read pool");

    const poolFee = req.solAmount * (cfg.BLAZE_POOL_FEE_PCT / 100);
    const portalFee = req.solAmount * (cfg.PUMPPORTAL_FEE_PCT / 100);
    const solIntoPool = req.solAmount - poolFee;
    const tokensRaw = quoteBuyAmm(pool, toLamports(solIntoPool));
    if (tokensRaw <= 0n) return failedFill("pool returned no tokens", this.txCostSol);

    const priceSol = solIntoPool / (Number(tokensRaw) / TOKEN_UNIT);
    if (priceSol > req.expectedPriceSol * (1 + cfg.BUY_SLIPPAGE_PCT / 100)) {
      return failedFill(
        `slippage: price moved +${((priceSol / req.expectedPriceSol - 1) * 100).toFixed(0)}%`,
        this.txCostSol,
      );
    }
    return {
      ok: true,
      solDelta: -(req.solAmount + portalFee + this.txCostSol + cfg.ATA_RENT_SOL),
      tokensRaw,
      priceSol,
      feesSol: poolFee + portalFee + this.txCostSol,
      rentSol: cfg.ATA_RENT_SOL,
      signature: "paper",
    };
  }

  async sell(req: SellRequest): Promise<Fill> {
    const cfg = this.cfg;
    await this.wait(cfg.SIM_LATENCY_MS);
    if (this.rng() < cfg.SIM_FAIL_RATE) return failedFill("simulated transaction failure", this.txCostSol);

    const pool = await this.fetchPool(req.mint);
    if (!pool) return failedFill("could not read pool");

    // Live, our buy would be in the pool; add it back before quoting (see PaperExecutor.sell).
    const withUs = req.solInCurve ? applyBuyAmm(pool, toLamports(req.solInCurve)) : pool;
    const grossSol = Number(quoteSellAmm(withUs, req.tokensRaw)) / LAMPORTS;
    const tokens = Number(req.tokensRaw) / TOKEN_UNIT;
    const priceSol = tokens > 0 ? grossSol / tokens : 0;
    const slippagePct = req.slippagePct ?? cfg.SELL_SLIPPAGE_PCT;
    if (priceSol < req.expectedPriceSol * (1 - slippagePct / 100)) {
      return failedFill(
        `slippage: price moved ${((priceSol / req.expectedPriceSol - 1) * 100).toFixed(0)}%`,
        this.txCostSol,
      );
    }

    const poolFee = grossSol * (cfg.BLAZE_POOL_FEE_PCT / 100);
    const portalFee = grossSol * (cfg.PUMPPORTAL_FEE_PCT / 100);
    const feesSol = poolFee + portalFee + this.txCostSol;
    // The token account is only closed (rent back) when the whole position is sold.
    const rentSol = (req.fraction ?? 1) < 1 ? 0 : cfg.ATA_RENT_SOL;
    return {
      ok: true,
      solDelta: grossSol - feesSol + rentSol,
      tokensRaw: req.tokensRaw,
      priceSol,
      feesSol,
      rentSol,
      signature: "paper",
    };
  }
}
