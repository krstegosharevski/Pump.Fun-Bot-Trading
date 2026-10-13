import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../src/config";
import { loadWallet } from "../src/exec/live";

// Creates a fresh burner wallet for the bot. The secret key stays in the file;
// only the public address is printed.
const { cfg } = loadConfig([]);
const file = cfg.WALLET_PATH;

if (fs.existsSync(file)) {
  const existing = loadWallet(file);
  console.log(`A bot wallet already exists at ${file} — not overwriting it.`);
  console.log(`Address: ${existing.publicKey.toBase58()}`);
  process.exit(1);
}

const kp = Keypair.generate();
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });

console.log("New bot wallet created.");
console.log(`  File:    ${file}   (keep it private and back it up; never share or commit it)`);
console.log(`  Address: ${kp.publicKey.toBase58()}`);
console.log("");
console.log("Send only the amount you are willing to lose (e.g. ~$25 of SOL) to the address above.");
console.log("To move funds back out later: npm run wallet:withdraw -- <your main wallet address>");
