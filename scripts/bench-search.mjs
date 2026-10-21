// Times `search` on an existing index, for the speed figures in the README. Build first
// (`pnpm build`), then: node scripts/bench-search.mjs "query one" "query two" …
// Uses $AGENTLORE_HOME/index.db (default ~/.agentlore), read-only. Prints percentiles only, never
// results, so the output is safe to paste.
import { homedir } from "node:os";
import path from "node:path";
import { search } from "../dist/core/search.js";
import { openStore } from "../dist/core/store.js";

const ROUNDS = 5;
const queries = process.argv.slice(2);
if (!queries.length) {
  console.error('usage: node scripts/bench-search.mjs "query" ["query" …]');
  process.exit(1);
}
const home = process.env.AGENTLORE_HOME ?? path.join(homedir(), ".agentlore");
const store = openStore(path.join(home, "index.db"), { readonly: true });
const times = [];
for (let round = 0; round < ROUNDS; round++) {
  for (const query of queries) {
    const started = performance.now();
    search(store, query, { limit: 5 });
    times.push(performance.now() - started);
  }
}
store.close();
times.sort((a, b) => a - b);
const at = (p) => times[Math.floor(p * (times.length - 1))].toFixed(1);
console.log(`${times.length} searches: p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`);
