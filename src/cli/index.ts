#!/usr/bin/env node
// Must come first: it configures SQLite before better-sqlite3 is loaded.
import "./sqlite-uri.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  currentMode,
  defaultAdapters,
  indexPath,
  loreHome,
  memoryPath,
  modePath,
  openDefault,
  openExisting,
  openIndexReadOnly,
  wordsPath,
} from "../app.js";
import { DEFAULT_MAX_CHARS } from "../core/consolidate.js";
import { DEFAULT_AROUND, getContext, MAX_AROUND } from "../core/context.js";
import {
  embedMissing,
  hasRuntime,
  installRuntime,
  loadEmbedder,
  TRANSFORMERS_VERSION,
} from "../core/embedder.js";
import { errorMessage } from "../core/errors.js";
import { formatChunks, formatHits, labelField, tildeHome as tilde } from "../core/format.js";
import { indexAll, type ProgressFn } from "../core/indexer.js";
import { withLock } from "../core/lock.js";
import { notedProjects } from "../core/memory.js";
import {
  type KnowledgeMode,
  type ModeState,
  readModeState,
  readModeStateStrict,
  setGlobalMode,
  setPathMode,
  writeModeState,
} from "../core/mode.js";
import { normalizeProject } from "../core/project.js";
import { ensureFresh, freshnessNote, type Runtime } from "../core/runtime.js";
import { DEFAULT_LIMIT, dateBound, noHitsMessage, search } from "../core/search.js";
import type { Store } from "../core/store.js";
import { loadPhrases } from "../core/words.js";
import {
  claudeHookStatus,
  claudeSettingsPath,
  hookCommand,
  installClaudeHook,
  sessionProject,
  uninstallClaudeHook,
} from "../integrations/claude-code.js";
import {
  parseTime,
  type SchedulePlan,
  type Command as SchedulerCommand,
  schedulePlan,
} from "../integrations/schedule.js";
import { VERSION } from "../version.js";
import { describeMode, formatCoverage, indexSize, localTime, noun, seconds } from "./format.js";
import {
  runClaudePromptHook,
  runClaudeSessionEndHook,
  runClaudeSessionStartHook,
  runClaudeStopHook,
} from "./hook.js";
import {
  maxProjectsOption,
  registerMemoryCommands,
  reindexNotes,
  runConsolidation,
} from "./memory.js";

/** Failed sources listed by `lore index`; the rest are only counted. */
const SHOWN_FAILURES = 5;
/** Most results `lore search` shows: each one is ranked and snippeted. */
const MAX_SEARCH_LIMIT = 100;

/**
 * The embedding of a search query when semantic search is set up (`lore embed`), else undefined.
 * A failure is reported and the search goes on with keywords only.
 */
async function queryVector(store: Store, query: string): Promise<Float32Array | undefined> {
  if (!store.embeddingModel() || !hasRuntime(loreHome())) return undefined;
  try {
    const embedder = await loadEmbedder(loreHome());
    return (await embedder?.embed([query], "query"))?.[0];
  } catch (error) {
    console.error(`semantic search unavailable (${errorMessage(error)}); keywords only.`);
    return undefined;
  }
}

/** Embed new chunks after indexing when semantic search is set up; never downloads. */
async function embedNew(store: Store): Promise<void> {
  if (!store.embeddingModel() || !hasRuntime(loreHome())) return;
  try {
    const embedder = await loadEmbedder(loreHome());
    if (!embedder) return;
    const n = await embedMissing(store, embedder);
    if (n) console.log(`Embedded ${n} new ${noun(n, "chunk")} for semantic search.`);
  } catch (error) {
    console.error(`could not embed new chunks: ${errorMessage(error)}`);
  }
}

interface SearchCommandOptions {
  limit: number;
  project?: string;
  since?: string;
  until?: string;
  said?: "user" | "decision";
  /** False with --no-semantic. */
  semantic: boolean;
}

