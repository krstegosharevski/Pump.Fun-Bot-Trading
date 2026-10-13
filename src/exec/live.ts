import fs from "node:fs";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Config } from "../config";
import { PUMP_PROGRAM_ID, TOKEN_DECIMALS } from "../chain/curve";
import { log, sleep } from "../log";
import { failedFill, type BuyRequest, type Executor, type Fill, type SellRequest } from "./types";

const TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";
const LAMPORTS = 1e9;
const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const CONFIRM_TIMEOUT_MS = 75_000;

/** Programs a PumpPortal pump.fun trade is expected to call directly. */
export const BASE_ALLOWED_PROGRAMS = [
  ComputeBudgetProgram.programId.toBase58(),
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap AMM (graduated coins)
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump.fun fee program
];

// System program: CreateAccount, Transfer, CreateAccountWithSeed. Anything else
// (e.g. Assign, which would hand our wallet to another program) is rejected.
const ALLOWED_SYSTEM_IX = new Set([0, 2, 3]);
// SPL Token top-level instructions we never expect from a trade: Transfer, Approve,
// SetAuthority, TransferChecked, ApproveChecked.
const FORBIDDEN_TOKEN_IX = new Set([3, 4, 6, 12, 13]);

export function loadWallet(walletPath: string): Keypair {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found at ${walletPath}. Create one with: npm run wallet:new`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
}

/**
 * Static checks on a transaction built by a third party, before we sign it.
 * Returns null if it looks like a normal trade, otherwise the reason to refuse.
 */
export function inspectTransaction(
  tx: VersionedTransaction,
  wallet: PublicKey,
  allowedPrograms: Set<string>,
): string | null {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) return "fee payer is not our wallet";
  if (msg.header.numRequiredSignatures !== 1) return "transaction requires other signers";
  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex]?.toBase58();
    if (!programId || !allowedPrograms.has(programId)) {
      return `unexpected program ${programId} (only add it to EXTRA_ALLOWED_PROGRAMS if you trust it)`;
    }
    if (programId === SystemProgram.programId.toBase58()) {
      const kind = ix.data.length >= 4 ? Buffer.from(ix.data).readUInt32LE(0) : -1;
      if (!ALLOWED_SYSTEM_IX.has(kind)) return `unexpected System instruction ${kind}`;
    }
    if (programId === TOKEN_PROGRAM_ID.toBase58() || programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
      if (FORBIDDEN_TOKEN_IX.has(ix.data[0])) return `unexpected token instruction ${ix.data[0]}`;
    }
  }
  return null;
}

/** Asks PumpPortal to build an unsigned trade transaction for `publicKey`. */
export async function buildTradeTx(
  publicKey: PublicKey,
  priorityFeeSol: number,
  params: Record<string, string | number>,
): Promise<VersionedTransaction> {
  const res = await fetch(TRADE_LOCAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: publicKey.toBase58(), priorityFee: priorityFeeSol, pool: "auto", ...params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${body}`.slice(0, 200));
  }
  return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
}

export class LiveExecutor implements Executor {
  readonly name = "live" as const;
  private allowed: Set<string>;

  constructor(
    private cfg: Config,
    private conn: Connection,
    private wallet: Keypair,
  ) {
    const extra = cfg.EXTRA_ALLOWED_PROGRAMS.split(",").map((s) => s.trim()).filter(Boolean);
    this.allowed = new Set([...BASE_ALLOWED_PROGRAMS, ...extra]);
  }

  async balanceSol(): Promise<number> {
    return (await this.conn.getBalance(this.wallet.publicKey, "confirmed")) / LAMPORTS;
  }

