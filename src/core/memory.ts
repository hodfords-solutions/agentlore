import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { errnoCode } from "./errors.js";
import { writePrivateFile } from "./files.js";
import { isWithin, normalizeProject } from "./project.js";
import { redact } from "./redact.js";

/**
 * Project memory (docs/adr/0004): what sessions learned about a project, consolidated into notes.
 * Each note is a Markdown file, `<memory>/<project slug>/<topic>.md`, with a small front matter.
 * Notes are user data, not cache: nothing here is rebuilt, and a replaced note is kept in
 * `.history/`.
 */

/** The topic of a project's overview, which sessions get at start. */
export const BRIEF_TOPIC = "brief";
export const MAX_BRIEF_CHARS = 2000;
export const MAX_NOTE_CHARS = 6000;
/** Topics per project: past this, notes should be merged rather than added. */
export const MAX_TOPICS = 20;
/** Replaced versions kept per topic. */
export const KEPT_VERSIONS = 10;
const MAX_TOPIC_CHARS = 40;
export const HISTORY_DIR = ".history";
const GROUPS_FILE = "groups.json";

export type NoteAuthor = "agent" | "consolidation" | "user";
const AUTHORS: readonly NoteAuthor[] = ["agent", "consolidation", "user"];

export interface Note {
  project: string;
  topic: string;
  /** ISO 8601. */
  updated: string;
  by: NoteAuthor;
  text: string;
}

/** A folder name for a project: its last folder, made safe, and a hash of its full path. */
export function projectSlug(project: string): string {
  const base = topicSlug(path.basename(project)) ?? "project";
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * A topic as a file name: lowercase ASCII words joined by "-", accents dropped ("Crème brûlée" →
 * "creme-brulee"); undefined when nothing is left.
 */
export function topicSlug(topic: string): string | undefined {
  const slug = topic
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    // U+0110 and U+0111 (d with stroke) have no decomposition.
    .replace(/[\u0110\u0111]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_TOPIC_CHARS)
    .replace(/^-+|-+$/g, "");
  return slug || undefined;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A file's front matter fields and the text after them; undefined without front matter. */
function frontMatter(content: string): { fields: Map<string, string>; text: string } | undefined {
  const match = FRONT_MATTER.exec(content);
  if (!match?.[1]) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { fields, text: content.slice(match[0].length).trim() };
}

const author = (value: string | undefined): NoteAuthor =>
  AUTHORS.includes(value as NoteAuthor) ? (value as NoteAuthor) : "user";

/** A note file's content, or undefined when it has no valid front matter. */
export function parseNote(content: string): Note | undefined {
  const parsed = frontMatter(content);
  if (!parsed) return undefined;
  const { fields } = parsed;
  const project = normalizeProject(fields.get("project"));
  const topic = topicSlug(fields.get("topic") ?? "");
  const updated = fields.get("updated") ?? "";
  if (!project || !path.isAbsolute(project) || !topic || Number.isNaN(Date.parse(updated))) {
    return undefined;
  }
  return { project, topic, updated, by: author(fields.get("by")), text: parsed.text };
}

export function formatNote(note: Note): string {
  return `---\nproject: ${note.project}\ntopic: ${note.topic}\nupdated: ${note.updated}\nby: ${note.by}\n---\n\n${note.text}\n`;
}

const projectDir = (root: string, project: string) => path.join(root, projectSlug(project));
const noteFile = (root: string, project: string, topic: string) =>
  path.join(projectDir(root, project), `${topic}.md`);

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return [];
    throw error;
  }
}

/** A project's notes, the brief first, then the most recently updated. */
export function readNotes(root: string, project: string): Note[] {
  const dir = projectDir(root, project);
  const notes = listDir(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => {
      const note = parseNote(readText(path.join(dir, name)) ?? "");
      // The folder is the project's: a note copied from elsewhere is not its own.
      return note && note.project === project ? [note] : [];
    });
  return notes.sort(
    (a, b) =>
      Number(b.topic === BRIEF_TOPIC) - Number(a.topic === BRIEF_TOPIC) ||
      b.updated.localeCompare(a.updated),
  );
}

export function readNote(root: string, project: string, topic: string): Note | undefined {
  const slug = topicSlug(topic);
  if (!slug) return undefined;
  const note = parseNote(readText(noteFile(root, project, slug)) ?? "");
  return note?.project === project ? note : undefined;
}

/** Projects with notes, from their briefs or any note. */
export function notedProjects(root: string): string[] {
  const projects = new Set<string>();
  for (const slug of listDir(root)) {
    const dir = path.join(root, slug);
    for (const name of listDir(dir)) {
      if (!name.endsWith(".md")) continue;
      const note = parseNote(readText(path.join(dir, name)) ?? "");
      if (note && projectSlug(note.project) === slug) {
        projects.add(note.project);
        break;
      }
    }
  }
  return [...projects].sort();
}

const timestamp = (iso: string) => iso.replace(/[:.]/g, "-");

/**
 * Copy a topic's file to `.history/`, keeping the last KEPT_VERSIONS of the topic; false when
 * there is no file. A file the user broke (no valid front matter) is kept too, by its mtime.
 */
