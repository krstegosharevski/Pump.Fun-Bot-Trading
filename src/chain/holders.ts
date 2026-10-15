import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { bondingCurvePda, TOKEN_TOTAL_SUPPLY } from "./curve";
import type { HolderSafety } from "../strategy/stretch";

const SUPPLY = Number(TOKEN_TOTAL_SUPPLY);

/**
 * Who holds a pump.fun coin, as a % of total supply: the creator, and the 10 largest
 * holders (the bonding curve's own account, the unsold supply, is left out).
 *
 * The creator check uses a plain account read and works on any RPC. The top-holder check
 * needs getTokenLargestAccounts, which the free public RPC refuses; on that RPC the top-holder
 * figures come back as null ("unchecked") instead of failing the whole check.
 */
export async function checkHolders(conn: Connection, mint: string, creator: string): Promise<HolderSafety> {
  const mintKey = new PublicKey(mint);
  const mintInfo = await conn.getAccountInfo(mintKey);
  if (!mintInfo) throw new Error("mint not found");
  const tokenProgram = mintInfo.owner;

  let devRaw = 0;
  if (creator) {
    const devAta = getAssociatedTokenAddressSync(mintKey, new PublicKey(creator), false, tokenProgram);
    const acc = await conn.getAccountInfo(devAta);
    if (acc && acc.data.length >= 72) devRaw = Number(acc.data.readBigUInt64LE(64));
  }

  let top10Pct: number | null = null;
  let top1Pct: number | null = null;
  try {
    const curveVault = getAssociatedTokenAddressSync(mintKey, bondingCurvePda(mintKey), true, tokenProgram).toBase58();
    const largest = await conn.getTokenLargestAccounts(mintKey);
    const holders = largest.value
      .filter((a) => a.address.toBase58() !== curveVault)
      .map((a) => Number(a.amount))
      .sort((a, b) => b - a);
    top10Pct = (holders.slice(0, 10).reduce((sum, x) => sum + x, 0) / SUPPLY) * 100;
    top1Pct = ((holders[0] ?? 0) / SUPPLY) * 100;
  } catch {
    // Not allowed on this RPC (the public endpoint answers 429 for this call).
  }
  return { top10Pct, top1Pct, devPct: (devRaw / SUPPLY) * 100 };
}
