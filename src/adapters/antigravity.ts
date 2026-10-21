import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { errnoCode } from "../core/errors.js";
import type { Adapter, Discovery, ReadBatch, SourceRef } from "../core/types.js";
import { parseJson } from "./fs.js";

const TOOL = "antigravity";
const PREFIX = `${TOOL}:`;

/** The indexer cuts records at 1 MB of text anyway. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** `<artifact>.md.metadata.json` stores no title or workspace. */
const Metadata = z.object({ updatedAt: z.string().optional() });

/** One path segment, never "." or "..". */
const SEGMENT = /^(?!\.\.?$)[^/\\]+$/;

/**
 * Antigravity "brain" markdown artifacts, each a `note` source read whole. Conversations
 * (`conversations/*.pb`) are encrypted; `*.resolved*` files are older copies of the artifacts.
 */
export function createAntigravityAdapter(
  root = join(homedir(), ".gemini", "antigravity", "brain"),
): Adapter {
  return {
    tool: TOOL,
    discover: () => discover(root),
    read: (source) => readArtifact(root, source),
  };
}

async function discover(root: string): Promise<Discovery> {
  const discovery: Discovery = { sources: [], complete: true };
  let conversations: string[];
  try {
    conversations = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { ...discovery, missingRoot: root };
    throw error;
  }
  for (const conversation of conversations) {
    let files: string[];
    try {
      files = (await readdir(join(root, conversation), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      // ENOENT: deleted since the listing; any other failure may hide files.
      if (errnoCode(error) !== "ENOENT") discovery.complete = false;
      continue;
    }
    for (const file of files) {
      try {
        const info = await stat(join(root, conversation, file));
        discovery.sources.push({
          id: `${PREFIX}${conversation}/${file}`,
          version: `${info.size}:${Math.trunc(info.mtimeMs)}`,
        });
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") discovery.complete = false;
      }
    }
  }
  return discovery;
}

/** Refuses ids that would resolve outside `root`. */
function parseId(id: string): { conversation: string; file: string } {
  const [conversation = "", file = "", ...rest] = id.slice(PREFIX.length).split("/");
  if (!id.startsWith(PREFIX) || rest.length || !SEGMENT.test(conversation) || !SEGMENT.test(file)) {
    throw new Error(`invalid antigravity source id: ${id}`);
  }
  return { conversation, file };
}

/** Artifacts are rewritten in place, so every read replaces the indexed one (`reset`). */
async function* readArtifact(root: string, source: SourceRef): AsyncGenerator<ReadBatch> {
  const { conversation, file } = parseId(source.id);
  const path = join(root, conversation, file);
  const info = await stat(path);
  const head = await readHead(path, Math.min(info.size, MAX_FILE_BYTES));
  const text = (info.size > MAX_FILE_BYTES ? utf8Prefix(head) : head).toString("utf8").trim();
  const batch: ReadBatch = { records: [], checkpoint: null, reset: true, skipped: 0 };
  if (text) {
    batch.records.push({
      kind: "note",
      tool: TOOL,
      title: `${conversation} — ${basename(file, ".md")}`,
      project: "",
      timestamp: (await updatedAt(path)) ?? info.mtime.toISOString(),
      text,
    });
  }
  yield batch;
}

/** Drops a UTF-8 character cut off at the end, so a cut file never ends in U+FFFD. */
export function utf8Prefix(bytes: Buffer): Buffer {
  let start = bytes.length - 1;
  while (start > 0 && start > bytes.length - 4 && ((bytes[start] as number) & 0xc0) === 0x80)
    start--;
  if (start < 0) return bytes;
  const lead = bytes[start] as number;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start + length > bytes.length ? bytes.subarray(0, start) : bytes;
}

async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function updatedAt(path: string): Promise<string | undefined> {
  try {
    const value = Metadata.safeParse(parseJson(await readFile(`${path}.metadata.json`, "utf8")))
      .data?.updatedAt;
    return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
  } catch {
    return undefined;
  }
}
