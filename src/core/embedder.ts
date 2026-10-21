import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Store } from "./store.js";

/**
 * Semantic search is opt-in: `lore embed` installs Transformers.js into AGENTLORE_HOME/runtime and
 * downloads a multilingual model once (the only network access agentlore makes, and only then).
 * Searches load the model from disk with remote access off.
 */
export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
const TRANSFORMERS = "@huggingface/transformers";
export const TRANSFORMERS_VERSION = "4.3.0";
/** Characters of a chunk embedded: the model reads 512 tokens at most anyway. */
const MAX_EMBED_CHARS = 2000;
/** Texts embedded per call and saved per transaction. */
export const EMBED_BATCH = 16;

export interface Embedder {
  model: string;
  /** Normalized vectors; e5 models are told whether a text is a query or a passage. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

interface Tensor {
  dims: number[];
  data: Float32Array;
}
type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<Tensor>;
interface Transformers {
  env: { cacheDir: string; allowRemoteModels: boolean };
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { dtype: string },
  ): Promise<Extractor>;
}

const runtimeDir = (home: string) => path.join(home, "runtime");

/** Whether `lore embed` installed the runtime. */
export function hasRuntime(home: string): boolean {
  return existsSync(path.join(runtimeDir(home), "node_modules", ...TRANSFORMERS.split("/")));
}

/** Install Transformers.js into AGENTLORE_HOME/runtime with npm (downloads it). */
export function installRuntime(home: string): void {
  const dir = runtimeDir(home);
  mkdirSync(dir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(
    npm,
    [
      "install",
      "--prefix",
      dir,
      "--no-audit",
      "--no-fund",
      `${TRANSFORMERS}@${TRANSFORMERS_VERSION}`,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
}

/**
 * The embedder, or undefined when the runtime is not installed. With `download`, a missing model
 * is downloaded; otherwise only a model already on disk is used.
 */
export async function loadEmbedder(
  home: string,
  { download = false }: { download?: boolean } = {},
): Promise<Embedder | undefined> {
  if (!hasRuntime(home)) return undefined;
  const require = createRequire(path.join(runtimeDir(home), "package.json"));
  const transformers = (await import(
    pathToFileURL(require.resolve(TRANSFORMERS)).href
  )) as Transformers;
  transformers.env.cacheDir = path.join(home, "models");
  transformers.env.allowRemoteModels = download;
  const extract = await transformers.pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: "q8",
  });
  return {
    model: EMBEDDING_MODEL,
    async embed(texts, kind) {
      const output = await extract(
        texts.map((t) => `${kind}: ${t.slice(0, MAX_EMBED_CHARS)}`),
        { pooling: "mean", normalize: true },
      );
      const dims = output.dims.at(-1) ?? 0;
      return texts.map((_, i) => output.data.slice(i * dims, (i + 1) * dims));
    },
  };
}

/**
 * Embed every chunk text without a vector, in batches; returns how many. Switching models drops
 * the vectors of the previous one.
 */
export async function embedMissing(
  store: Store,
  embedder: Embedder,
  onProgress?: (done: number) => void,
): Promise<number> {
  store.useEmbeddingModel(embedder.model);
  let done = 0;
  for (;;) {
    const batch = store.missingEmbeddings(EMBED_BATCH);
    if (!batch.length) return done;
    const vectors = await embedder.embed(
      batch.map((b) => b.text),
      "passage",
    );
    store.saveEmbeddings(
      batch.map((b, i) => ({ hash: b.hash, vector: vectors[i] as Float32Array })),
    );
    done += batch.length;
    onProgress?.(done);
  }
}
