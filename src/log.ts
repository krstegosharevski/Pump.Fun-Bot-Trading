import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "trade" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  trade: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const LOG_DIR = "logs";
let stream: fs.WriteStream | undefined;
function fileStream(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(path.join(LOG_DIR, "bot.log"), { flags: "a" });
  }
  return stream;
}

export interface LogLine {
  t: number;
  level: Level;
  msg: string;
}

/** Last lines kept in memory for the dashboard. */
export const recentLogs: LogLine[] = [];
const MAX_RECENT = 60;

function write(level: Level, msg: string) {
  const t = Date.now();
  const line = `${new Date(t).toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (process.env.VITEST) return;
  fileStream().write(line + "\n");
  if (level === "debug" && !process.env.DEBUG) return;
  console.log(`${COLORS[level]}${line}\x1b[0m`);
  if (level !== "debug") {
    recentLogs.push({ t, level, msg });
    if (recentLogs.length > MAX_RECENT) recentLogs.shift();
  }
}

export const log = {
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  trade: (m: string) => write("trade", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
