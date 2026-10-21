import path from "node:path";
import { type Command, InvalidArgumentError } from "commander";
import { createMemoryAdapter } from "../adapters/memory.js";
import { loreHome, memoryPath, openExisting } from "../app.js";
import {
  consolidateProfile,
  consolidateProject,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_PROJECTS,
  DEFAULT_MODEL,
  planConsolidation,
} from "../core/consolidate.js";
import { errorMessage } from "../core/errors.js";
import { tildeHome as tilde } from "../core/format.js";
import { indexAll } from "../core/indexer.js";
import { withLock } from "../core/lock.js";
import {
  BRIEF_TOPIC,
  forgetNote,
  type NoteAuthor,
  notedProjects,
  projectSlug,
  readGroups,
  readNote,
  readNotes,
  readUserProfile,
  relatedProjects,
  topicSlug,
  USER_TOPIC,
  writeGroups,
  writeNote,
  writeUserProfile,
} from "../core/memory.js";
import { normalizeProject } from "../core/project.js";
import type { Runtime } from "../core/runtime.js";
import { claudeRunner } from "../integrations/claude-cli.js";
import { sessionProject } from "../integrations/claude-code.js";
import { noun } from "./format.js";
import { readStdin } from "./stdin.js";

/** `lore memory`, `lore group` and `lore consolidate`: project memory (docs/adr/0004). */

type Action = <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => Promise<void>;

/** A project from `--project`, else the current folder's (its repository's root). */
function projectOption(project: string | undefined): string {
  const resolved = project
    ? normalizeProject(path.resolve(project))
    : sessionProject(process.cwd());
  if (!resolved) throw new Error("not in a project folder: pass --project <path>.");
  return resolved;
}

/** Index the notes only, so a search finds them at once. */
export async function indexNotes(runtime: Runtime): Promise<void> {
  await withLock(runtime.lockPath, () =>
    indexAll(runtime.store, [createMemoryAdapter(memoryPath())], { record: false }),
  );
}

/** Index the notes in the existing index, if there is one (it is opened and closed here). */
export async function reindexNotes(): Promise<void> {
  const runtime = openExisting();
  if (!runtime) return;
  try {
    await indexNotes(runtime);
  } finally {
    runtime.store.close();
  }
}

/** A session folder's project (see `sessionProject`), or the folder itself. */
const rootOf = (project: string) => sessionProject(project) ?? project;

export interface ConsolidateOptions {
  project?: string;
  maxProjects: number;
  maxChars: number;
  model?: string;
  dryRun?: boolean;
}

