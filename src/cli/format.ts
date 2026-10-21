import { statSync } from "node:fs";
import { currentMode } from "../app.js";
import type { ModeState } from "../core/mode.js";
import type { MonthCoverage } from "../core/store.js";

export const noun = (n: number, word: string) => (n === 1 ? word : `${word}s`);

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Size of the index file and its write-ahead log. */
export function indexSize(path: string): string {
  let bytes = 0;
  for (const file of [path, `${path}-wal`]) {
    try {
      bytes += statSync(file).size;
    } catch {
      // No WAL file.
    }
  }
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function describeMode(state: ModeState, cwd: string): string {
  const here = currentMode(cwd);
  const why = here.source === "path" ? `rule for ${here.rule}` : here.source;
  const rules = Object.entries(state.paths ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return [
    `knowledge mode here: ${here.mode} (${why})`,
    `global: ${state.global ?? "off"}`,
    rules.length
      ? `rules:\n${rules.map(([dir, mode]) => `  ${mode.padEnd(3)} ${dir}`).join("\n")}`
      : "rules: none",
  ].join("\n");
}

/**
 * Sessions per month (rows) and tool (columns), with chunks in parentheses: a month with few or
 * no sessions of a tool you used then points at sources that were not indexed.
 */
export function formatCoverage(rows: MonthCoverage[]): string {
  const tools = [...new Set(rows.map((r) => r.tool))].sort();
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const cell = new Map(rows.map((r) => [`${r.month} ${r.tool}`, `${r.sessions} (${r.chunks})`]));
  const table = [
    ["month", ...tools],
    ...months.map((month) => [month, ...tools.map((tool) => cell.get(`${month} ${tool}`) ?? "-")]),
  ];
  const widths = tools.map((_, i) => Math.max(...table.map((line) => line[i + 1]?.length ?? 0)));
  return [
    ...table.map(([month, ...cells]) =>
      [(month ?? "").padEnd(7), ...cells.map((c, i) => c.padStart(widths[i] ?? 0))].join("  "),
    ),
    "sessions (chunks) of transcripts, by the month each chunk started",
  ].join("\n");
}