  async buy(req: BuyRequest): Promise<Fill> {
    const cfg = this.cfg;
    let tx: VersionedTransaction;
    try {
      tx = await this.buildTx({
        action: "buy",
        mint: req.mint,
        amount: req.solAmount,
        denominatedInSol: "true",
        slippage: cfg.BUY_SLIPPAGE_PCT,
      });
    } catch (err) {
      return failedFill(`PumpPortal: ${(err as Error).message}`);
    }
    const maxOutflow =
      req.solAmount * (1 + cfg.BUY_SLIPPAGE_PCT / 100) * (1 + (cfg.PUMP_FEE_PCT + cfg.PUMPPORTAL_FEE_PCT) / 100) +
      cfg.PRIORITY_FEE_SOL +
      cfg.ATA_RENT_SOL +
      0.0005;
    const problem = await this.safetyCheck(tx, maxOutflow);
    if (problem) return failedFill(`safety check refused: ${problem}`);
    return this.execute(tx, req.mint, "buy");
  }

  async sell(req: SellRequest): Promise<Fill> {
    const cfg = this.cfg;
    let tx: VersionedTransaction;
    try {
      tx = await this.buildTx({
        action: "sell",
        mint: req.mint,
        amount: "100%",
        denominatedInSol: "false",
        slippage: req.slippagePct ?? cfg.SELL_SLIPPAGE_PCT,
      });
    } catch (err) {
      return failedFill(`PumpPortal: ${(err as Error).message}`);
    }
    // A sell should never cost more than its fees (plus a temporary account that is refunded).
    const problem = await this.safetyCheck(tx, cfg.PRIORITY_FEE_SOL + 0.003);
    if (problem) return failedFill(`safety check refused: ${problem}`);
    const fill = await this.execute(tx, req.mint, "sell");
    if (fill.ok) {
      const refunded = await this.closeTokenAccount(req.mint).catch((err) => {
        log.warn(`Could not close token account (rent stays locked): ${(err as Error).message}`);
        return 0;
      });
      fill.solDelta += refunded;
      fill.rentSol += refunded;
    }
    return fill;
  }

  private buildTx(params: Record<string, string | number>): Promise<VersionedTransaction> {
    return buildTradeTx(this.wallet.publicKey, this.cfg.PRIORITY_FEE_SOL, params);
  }