/** Consolidate the projects with new sessions; prints one line per project. */
export async function runConsolidation(
  runtime: Runtime,
  options: ConsolidateOptions,
): Promise<void> {
  const root = memoryPath();
  const plans = planConsolidation(
    runtime.store,
    root,
    rootOf,
    options.project && projectOption(options.project),
  );
  if (options.dryRun) {
    if (!plans.length) console.log("No project has new sessions since its last pass.");
    for (const plan of plans.slice(0, options.maxProjects)) {
      const chars = runtime.store
        .projectExcerpts(plan.folders, plan.since, options.maxChars)
        .reduce((n, c) => n + c.text.length, 0);
      console.log(
        `${tilde(plan.project)}: ${chars} characters of new excerpts since ${plan.since?.slice(0, 10) ?? "the start"}`,
      );
    }
    if (plans.length > options.maxProjects) {
      console.log(`… and ${plans.length - options.maxProjects} more projects in later passes.`);
    }
    if (!options.project)
      console.log("user profile: updated from your own messages in all projects");
    return;
  }
  const run = claudeRunner({ model: options.model ?? DEFAULT_MODEL, cwd: loreHome() });
  let passes = 0;
  let written = 0;
  for (const plan of plans) {
    if (passes >= options.maxProjects) break;
    try {
      const result = await consolidateProject(runtime.store, root, plan, run, {
        maxChars: options.maxChars,
      });
      if (result.skipped) continue;
      passes++;
      written += result.written.length;
      console.log(
        `${tilde(plan.project)}: ${result.written.length ? `updated ${result.written.join(", ")}` : "nothing durable"} (${result.chars} characters read)`,
      );
      for (const problem of result.problems) console.error(`  not saved: ${problem}`);
    } catch (error) {
      passes++;
      console.error(`${tilde(plan.project)}: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
  if (!plans.length) {
    console.log("Nothing to consolidate: no project has new sessions since its last pass.");
  } else if (!passes) {
    console.log("No project has enough new text to consolidate yet.");
  }
  if (written) await indexNotes(runtime);
  // The user profile is about the user, not a project: only a run over all projects updates it.
  if (options.project) return;
  try {
    const profile = await consolidateProfile(runtime.store, root, run);
    if (!profile.skipped) {
      console.log(
        `user profile: ${profile.updated ? "updated" : "unchanged"} (${profile.chars} characters of your messages read)`,
      );
    }
  } catch (error) {
    console.error(`user profile: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

function positiveInt(max: number) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      throw new InvalidArgumentError(`must be an integer from 1 to ${max}.`);
    }
    return n;
  };
}

export const maxProjectsOption = [
  "--max-projects <n>",
  `projects consolidated per run (default ${DEFAULT_MAX_PROJECTS})`,
  positiveInt(1000),
  DEFAULT_MAX_PROJECTS,
] as const;

function authorOption(value: string): NoteAuthor {
  if (value !== "user" && value !== "agent") {
    throw new InvalidArgumentError('must be "user" or "agent".');
  }
  return value;
}

export function registerMemoryCommands(program: Command, action: Action): void {
  const memory = program
    .command("memory")
    .description(
      "Project memory: notes sessions saved about each project (see `lore consolidate`)",
    );

  memory
    .command("show")
    .description(
      'Show a project\'s brief and topics, or one topic in full ("user": your user profile)',
    )
    .argument("[topic]", "a topic; omit for the overview")
    .option("-p, --project <path>", "the project (default: the current folder's)")
    .action(
      action((topic: string | undefined, options: { project?: string }) => {
        const root = memoryPath();
        if (topic && topicSlug(topic) === USER_TOPIC) {
          const profile = readUserProfile(root);
          if (!profile) throw new Error("no user profile yet.");
          console.log(
            `# user profile (by ${profile.by}, ${profile.updated.slice(0, 10)})\n\n${profile.text}`,
          );
          return;
        }
        const project = projectOption(options.project);
        if (topic) {
          const note = readNote(root, project, topic);
          if (!note) throw new Error(`no ${topic} note for ${tilde(project)}.`);
          console.log(
            `# ${note.topic} (by ${note.by}, ${note.updated.slice(0, 10)})\n\n${note.text}`,
          );
          return;
        }
        const notes = readNotes(root, project);
        if (!notes.length) {
          console.log(`No notes for ${tilde(project)} yet.`);
        } else {
          const brief = notes.find((n) => n.topic === BRIEF_TOPIC);
          if (brief)
            console.log(
              `# brief (by ${brief.by}, ${brief.updated.slice(0, 10)})\n\n${brief.text}\n`,
            );
          for (const note of notes.filter((n) => n.topic !== BRIEF_TOPIC)) {
            console.log(`- ${note.topic} (by ${note.by}, ${note.updated.slice(0, 10)})`);
          }
        }
        for (const { group, projects } of relatedProjects(readGroups(root), project)) {
          console.log(`group ${group}: ${projects.map((p) => tilde(p)).join(", ")}`);
        }
      }),
    );

  memory
    .command("list")
    .description("List the projects that have notes")
    .action(
      action(() => {
        const root = memoryPath();
        const projects = notedProjects(root);
        if (!projects.length) {
          console.log("No project notes yet.");
          return;
        }
        for (const project of projects) {
          const notes = readNotes(root, project);
          const last = notes
            .map((n) => n.updated)
            .sort()
            .at(-1)
            ?.slice(0, 10);
          console.log(
            `${tilde(project)}  ${notes.length} ${noun(notes.length, "note")}, updated ${last}`,
          );
        }
      }),
    );

  memory
    .command("save")
    .description(
      "Save a note (replacing the topic's; the old one is kept): text from --text or stdin",
    )
    .argument("<topic>", 'the topic, e.g. "brief", "db", "billing-rules"')
    .option("-p, --project <path>", "the project (default: the current folder's)")
    .option("--text <text>", "the whole note (default: read from stdin)")
    .option("--by <author>", "who wrote it: user or agent", authorOption, "user")
    .action(
      action(
        async (topic: string, options: { project?: string; text?: string; by: NoteAuthor }) => {
          const text = options.text ?? (await readStdin());
          if (topicSlug(topic) === USER_TOPIC) {
            const { replaced } = writeUserProfile(memoryPath(), { text, by: options.by });
            console.log(
              `Saved your user profile${replaced ? " (the previous version is kept in its history)" : ""}.`,
            );
            return;
          }
          const project = projectOption(options.project);
          const { note, replaced } = writeNote(memoryPath(), {
            project,
            topic,
            text,
            by: options.by,
          });
          await reindexNotes();
          console.log(
            `Saved the ${note.topic} note of ${tilde(project)}${replaced ? " (the previous version is kept in its history)" : ""}.`,
          );
        },
      ),
    );

  memory
    .command("path")
    .description("Print the folder holding a project's notes (Markdown files you can edit)")
    .option("-p, --project <path>", "the project (default: the current folder's)")
    .action(
      action((options: { project?: string }) => {
        console.log(path.join(memoryPath(), projectSlug(projectOption(options.project))));
      }),
    );

  memory
    .command("forget")
    .description("Delete a note (a copy stays in the project's .history folder)")
    .argument("<topic>", "the topic")
    .option("-p, --project <path>", "the project (default: the current folder's)")
    .action(
      action(async (topic: string, options: { project?: string }) => {
        const project = projectOption(options.project);
        if (!forgetNote(memoryPath(), project, topic)) {
          throw new Error(`no ${topic} note for ${tilde(project)}.`);
        }
        await reindexNotes();
        console.log(`Deleted the ${topic} note of ${tilde(project)}.`);
      }),
    );

  const group = program
    .command("group")
    .description("Link projects that belong together (one customer, one product)");

  group
    .command("add")
    .description("Add projects to a group (created if new)")
    .argument("<name>", "the group, e.g. a customer")
    .argument("<paths...>", "project folders")
    .action(
      action((name: string, paths: string[]) => {
        const root = memoryPath();
        const groups = readGroups(root);
        const members = new Set(groups[name] ?? []);
        for (const p of paths) members.add(projectOption(p));
        groups[name] = [...members];
        writeGroups(root, groups);
        console.log(`group ${name}: ${groups[name].map((p) => tilde(p)).join(", ")}`);
      }),
    );

  group
    .command("remove")
    .description("Remove projects from a group, or the whole group")
    .argument("<name>", "the group")
    .argument("[paths...]", "project folders; omit to remove the group")
    .action(
      action((name: string, paths: string[]) => {
        const root = memoryPath();
        const groups = readGroups(root);
        if (!groups[name]) throw new Error(`no group ${name}.`);
        if (paths.length) {
          const removed = new Set(paths.map((p) => projectOption(p)));
          groups[name] = groups[name].filter((p) => !removed.has(p));
        }
        if (!paths.length || !groups[name].length) delete groups[name];
        writeGroups(root, groups);
        console.log(
          groups[name]
            ? `group ${name}: ${groups[name].map((p) => tilde(p)).join(", ")}`
            : `Removed group ${name}.`,
        );
      }),
    );

  group
    .command("list")
    .description("List groups and their projects")
    .action(
      action(() => {
        const groups = Object.entries(readGroups(memoryPath()));
        if (!groups.length) console.log("No groups. `lore group add <name> <paths...>` makes one.");
        for (const [name, projects] of groups) {
          console.log(`${name}: ${projects.map((p) => tilde(p)).join(", ")}`);
        }
      }),
    );

  program
    .command("consolidate")
    .description(
      "Update project notes from new sessions with Claude Code (`claude -p`; uses your quota)",
    )
    .option("-p, --project <path>", "only this project")
    .option(...maxProjectsOption)
    .option(
      "--max-chars <n>",
      `characters of excerpts read per project (default ${DEFAULT_MAX_CHARS})`,
      positiveInt(500_000),
      DEFAULT_MAX_CHARS,
    )
    .option("--model <model>", `Claude model (default ${DEFAULT_MODEL})`, DEFAULT_MODEL)
    .option("--dry-run", "list the projects and how much would be read, without asking a model")
    .action(
      action(async (options: ConsolidateOptions) => {
        const runtime = openExisting();
        if (!runtime) throw new Error("the index is empty: run `lore index` first.");
        try {
          await runConsolidation(runtime, options);
        } finally {
          runtime.store.close();
        }
      }),
    );
}
