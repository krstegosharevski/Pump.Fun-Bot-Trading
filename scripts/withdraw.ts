import fs from "node:fs";
import readline from "node:readline/promises";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { loadConfig } from "../src/config";
import { makeConnection } from "../src/chain/rpc";
import { loadWallet } from "../src/exec/live";

// Usage: npm run wallet:withdraw -- <DESTINATION_ADDRESS>
// Sends all SOL in the bot wallet (minus the network fee) to your own wallet.
const { cfg } = loadConfig([]);
const destArg = process.argv[2];
if (!destArg) {
  console.log("Usage: npm run wallet:withdraw -- <DESTINATION_ADDRESS>");
  process.exit(1);
}
let dest: PublicKey;
try {
  dest = new PublicKey(destArg);
} catch {
  console.log("That is not a valid Solana address.");
  process.exit(1);
}

const wallet = loadWallet(cfg.WALLET_PATH);
const conn = makeConnection(cfg.RPC_URL);
if (fs.existsSync("data/live-state.json")) {
  const s = JSON.parse(fs.readFileSync("data/live-state.json", "utf8"));
  if (s.positions?.length) {
    console.log(`Warning: the bot still has ${s.positions.length} open live position(s). Close them first from the dashboard.`);
  }
}

const balance = await conn.getBalance(wallet.publicKey, "confirmed");
const fee = 5000;
const amount = balance - fee;
if (amount <= 0) {
  console.log("Nothing to withdraw.");
  process.exit(0);
}

console.log(`From: ${wallet.publicKey.toBase58()}`);
console.log(`To:   ${dest.toBase58()}`);
console.log(`Amount: ${(amount / 1e9).toFixed(6)} SOL`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("Double-check the destination address. Type YES to send: ");
rl.close();
if (answer.trim() !== "YES") {
  console.log("Cancelled.");
  process.exit(0);
}

const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
  SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports: amount }),
);
tx.sign(wallet);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
console.log(`Sent. Transaction: https://solscan.io/tx/${sig}`);