/** Run a command; failures print one line and exit 1. */
function action<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(`lore: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  };
}

async function withRuntime<T>(fn: (runtime: Runtime) => T | Promise<T>): Promise<T> {
  const runtime = openDefault();
  try {
    return await fn(runtime);
  } finally {
    runtime.store.close();
  }
}

const EMPTY_INDEX = "Index is empty — run `lore index` first.";

/** `withRuntime` that creates nothing and calls `empty` when there is no index yet. */
async function withExistingRuntime(
  fn: (runtime: Runtime) => unknown,
  empty: () => void,
): Promise<void> {
  const runtime = openExisting();
  if (!runtime) return empty();
  try {
    await fn(runtime);
  } finally {
    runtime.store.close();
  }
}

function searchLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SEARCH_LIMIT) {
    throw new InvalidArgumentError(`must be an integer from 1 to ${MAX_SEARCH_LIMIT}.`);
  }
  return n;
}

const dateOption = (side: "since" | "until") => (value: string) => {
  const bound = dateBound(value, side);
  if (!bound) throw new InvalidArgumentError("must be a date (YYYY-MM-DD) or an ISO 8601 time.");
  return bound;
};

function saidOption(value: string): "user" | "decision" {
  if (value !== "user" && value !== "decision") {
    throw new InvalidArgumentError('must be "user" or "decision".');
  }
  return value;
}

function aroundCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AROUND) {
    throw new InvalidArgumentError(`must be an integer from 0 to ${MAX_AROUND}.`);
  }
  return n;
}

const program = new Command()
  .name("lore")
  .description("Your second brain for AI coding agents: local-first memory shared across tools")
  .version(VERSION);

program
  .command("index")
  .description("Index new sessions from all supported tools (first run backfills everything)")
  .option(
    "--rebuild",
    "drop the index and rebuild it from scratch (sessions kept from deleted transcripts stay)",
  )
  .option("--consolidate", "then update project notes from new sessions (see `lore consolidate`)")
  .option(...maxProjectsOption)
  .action(
    action((options: { rebuild?: boolean; consolidate?: boolean; maxProjects: number }) =>
      withRuntime(async (runtime) => {
        const { store, adapters, lockPath } = runtime;
        const started = Date.now();
        const progress: ProgressFn | undefined = process.stderr.isTTY
          ? ({ tool, done, total }) =>
              process.stderr.write(
                `\r${tool}: ${done}/${total} sources · ${seconds(Date.now() - started)}   `,
              )
          : undefined;
        const stats = await withLock(lockPath, (touch) => {
          if (options.rebuild) store.reset();
          return indexAll(store, adapters, {
            heartbeat: touch,
            onProgress: progress,
            maintain: true,
          });
        });
        if (progress) process.stderr.write("\n");
        if (!stats) {
          console.error("Another `lore index` is running. Try again shortly.");
          process.exitCode = 1;
          return;
        }
        for (const { tool, root } of stats.missing) {
          console.error(`${tool}: ${tilde(root)} not found — skipped`);
        }
        console.log(
          `Indexed ${stats.sources} ${noun(stats.sources, "source")} → ${stats.chunks} ${noun(stats.chunks, "chunk")} in ${seconds(Date.now() - started)} (skipped ${stats.skipped} unreadable records, kept ${stats.archived} deleted ${noun(stats.archived, "source")} in the archive, errors ${stats.errors}).`,
        );
        if (stats.errors > 0) {
          console.error(
            `${stats.errors} source(s) or folder(s) could not be read and were skipped; check their permissions. They will be retried on the next run.`,
          );
          const shown = stats.failures.slice(0, SHOWN_FAILURES);
          for (const { source, message } of shown) console.error(`  ${source}: ${message}`);
          if (stats.errors > shown.length) {
            console.error(`  … and ${stats.errors - shown.length} more`);
          }
        }
        await embedNew(store);
        if (options.consolidate) {
          await runConsolidation(runtime, {
            maxProjects: options.maxProjects,
            maxChars: DEFAULT_MAX_CHARS,
          });
        }
      }),
    ),
  );

program
  .command("search")
  .description("Search knowledge across all projects and tools")
  .argument("<query...>", "keywords or a question")
  .option("-n, --limit <n>", `max results (1-${MAX_SEARCH_LIMIT})`, searchLimit, DEFAULT_LIMIT)
  .option(
    "-p, --project <path>",
    "restrict to one project and its subfolders (a path, ~/…, or a …/a/b label from a result)",
  )
  .option(
    "--since <date>",
    "only sessions from this UTC day (YYYY-MM-DD) or time on",
    dateOption("since"),
  )
  .option(
    "--until <date>",
    "only sessions up to this UTC day (inclusive) or time",
    dateOption("until"),
  )
  .option("--no-semantic", "keywords only, even when `lore embed` set up semantic search")
  .option(
    "--said <who>",
    "user: only where your own words match; decision: only your decisions",
    saidOption,
  )
  .action(
    action((query: string[], options: SearchCommandOptions) =>
      withExistingRuntime(
        async (runtime) => {
          // Like the MCP server: refresh a stale index first (never the first full backfill).
          const freshness = await ensureFresh(runtime);
          if (freshness === "never-indexed") {
            console.log(EMPTY_INDEX);
            return;
          }
          const text = query.join(" ");
          const vector = options.semantic ? await queryVector(runtime.store, text) : undefined;
          const phrases = loadPhrases(wordsPath(), (p) => console.error(`warning: ${p}`));
          const hits = search(runtime.store, text, { ...options, vector, phrases });
          console.log(
            hits.length ? formatHits(hits) : noHitsMessage(runtime.store, text, options.project),
          );
          const note = freshnessNote(freshness);
          if (note) console.error(note);
        },
        () => console.log(EMPTY_INDEX),
      ),
    ),
  );

program
  .command("embed")
  .description(
    "Set up semantic search: install the model runtime and embed every chunk (downloads once)",
  )
  .option("--remove", "drop the vectors and turn semantic search off")
  .action(
    action((options: { remove?: boolean }) =>
      withRuntime(async ({ store }) => {
        if (options.remove) {
          store.dropEmbeddings();
          console.log("Semantic search is off; its vectors are deleted.");
          return;
        }
        if (!store.chunkCount()) {
          console.log(EMPTY_INDEX);
          return;
        }
        const home = loreHome();
        if (!hasRuntime(home)) {
          console.log(
            `Installing @huggingface/transformers@${TRANSFORMERS_VERSION} into ${tilde(join(home, "runtime"))} (about 500 MB)…`,
          );
          installRuntime(home);
        }
        console.log("Loading the model (downloaded once, about 150 MB)…");
        const embedder = await loadEmbedder(home, { download: true });
        if (!embedder) throw new Error("the model runtime could not be installed.");
        const started = Date.now();
        const { total } = store.embeddingCounts();
        const n = await embedMissing(store, embedder, (done) => {
          if (process.stderr.isTTY) {
            process.stderr.write(`\r${done}/${total} chunks · ${seconds(Date.now() - started)}   `);
          }
        });
        if (process.stderr.isTTY) process.stderr.write("\n");
        console.log(
          `Embedded ${n} ${noun(n, "chunk")} in ${seconds(Date.now() - started)}. Searches now also match by meaning; \`lore index\` embeds new chunks.`,
        );
      }),
    ),
  );

