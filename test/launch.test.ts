import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config";
import { shouldExitLaunch, shouldSnipe } from "../src/strategy/launch";
import { BOTS, botConfig, isBotId, settingsSummary } from "../src/bots/registry";
import { CSV_HEADER, Portfolio } from "../src/portfolio";

const T0 = 1_700_000_000_000;
const coin = { createdAt: T0, name: "Moon Cat", symbol: "MCAT", creator: "Creator111" };
const free = { busy: false, lastDoneAt: 0 };

describe("Tabak 1-1 entry (launch sniper)", () => {
  const cfg = defaultConfig();

  it("buys a coin seen within the age limit", () => {
    expect(shouldSnipe(coin, T0 + 800, cfg, free).enter).toBe(true);
  });

  it("skips coins that are already too old", () => {
    expect(shouldSnipe(coin, T0 + (cfg.TABAK_MAX_TOKEN_AGE_SEC + 1) * 1000, cfg, free)).toMatchObject({ enter: false, final: true });
  });

  it("takes one coin at a time and pauses between coins", () => {
    expect(shouldSnipe(coin, T0 + 500, cfg, { busy: true, lastDoneAt: 0 }).enter).toBe(false);
    const justSold = { busy: false, lastDoneAt: T0 - 5_000 };
    expect(shouldSnipe(coin, T0 + 500, cfg, justSold)).toMatchObject({ enter: false, reason: expect.stringMatching(/pausing/) });
    const longAgo = { busy: false, lastDoneAt: T0 - (cfg.TABAK_WAIT_BEFORE_NEW_TOKEN_SEC + 1) * 1000 };
    expect(shouldSnipe(coin, T0 + 500, cfg, longAgo).enter).toBe(true);
  });

  it("applies the name and creator filters", () => {
    expect(shouldSnipe(coin, T0 + 500, { ...cfg, TABAK_MATCH_STRING: "cat" }, free).enter).toBe(true);
    expect(shouldSnipe(coin, T0 + 500, { ...cfg, TABAK_MATCH_STRING: "dog" }, free)).toMatchObject({ final: true });
    expect(shouldSnipe(coin, T0 + 500, { ...cfg, TABAK_CREATOR: "Someone" }, free)).toMatchObject({ final: true });
  });

  it("waits after creation when extreme fast mode is off", () => {
    const slow = { ...cfg, TABAK_EXTREME_FAST: false };
    expect(shouldSnipe(coin, T0 + 5_000, slow, free)).toMatchObject({ enter: false });
    expect(shouldSnipe(coin, T0 + slow.TABAK_WAIT_AFTER_CREATION_SEC * 1000 + 500, slow, free).enter).toBe(true);
    expect(shouldSnipe(coin, T0 + 60_000, slow, free)).toMatchObject({ final: true });
  });
});

describe("Tabak 1-1 exits", () => {
  const pos = { openedAt: T0, entryPriceSol: 1 };

  it("time_based sells after the wait, whatever the price", () => {
    const cfg = defaultConfig({ TABAK_EXIT_STRATEGY: "time_based" });
    expect(shouldExitLaunch(pos, 0.3, false, T0 + 14_000, cfg)).toBeNull();
    expect(shouldExitLaunch(pos, 5, false, T0 + 14_000, cfg)).toBeNull();
    expect(shouldExitLaunch(pos, 1, false, T0 + 15_000, cfg)).toBe("time_exit");
  });

  it("tp_sl checks take profit, then stop loss, then max hold", () => {
    const cfg = defaultConfig({ TABAK_EXIT_STRATEGY: "tp_sl" });
    expect(shouldExitLaunch(pos, 1.41, false, T0 + 1_000, cfg)).toBe("take_profit");
    expect(shouldExitLaunch(pos, 0.59, false, T0 + 1_000, cfg)).toBe("stop_loss");
    expect(shouldExitLaunch(pos, 1.1, false, T0 + 15_000, cfg)).toBe("max_hold");
    expect(shouldExitLaunch(pos, 1.1, false, T0 + 1_000, cfg)).toBeNull();
  });

  it("always sells when the coin graduates", () => {
    expect(shouldExitLaunch(pos, 1, true, T0 + 1_000, defaultConfig())).toBe("graduated");
  });
});

describe("bot registry", () => {
  it("lists all four bots", () => {
    expect(BOTS.map((b) => b.name)).toEqual(["Primal 1-1", "Tabak 1-1", "Blazebit 1-1", "ErenTinx 3"]);
    expect(isBotId("tabak")).toBe(true);
    expect(isBotId("nope")).toBe(false);
  });

  it("gives Tabak one position at a time and its own trade cap", () => {
    const cfg = defaultConfig({ MAX_OPEN_POSITIONS: 3 });
    expect(botConfig(cfg, "tabak")).toMatchObject({ MAX_OPEN_POSITIONS: 1, MAX_TRADES_PER_HOUR: cfg.TABAK_MAX_TRADES_PER_HOUR });
    expect(botConfig(cfg, "primal").MAX_OPEN_POSITIONS).toBe(3);
    expect(settingsSummary(cfg, "tabak").map((r) => r.label)).toContain("Sells");
  });
});

describe("shared trade log", () => {
  it("adds a bot column to logs written before bots existed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-"));
    const oldHeader = CSV_HEADER.replace(/,bot$/, "");
    const oldRow = "2026-10-13T10:00:00.000Z,AAA,m1,stop_loss,5,1e-7,8e-8,0.19,0.15,-0.04,-20,0.006,x,paper,paper";
    fs.writeFileSync(path.join(dir, "paper-trades.csv"), `${oldHeader}\n${oldRow}\n`);

    const pf = new Portfolio("paper", 1, 1, 0, dir);
    const fill = { ok: true, solDelta: -0.2, tokensRaw: 1000n, priceSol: 1e-7, feesSol: 0.003, rentSol: 0.002 };
    pf.open({ mint: "m2", symbol: "BBB", name: "B", entryReason: "snipe", bot: "tabak" }, fill, 0);
    pf.close("m2", { ...fill, solDelta: 0.21 }, "time_exit", 15_000);

    const lines = fs.readFileSync(path.join(dir, "paper-trades.csv"), "utf8").trim().split("\n");
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines[1].endsWith(",primal")).toBe(true);
    expect(lines[2].endsWith(",tabak")).toBe(true);
  });
});