  /** Static inspection + simulation. Returns the reason to refuse, or null if OK. */
  private async safetyCheck(tx: VersionedTransaction, maxOutflowSol: number): Promise<string | null> {
    const staticProblem = inspectTransaction(tx, this.wallet.publicKey, this.allowed);
    if (staticProblem) return staticProblem;

    const before = await this.conn.getBalance(this.wallet.publicKey, "processed");
    const sim = await this.conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
      accounts: { encoding: "base64", addresses: [this.wallet.publicKey.toBase58()] },
    });
    if (sim.value.err) {
      const tail = (sim.value.logs ?? []).slice(-2).join(" | ");
      return `simulation failed: ${JSON.stringify(sim.value.err)} ${tail}`.slice(0, 300);
    }
    const after = sim.value.accounts?.[0]?.lamports;
    if (after == null) return "simulation returned no balance";
    const outflow = (before - after) / LAMPORTS;
    if (outflow > maxOutflowSol) {
      return `would spend ${outflow.toFixed(4)} SOL, limit is ${maxOutflowSol.toFixed(4)} SOL`;
    }
    return null;
  }

  private async execute(tx: VersionedTransaction, mint: string, side: "buy" | "sell"): Promise<Fill> {
    tx.sign([this.wallet]);
    const raw = tx.serialize();
    const signature = bs58.encode(tx.signatures[0]);
    log.info(`  sent ${side} tx ${signature}`);

    const status = await this.sendAndConfirm(raw, signature);
    if (status === "timeout") {
      return failedFill(`transaction not confirmed in time (${signature})`, this.cfg.PRIORITY_FEE_SOL);
    }
    return this.fillFromChain(signature, mint, side, status === "failed");
  }

  /** Re-sends every 2s until confirmed, failed, or the blockhash has surely expired. */
  private async sendAndConfirm(raw: Uint8Array, signature: string): Promise<"confirmed" | "failed" | "timeout"> {
    const start = Date.now();
    let lastSend = 0;
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      if (Date.now() - lastSend > 2000) {
        lastSend = Date.now();
        await this.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch((err) => {
          log.debug(`send error: ${(err as Error).message}`);
        });
      }
      const st = (await this.conn.getSignatureStatuses([signature]).catch(() => null))?.value[0];
      if (st?.err) return "failed";
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return "confirmed";
      await sleep(800);
    }
    const st = (await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.err) return "failed";
    if (st?.confirmationStatus) return "confirmed";
    return "timeout";
  }

  /** Real amounts from the confirmed transaction's balance changes. */
  private async fillFromChain(signature: string, mint: string, side: "buy" | "sell", failed: boolean): Promise<Fill> {
    let tx = null;
    for (let i = 0; i < 15 && !tx; i++) {
      tx = await this.conn
        .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
      if (!tx) await sleep(1000);
    }
    if (!tx?.meta) {
      return failed
        ? failedFill(`transaction failed on-chain (${signature})`, this.cfg.PRIORITY_FEE_SOL)
        : failedFill(`confirmed but could not read result — check ${signature} on solscan.io`);
    }
    const meta = tx.meta;
    const networkFee = meta.fee / LAMPORTS;
    if (failed || meta.err) {
      return { ...failedFill(`transaction failed on-chain: ${JSON.stringify(meta.err)}`, networkFee), signature };
    }

    const owner = this.wallet.publicKey.toBase58();
    const solDelta = (meta.postBalances[0] - meta.preBalances[0]) / LAMPORTS;
    const preEntry = meta.preTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
    const postEntry = meta.postTokenBalances?.find((b) => b.mint === mint && b.owner === owner);
    const delta = BigInt(postEntry?.uiTokenAmount.amount ?? "0") - BigInt(preEntry?.uiTokenAmount.amount ?? "0");
    const tokensRaw = delta < 0n ? -delta : delta;
    const tokens = Number(tokensRaw) / TOKEN_UNIT;
    const pctFee = (this.cfg.PUMP_FEE_PCT + this.cfg.PUMPPORTAL_FEE_PCT) / 100;

    let rentSol = 0;
    let curveSol: number;
    let pctFees: number;
    if (side === "buy") {
      rentSol = preEntry ? 0 : this.cfg.ATA_RENT_SOL;
      const spent = -solDelta - networkFee - rentSol;
      curveSol = spent / (1 + pctFee);
      pctFees = spent - curveSol;
    } else {
      // PumpPortal's router closes the empty token account in the same transaction.
      rentSol = postEntry ? 0 : this.cfg.ATA_RENT_SOL;
      const received = solDelta + networkFee - rentSol;
      curveSol = received / (1 - pctFee);
      pctFees = curveSol - received;
    }
    return {
      ok: tokensRaw > 0n,
      error: tokensRaw > 0n ? undefined : "no tokens moved",
      solDelta,
      tokensRaw,
      priceSol: tokens > 0 ? curveSol / tokens : 0,
      feesSol: networkFee + Math.max(0, pctFees),
      rentSol,
      signature,
    };
  }

  /** Closes the now-empty token account to get its rent (~0.002 SOL) back. */
  private async closeTokenAccount(mint: string): Promise<number> {
    const mintKey = new PublicKey(mint);
    const mintInfo = await this.conn.getAccountInfo(mintKey);
    if (!mintInfo) return 0;
    const programId = mintInfo.owner;
    if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) return 0;
    const ata = getAssociatedTokenAddressSync(mintKey, this.wallet.publicKey, false, programId);
    const acct = await this.conn.getAccountInfo(ata);
    if (!acct) return 0;
    const bal = await this.conn.getTokenAccountBalance(ata);
    if (bal.value.amount !== "0") return 0;

    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash();
    const tx = new Transaction({ feePayer: this.wallet.publicKey, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      createCloseAccountInstruction(ata, this.wallet.publicKey, this.wallet.publicKey, [], programId),
    );
    tx.sign(this.wallet);
    const sig = await this.conn.sendRawTransaction(tx.serialize());
    await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return acct.lamports / LAMPORTS - this.cfg.BASE_FEE_SOL;
  }
}