program
  .command("coverage")
  .description("Show how many sessions are indexed per month and tool")
  .option("-p, --project <path>", "only this project and its subfolders")
  .action(
    action((options: { project?: string }) => {
      // Read-only, like `lore status`.
      const store = openIndexReadOnly();
      try {
        const rows = store?.coverage(normalizeProject(options.project)) ?? [];
        if (!rows.length) {
          console.log(store ? "No sessions indexed." : EMPTY_INDEX);
          return;
        }
        console.log(formatCoverage(rows));
      } finally {
        store?.close();
      }
    }),
  );

program
  .command("forget")
  .description("Remove a session kept from a deleted transcript, from the index and its archive")
  .argument("<id>", "the id printed with a search result")
  .action(
    action((id: string) =>
      withExistingRuntime(
        ({ store }) => {
          const found = getContext(store, id, 0);
          const target = found.ok ? found.chunks[0] : undefined;
          if (!target) {
            console.error(found.ok ? `No chunk with id ${id}.` : found.message);
            process.exitCode = 1;
            return;
          }
          const forgotten = store.forgetSession(target.sessionId);
          if (!forgotten) {
            console.error(
              `Session ${labelField(target.sessionId)} still has its transcript (${tilde(target.sourceId)}): delete that first, run \`lore index\`, then \`lore forget\` again.`,
            );
            process.exitCode = 1;
            return;
          }
          console.log(
            `Forgot session ${labelField(target.sessionId)} (${forgotten} deleted ${noun(forgotten, "transcript")}).`,
          );
        },
        () => {
          console.error(EMPTY_INDEX);
          process.exitCode = 1;
        },
      ),
    ),
  );

