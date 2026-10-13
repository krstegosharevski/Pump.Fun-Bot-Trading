import fs from "node:fs";

// Usage: npm run report                  (paper trades, all bots)
//        npm run report -- --bot tabak   (only one bot: primal or tabak)
//        npm run report -- --live        (live trades)
const mode = process.argv.includes("--live") ? "live" : "paper";
const botFilter = process.argv.includes("--bot") ? process.argv[process.argv.indexOf("--bot") + 1] : undefined;
const file = `data/${mode}-trades.csv`;
if (!fs.existsSync(file)) {
  console.log(`No ${mode} trades yet (${file} not found). Let the bot run for a while first.`);
  process.exit(0);
}

const [headerLine, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
const header = headerLine.split(",");
const allRows = lines.map((line) => {
  const cells = line.split(",");
  const row: Record<string, string> = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  row.bot ||= "primal"; // trades from before bots existed
  return row;
});
const rows = botFilter ? allRows.filter((r) => r.bot === botFilter) : allRows;
if (rows.length === 0) {
  console.log(botFilter ? `No trades by ${botFilter} yet.` : "No trades yet.");
  process.exit(0);
}

const n = (v: string) => Number(v);
const pnl = rows.map((r) => n(r.pnlSol));
const wins = rows.filter((r) => n(r.pnlSol) > 0);
const losses = rows.filter((r) => n(r.pnlSol) <= 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

let cum = 0;
let peak = 0;
let maxDd = 0;
for (const p of pnl) {
  cum += p;
  peak = Math.max(peak, cum);
  maxDd = Math.max(maxDd, peak - cum);
}

const grossWin = sum(wins.map((r) => n(r.pnlSol)));
const grossLoss = -sum(losses.map((r) => n(r.pnlSol)));
const totalFees = sum(rows.map((r) => n(r.feesSol)));
const volume = sum(rows.map((r) => n(r.costSol) + Math.max(0, n(r.proceedsSol))));
const best = rows.reduce((a, b) => (n(b.pnlSol) > n(a.pnlSol) ? b : a));
const worst = rows.reduce((a, b) => (n(b.pnlSol) < n(a.pnlSol) ? b : a));

let startLine = "";
const stateFile = `data/${mode}-state.json`;
if (fs.existsSync(stateFile)) {
  const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  startLine = `Start balance      ${s.startSol.toFixed(4)} SOL   cash now ${s.cashSol.toFixed(4)} SOL   open positions ${s.positions.length}`;
}

const sign = (x: number, d = 4) => (x >= 0 ? "+" : "") + x.toFixed(d);
const out = [
  `=== ${mode.toUpperCase()} TRADING REPORT${botFilter ? ` — ${botFilter.toUpperCase()} ONLY` : ""} ===`,
  `Period             ${rows[0].closedAt}  →  ${rows.at(-1)!.closedAt}`,
  startLine,
  `Trades             ${rows.length}   (${wins.length} wins / ${losses.length} losses, win rate ${((wins.length / rows.length) * 100).toFixed(1)}%)`,
  `Net P&L            ${sign(sum(pnl))} SOL`,
  `Expectancy         ${sign(avg(pnl), 5)} SOL per trade`,
  `Avg win / loss     ${sign(avg(wins.map((r) => n(r.pnlPct))), 1)}% / ${sign(avg(losses.map((r) => n(r.pnlPct))), 1)}%`,
  `Profit factor      ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞"}   (>1.0 means profitable)`,
  `Max drawdown       ${maxDd.toFixed(4)} SOL`,
  `Fees paid          ${totalFees.toFixed(4)} SOL   (${volume > 0 ? ((totalFees / volume) * 100).toFixed(2) : "0"}% of volume)`,
  `Avg hold           ${avg(rows.map((r) => n(r.holdSec))).toFixed(0)}s`,
  `Best trade         ${best.symbol} ${sign(n(best.pnlSol))} SOL (${sign(n(best.pnlPct), 1)}%)`,
  `Worst trade        ${worst.symbol} ${sign(n(worst.pnlSol))} SOL (${sign(n(worst.pnlPct), 1)}%)`,
  "",
];
if (!startLine) out.splice(2, 1);

const bots = [...new Set(rows.map((r) => r.bot))];
if (bots.length > 1) {
  out.push("By bot:");
  for (const bot of bots) {
    const rs = rows.filter((r) => r.bot === bot);
    const w = rs.filter((r) => n(r.pnlSol) > 0).length;
    out.push(
      `  ${bot.padEnd(15)} ${String(rs.length).padStart(4)} trades   win ${((w / rs.length) * 100).toFixed(0).padStart(3)}%   avg ${sign(avg(rs.map((r) => n(r.pnlPct))), 1).padStart(7)}%   total ${sign(sum(rs.map((r) => n(r.pnlSol))))} SOL`,
    );
  }
  out.push("");
}
out.push("By exit reason:");

const reasons = [...new Set(rows.map((r) => r.reason))];
for (const reason of reasons) {
  const rs = rows.filter((r) => r.reason === reason);
  out.push(
    `  ${reason.padEnd(15)} ${String(rs.length).padStart(4)} trades   avg ${sign(avg(rs.map((r) => n(r.pnlPct))), 1).padStart(7)}%   total ${sign(sum(rs.map((r) => n(r.pnlSol))))} SOL`,
  );
}
console.log(out.join("\n"));