function keepVersion(dir: string, topic: string): boolean {
  const file = path.join(dir, `${topic}.md`);
  let modified: Date;
  try {
    modified = statSync(file).mtime;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  const updated =
    frontMatter(readText(file) ?? "")?.fields.get("updated") ?? modified.toISOString();
  const history = path.join(dir, HISTORY_DIR);
  mkdirSync(history, { recursive: true, mode: 0o700 });
  copyFileSync(file, path.join(history, `${topic}.${timestamp(updated)}.md`));
  const versions = listDir(history)
    .filter((name) => name.startsWith(`${topic}.`) && name.endsWith(".md"))
    .sort();
  for (const old of versions.slice(0, -KEPT_VERSIONS)) {
    rmSync(path.join(history, old), { force: true });
  }
  return true;
}

export interface WriteNoteInput {
  project: string;
  topic: string;
  text: string;
  by: NoteAuthor;
  now?: Date;
}

/** Thrown for a note that cannot be saved; the message says why, for the agent or user. */
export class NoteError extends Error {
  readonly code = "NOTE_INVALID";
}

/**
 * Save a note, replacing the topic's previous one (kept in `.history/`). The text is redacted.
 * Throws NoteError for an invalid project, topic or size.
 */
export function writeNote(root: string, input: WriteNoteInput): { note: Note; replaced: boolean } {
  const project = normalizeProject(input.project);
  if (!project || !path.isAbsolute(project)) {
    throw new NoteError(`project must be an absolute path, got "${input.project}".`);
  }
  const topic = topicSlug(input.topic);
  if (!topic) throw new NoteError("topic must contain letters or digits.");
  const text = redact(input.text.trim());
  if (!text) throw new NoteError("text is empty.");
  const max = topic === BRIEF_TOPIC ? MAX_BRIEF_CHARS : MAX_NOTE_CHARS;
  if (text.length > max) {
    throw new NoteError(
      `the ${topic} note is ${text.length} characters; keep it under ${max} (summarize, or split it into topics).`,
    );
  }
  const previous = readNote(root, project, topic);
  if (!previous && readNotes(root, project).length >= MAX_TOPICS) {
    throw new NoteError(
      `this project already has ${MAX_TOPICS} topics; add to an existing topic instead.`,
    );
  }
  const note: Note = {
    project,
    topic,
    updated: (input.now ?? new Date()).toISOString(),
    by: input.by,
    text,
  };
  const replaced = keepVersion(projectDir(root, project), topic);
  writePrivateFile(noteFile(root, project, topic), formatNote(note));
  return { note, replaced };
}

/** Remove a note, keeping it in `.history/`; false when there is none. */
export function forgetNote(root: string, project: string, topic: string): boolean {
  const slug = topicSlug(topic);
  if (!slug || !keepVersion(projectDir(root, project), slug)) return false;
  rmSync(noteFile(root, project, slug), { force: true });
  return true;
}

/**
 * The user profile: how the user works and talks, shared by every project, in
 * `<memory>/_user/profile.md`. It helps agents understand the user, so it holds preferences and
 * habits, not project facts.
 */
export const USER_TOPIC = "user";
export const USER_DIR = "_user";
const PROFILE_TOPIC = "profile";
export const MAX_PROFILE_CHARS = 1500;

export interface UserProfile {
  updated: string;
  by: NoteAuthor;
  text: string;
}

const profileDir = (root: string) => path.join(root, USER_DIR);

export function readUserProfile(root: string): UserProfile | undefined {
  const parsed = frontMatter(readText(path.join(profileDir(root), `${PROFILE_TOPIC}.md`)) ?? "");
  const updated = parsed?.fields.get("updated") ?? "";
  if (!parsed?.text || Number.isNaN(Date.parse(updated))) return undefined;
  return { updated, by: author(parsed.fields.get("by")), text: parsed.text };
}

/** Save the user profile, replacing the previous one (kept in `.history/`). The text is redacted. */
export function writeUserProfile(
  root: string,
  input: { text: string; by: NoteAuthor; now?: Date },
): { profile: UserProfile; replaced: boolean } {
  const text = redact(input.text.trim());
  if (!text) throw new NoteError("text is empty.");
  if (text.length > MAX_PROFILE_CHARS) {
    throw new NoteError(
      `the user profile is ${text.length} characters; keep it under ${MAX_PROFILE_CHARS} (keep what helps most).`,
    );
  }
  const profile = { updated: (input.now ?? new Date()).toISOString(), by: input.by, text };
  const replaced = keepVersion(profileDir(root), PROFILE_TOPIC);
  writePrivateFile(
    path.join(profileDir(root), `${PROFILE_TOPIC}.md`),
    `---\ntopic: ${PROFILE_TOPIC}\nupdated: ${profile.updated}\nby: ${profile.by}\n---\n\n${text}\n`,
  );
  return { profile, replaced };
}

/** Named sets of projects that belong together (one customer, one product). */
export type Groups = Record<string, string[]>;

/** The groups file; a missing or invalid file reads as no groups. */
export function readGroups(root: string): Groups {
  let raw: unknown;
  try {
    raw = JSON.parse(readText(path.join(root, GROUPS_FILE)) ?? "{}");
  } catch {
    return {};
  }
  const groups: Groups = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return groups;
  for (const [name, projects] of Object.entries(raw)) {
    if (!Array.isArray(projects)) continue;
    const valid = projects.filter((p): p is string => typeof p === "string" && path.isAbsolute(p));
    if (valid.length) groups[name] = valid;
  }
  return groups;
}

export function writeGroups(root: string, groups: Groups): void {
  writePrivateFile(path.join(root, GROUPS_FILE), `${JSON.stringify(groups, null, 2)}\n`);
}

/**
 * The groups holding `project` (or a folder containing it) and their other projects. The member
 * that is the project is the deepest one containing it; parent folders in the group are related.
 */
export function relatedProjects(
  groups: Groups,
  project: string,
): { group: string; projects: string[] }[] {
  return Object.entries(groups).flatMap(([group, members]) => {
    const own = members.filter((m) => isWithin(m, project)).sort((a, b) => b.length - a.length)[0];
    if (!own) return [];
    return [{ group, projects: members.filter((m) => m !== own) }];
  });
}