program
  .command("show")
  .description("Show a search result in full, with neighbouring chunks of its session")
  .argument("<id>", "the id printed with a search result")
  .option(
    "-a, --around <n>",
    `chunks before and after it (0-${MAX_AROUND})`,
    aroundCount,
    DEFAULT_AROUND,
  )
  .action(
    action((id: string, options: { around: number }) =>
      withExistingRuntime(
        ({ store }) => {
          const result = getContext(store, id, options.around);
          if (!result.ok) {
            console.error(result.message);
            process.exitCode = 1;
            return;
          }
          console.log(formatChunks(result.chunks, { untrusted: false }));
        },
        () => {
          console.error(EMPTY_INDEX);
          process.exitCode = 1;
        },
      ),
    ),
  );

program
  .command("status")
  .description("Show what is indexed")
  .action(
    action(() => {
      const path = indexPath();
      // Read-only: reporting status never creates or rebuilds the index.
      const store = openIndexReadOnly();
      try {
        const counts = new Map((store?.stats() ?? []).map((s) => [s.tool, s]));
        const tools = [...new Set([...defaultAdapters().map((a) => a.tool), ...counts.keys()])];
        const width = Math.max(...tools.map((tool) => tool.length));
        for (const tool of tools) {
          const { sources = 0, chunks = 0 } = counts.get(tool) ?? {};
          console.log(
            `${tool.padEnd(width)} ${String(sources).padStart(6)} ${noun(sources, "source").padEnd(7)} ${String(chunks).padStart(8)} ${noun(chunks, "chunk")}`,
          );
        }
        console.log(`projects: ${store?.projectCount() ?? 0}`);
        const model = store?.embeddingModel();
        if (store && model) {
          const { embedded, total } = store.embeddingCounts();
          console.log(`semantic search: ${embedded}/${total} chunk texts embedded (${model})`);
        }
        const kept = store?.archivedSessionCount() ?? 0;
        if (kept) {
          console.log(
            `kept from deleted transcripts: ${kept} ${noun(kept, "session")} (\`lore forget <id>\` removes one)`,
          );
        }
        const noted = notedProjects(memoryPath()).length;
        if (noted) console.log(`project memory: ${noted} ${noun(noted, "project")} with notes`);
        console.log(`index: ${tilde(path)} (${store ? indexSize(path) : "not created yet"})`);
        const last = store?.getMeta("lastIndexedAt");
        console.log(`last indexed: ${last ? localTime(last) : "never — run `lore index`"}`);
      } finally {
        store?.close();
      }
    }),
  );

program
  .command("mode")
  .description("Show or set knowledge mode (agents search past sessions at the start of each task)")
  .argument("[state]", "on, off, or reset (with --here)")
  .option("--here", "set a rule for the current folder and its subfolders instead of globally")
  .action(
    action((state: string | undefined, options: { here?: boolean }) => {
      const file = modePath();
      const cwd = process.cwd();
      if (state !== undefined) {
        if (state !== "on" && state !== "off" && state !== "reset") {
          throw new Error(`mode must be on, off or reset, not "${state}".`);
        }
        if (state === "reset" && !options.here) {
          throw new Error("use `lore mode reset --here` to remove the rule for this folder.");
        }
        let current: ModeState;
        try {
          current = readModeStateStrict(file);
        } catch (error) {
          throw new Error(
            `${errorMessage(error)}; nothing was changed. Fix or delete it, then try again.`,
          );
        }
        const mode: KnowledgeMode | undefined = state === "reset" ? undefined : state;
        writeModeState(
          file,
          options.here || !mode ? setPathMode(current, cwd, mode) : setGlobalMode(current, mode),
        );
      } else {
        try {
          readModeStateStrict(file);
        } catch (error) {
          console.error(`warning: ${errorMessage(error)}; its invalid parts are ignored.`);
        }
      }
      console.log(describeMode(readModeState(file), cwd));
    }),
  );

const hook = program
  .command("hook")
  .description("Run an agent hook (called by the agent; see `lore hooks install`)");

hook
  .command("claude-prompt")
  .description("Claude Code UserPromptSubmit hook: reads the hook's JSON on stdin")
  .action(runClaudePromptHook);

hook
  .command("claude-session-start")
  .description("Claude Code SessionStart hook: adds the project's memory")
  .action(runClaudeSessionStartHook);

hook
  .command("claude-stop")
  .description("Claude Code Stop hook: asks the agent to save decisions and what it learned")
  .action(runClaudeStopHook);

hook
  .command("claude-session-end")
  .description("Claude Code SessionEnd hook: indexes the session in the background")
  .action(runClaudeSessionEndHook);

function checkAgent(agent: string): void {
  if (agent !== "claude") {
    throw new Error(
      `no hook for "${agent}": only claude (Claude Code) is supported; other agents follow knowledge mode through the MCP tool description.`,
    );
  }
}

