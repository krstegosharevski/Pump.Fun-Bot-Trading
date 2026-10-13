import type { Config } from "../config";
import { applyBuy, quoteBuy, quoteSell, spotPriceSol, TOKEN_DECIMALS, type CurveState } from "../chain/curve";
import { sleep } from "../log";
import { failedFill, type BuyRequest, type Executor, type Fill, type SellRequest } from "./types";

const LAMPORTS = 1e9;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
/** Extra haircut when a coin has graduated and we must sell on PumpSwap instead of the curve. */
const GRADUATED_HAIRCUT_PCT = 2;

const toLamports = (sol: number) => BigInt(Math.floor(sol * LAMPORTS));

/**
 * Fake-money executor. Fills against the real on-chain curve state as it is
 * SIM_LATENCY_MS after the decision, and charges every fee a live trade would pay.
 */
export class PaperExecutor implements Executor {
  readonly name = "paper" as const;

  constructor(
    private cfg: Config,
    private fetchCurve: (mint: string) => Promise<CurveState | null>,
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

    const curve = await this.fetchCurve(req.mint);
    if (!curve) return failedFill("could not read curve");
    if (curve.complete) return failedFill("curve already complete");

    const pumpFee = req.solAmount * (cfg.PUMP_FEE_PCT / 100);
    const portalFee = req.solAmount * (cfg.PUMPPORTAL_FEE_PCT / 100);
    const solIntoCurve = req.solAmount - pumpFee;
    const tokensRaw = quoteBuy(curve, toLamports(solIntoCurve));
    if (tokensRaw <= 0n) return failedFill("curve returned no tokens", this.txCostSol);

    const priceSol = solIntoCurve / (Number(tokensRaw) / TOKEN_UNIT);
    if (priceSol > req.expectedPriceSol * (1 + cfg.BUY_SLIPPAGE_PCT / 100)) {
      return failedFill(
        `slippage: price moved +${((priceSol / req.expectedPriceSol - 1) * 100).toFixed(0)}%`,
        this.txCostSol,
      );
    }

    const feesSol = pumpFee + portalFee + this.txCostSol;
    return {
      ok: true,
      solDelta: -(req.solAmount + portalFee + this.txCostSol + cfg.ATA_RENT_SOL),
      tokensRaw,
      priceSol,
      feesSol,
      rentSol: cfg.ATA_RENT_SOL,
      signature: "paper",
    };
  }

  async sell(req: SellRequest): Promise<Fill> {
    const cfg = this.cfg;
    await this.wait(cfg.SIM_LATENCY_MS);
    if (this.rng() < cfg.SIM_FAIL_RATE) return failedFill("simulated transaction failure", this.txCostSol);

    const curve = await this.fetchCurve(req.mint);
    if (!curve) return failedFill("could not read curve");

    const tokens = Number(req.tokensRaw) / TOKEN_UNIT;
    let grossSol: number;
    if (curve.complete) {
      // Liquidity has moved to PumpSwap; approximate with the final curve price.
      grossSol = tokens * spotPriceSol(curve) * (1 - GRADUATED_HAIRCUT_PCT / 100);
    } else {
      // Live, our buy would be in the curve. Without it, a coin everyone else has sold
      // looks like it has no SOL left to pay us, so add our SOL back before quoting.
      const withUs = req.solInCurve ? applyBuy(curve, toLamports(req.solInCurve)) : curve;
      grossSol = Number(quoteSell(withUs, req.tokensRaw)) / LAMPORTS;
    }
    const priceSol = tokens > 0 ? grossSol / tokens : 0;
    const slippagePct = req.slippagePct ?? cfg.SELL_SLIPPAGE_PCT;
    if (priceSol < req.expectedPriceSol * (1 - slippagePct / 100)) {
      return failedFill(
        `slippage: price moved ${((priceSol / req.expectedPriceSol - 1) * 100).toFixed(0)}%`,
        this.txCostSol,
      );
    }

    const pumpFee = grossSol * (cfg.PUMP_FEE_PCT / 100);
    const portalFee = grossSol * (cfg.PUMPPORTAL_FEE_PCT / 100);
    const feesSol = pumpFee + portalFee + this.txCostSol;
    return {
      ok: true,
      solDelta: grossSol - feesSol + cfg.ATA_RENT_SOL,
      tokensRaw: req.tokensRaw,
      priceSol,
      feesSol,
      rentSol: cfg.ATA_RENT_SOL,
      signature: "paper",
    };
  }
}
