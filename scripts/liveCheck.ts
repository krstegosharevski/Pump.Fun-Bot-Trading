import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config";
import { makeConnection } from "../src/chain/rpc";
import { PumpPortalFeed } from "../src/feed/pumpPortal";
import { BASE_ALLOWED_PROGRAMS, buildTradeTx, inspectTransaction, loadWallet } from "../src/exec/live";

// Dry run of the live trade path. It NEVER signs or sends anything:
// 1) waits for a new pump.fun coin, 2) asks PumpPortal for an unsigned buy transaction,
// 3) runs the same safety inspection the live bot uses, 4) simulates it.
const { cfg } = loadConfig([]);
const conn = makeConnection(cfg.RPC_URL);
const hasWallet = fs.existsSync(cfg.WALLET_PATH);
const owner: PublicKey = hasWallet ? loadWallet(cfg.WALLET_PATH).publicKey : Keypair.generate().publicKey;
console.log(
  hasWallet
    ? `Using your bot wallet address ${owner.toBase58()} (read-only)`
    : `No bot wallet yet; using a random empty address ${owner.toBase58()}`,
);

const feed = new PumpPortalFeed(cfg.PUMPPORTAL_WS, cfg.PUMPPORTAL_API_KEY);
const mint = await new Promise<string>((resolve) => {
  feed.on("newToken", (e) => {
    if (e.pool === "pump" && !e.isMayhem) resolve(e.mint);
  });
  feed.start();
});
feed.stop();
console.log(`Test coin: ${mint}`);
await new Promise((r) => setTimeout(r, 3000));

const tx = await buildTradeTx(owner, cfg.PRIORITY_FEE_SOL, {
  action: "buy",
  mint,
  amount: cfg.TRADE_SIZE_SOL,
  denominatedInSol: "true",
  slippage: cfg.BUY_SLIPPAGE_PCT,
});
const keys = tx.message.staticAccountKeys;
const programs = [...new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58()))];
console.log("Programs called by the transaction:");
for (const p of programs) console.log(`  ${p}${BASE_ALLOWED_PROGRAMS.includes(p) ? "" : "   <-- NOT in allow-list"}`);

const extra = cfg.EXTRA_ALLOWED_PROGRAMS.split(",").map((s) => s.trim()).filter(Boolean);
const problem = inspectTransaction(tx, owner, new Set([...BASE_ALLOWED_PROGRAMS, ...extra]));
console.log(problem ? `Safety inspection: REFUSED — ${problem}` : "Safety inspection: PASSED");

const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) {
  const tail = (sim.value.logs ?? []).slice(-3).join("\n  ");
  console.log(`Simulation: failed (expected if the wallet has no SOL): ${JSON.stringify(sim.value.err)}\n  ${tail}`);
} else {
  console.log(`Simulation: OK (${sim.value.unitsConsumed} compute units)`);
}
process.exit(0);