const hooks = program
  .command("hooks")
  .description("Install, remove or check the knowledge-mode hooks (Claude Code)");

const settingsOption = [
  "--settings <path>",
  "Claude Code settings file (default: $CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json)",
] as const;

hooks
  .command("install")
  .description("Add the hooks to Claude Code's settings (backed up first)")
  .argument("<agent>", "claude")
  .option(...settingsOption)
  .action(
    action((agent: string, options: { settings?: string }) => {
      checkAgent(agent);
      const file = options.settings ?? claudeSettingsPath();
      const cli = realpathSync(fileURLToPath(import.meta.url));
      const result = installClaudeHook(file, hookCommand(process.execPath, cli));
      if (!result.changed) {
        console.log(`Already installed in ${tilde(file)}.`);
        return;
      }
      console.log(`Installed the agentlore hooks in ${tilde(file)}.`);
      if (result.backup) console.log(`Backup: ${tilde(result.backup)}`);
      console.log(
        "Where knowledge mode is on (`lore mode on`), sessions start with the project's memory, prompts get related excerpts and news of changed notes, agents are asked to save decisions and what they learned, and ended sessions are indexed at once. New sessions pick them up.",
      );
    }),
  );

hooks
  .command("uninstall")
  .description("Remove the hooks from Claude Code's settings (backed up first)")
  .argument("<agent>", "claude")
  .option(...settingsOption)
  .action(
    action((agent: string, options: { settings?: string }) => {
      checkAgent(agent);
      const file = options.settings ?? claudeSettingsPath();
      const result = uninstallClaudeHook(file);
      if (!result.changed) {
        console.log(`Not installed in ${tilde(file)}.`);
        return;
      }
      console.log(`Removed the agentlore hooks from ${tilde(file)}.`);
      if (result.backup) console.log(`Backup: ${tilde(result.backup)}`);
    }),
  );

hooks
  .command("status")
  .description("Show whether the hooks are installed, and the knowledge mode here")
  .option(...settingsOption)
  .action(
    action((options: { settings?: string }) => {
      const file = options.settings ?? claudeSettingsPath();
      const status = claudeHookStatus(file);
      console.log(
        status.installed
          ? `claude: installed in ${tilde(file)}\n  ${status.command}`
          : `claude: not installed (${tilde(file)})`,
      );
      for (const missing of status.missing ?? []) {
        console.error(
          `warning: ${missing} does not exist; the hook cannot run. Run \`lore hooks install claude\` again.`,
        );
      }
      if (status.missingEvents) {
        console.error(
          `warning: no agentlore hook for ${status.missingEvents.join(", ")}; run \`lore hooks install claude\` again.`,
        );
      }
      console.log(`knowledge mode here: ${currentMode().mode}`);
    }),
  );

const DEFAULT_SCHEDULE_TIME = "12:30";

/** The daily job for this OS, running this CLI with this Node.js. */
function currentSchedulePlan(at = DEFAULT_SCHEDULE_TIME, consolidate = false): SchedulePlan {
  const time = parseTime(at);
  if (!time) throw new Error(`--at must be a time of day (HH:MM), not "${at}".`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith("AGENTLORE_") && !!entry[1],
    ),
  );
  // Consolidation runs `claude`, which the scheduler finds only on the user's PATH.
  if (consolidate && process.env.PATH) env.PATH = process.env.PATH;
  return schedulePlan({
    platform: process.platform,
    home: homedir(),
    node: process.execPath,
    cli: realpathSync(fileURLToPath(import.meta.url)),
    args: consolidate ? ["index", "--consolidate"] : ["index"],
    logFile: join(loreHome(), "schedule.log"),
    ...time,
    env,
    uid: process.getuid?.(),
    configHome: process.env.XDG_CONFIG_HOME,
  });
}

/** Runs a scheduler command; throws with its output unless it is optional. */
function runScheduler({ file, args, optional }: SchedulerCommand): boolean {
  try {
    execFileSync(file, args, { stdio: "pipe" });
    return true;
  } catch (error) {
    if (optional) return false;
    const output = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${file} ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
}

const isScheduled = (plan: SchedulePlan) =>
  plan.files[0]
    ? existsSync(plan.files[0].path)
    : plan.query
      ? runScheduler({ ...plan.query, optional: true })
      : false;

const describeCommand = ({ file, args }: SchedulerCommand) =>
  [file, ...args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");

const schedule = program
  .command("schedule")
  .description(
    "Run `lore index` once a day with the OS scheduler (launchd, systemd, Task Scheduler)",
  );

schedule
  .command("install")
  .description("Index new sessions daily, even on days nothing searches")
  .option("--at <time>", "time of day, HH:MM", DEFAULT_SCHEDULE_TIME)
  .option("--dry-run", "print what would be written and run, and change nothing")
  .option(
    "--consolidate",
    "then update project notes from new sessions with Claude Code (uses your quota)",
  )
  .action(
    action((options: { at: string; dryRun?: boolean; consolidate?: boolean }) => {
      const plan = currentSchedulePlan(options.at, options.consolidate);
      if (options.dryRun) {
        for (const { path, content } of plan.files) console.log(`# ${path}\n${content}`);
        for (const command of plan.install) console.log(`$ ${describeCommand(command)}`);
        return;
      }
      if (
        process.platform === "win32" &&
        Object.keys(process.env).some((k) => k.startsWith("AGENTLORE_"))
      ) {
        console.error("warning: the scheduled task does not get your AGENTLORE_* variables.");
      }
      for (const { path, content } of plan.files) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      plan.install.forEach(runScheduler);
      mkdirSync(loreHome(), { recursive: true });
      const job = options.consolidate ? "lore index --consolidate" : "lore index";
      console.log(`Scheduled \`${job}\` daily at ${options.at}: ${tilde(plan.where)}.`);
      if (process.platform !== "win32")
        console.log(`Log: ${tilde(join(loreHome(), "schedule.log"))}`);
      console.log("Run `lore schedule install` again after changing Node.js versions.");
    }),
  );

schedule
  .command("uninstall")
  .description("Remove the daily job")
  .action(
    action(() => {
      const plan = currentSchedulePlan();
      if (!isScheduled(plan)) {
        console.log("Not scheduled.");
        return;
      }
      plan.uninstall.forEach(runScheduler);
      for (const { path } of plan.files) rmSync(path, { force: true });
      plan.afterUninstall.forEach(runScheduler);
      console.log(`Removed the daily \`lore index\` (${tilde(plan.where)}).`);
    }),
  );

schedule
  .command("status")
  .description("Show whether the daily job is installed, and its last run")
  .action(
    action(() => {
      const plan = currentSchedulePlan();
      if (!isScheduled(plan)) {
        console.log(
          "Not scheduled: searches still refresh the index. `lore schedule install` adds a daily run.",
        );
        return;
      }
      console.log(`Scheduled: ${tilde(plan.where)}`);
      const content = plan.files[0] && readFileSync(plan.files[0].path, "utf8");
      if (content && !content.includes(process.execPath)) {
        console.error(
          "warning: it runs another Node.js than this one (moved or upgraded?). Run `lore schedule install` again.",
        );
      }
      const log = join(loreHome(), "schedule.log");
      const last = existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").at(-1)
        : undefined;
      if (last) console.log(`last run: ${last}`);
    }),
  );

program
  .command("mcp")
  .description(
    "Run the MCP server over stdio (register this in Claude Code, Codex, Cursor, Gemini, Antigravity)",
  )
  .action(
    action(async () => {
      // Lazy import: the MCP SDK is the slowest import, and the prompt hook must start fast.
      // The index is opened on the first tool call, so the server can explain a failure.
      const [{ createServer }, { StdioServerTransport }] = await Promise.all([
        import("../mcp/server.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js"),
      ]);
      // The model loads once, on the first search after `lore embed` set it up.
      let embedder: ReturnType<typeof loadEmbedder> | undefined;
      const queryVector = async (store: Store, query: string) => {
        if (!store.embeddingModel() || !hasRuntime(loreHome())) return undefined;
        embedder ??= loadEmbedder(loreHome());
        return (await (await embedder)?.embed([query], "query"))?.[0];
      };
      await createServer(() => openExisting(), {
        mode: () => currentMode(process.cwd()).mode,
        queryVector,
        // Read on every search, so edits apply without a restart.
        phrases: () => loadPhrases(wordsPath(), (p) => console.error(`agentlore: ${p}`)),
        memory: {
          root: memoryPath(),
          project: () => sessionProject(process.cwd()),
          projectOf: (path) => sessionProject(path),
          saved: reindexNotes,
        },
      }).connect(new StdioServerTransport());
    }),
  );

registerMemoryCommands(program, action);

await program.parseAsync();
