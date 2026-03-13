# Codebase Memory System — Design Notes

## Goal

Build a self-hosted, connector-extensible memory layer for AI agents, starting with codebase intelligence first:

1. **Phase 1 (now):** Walk a codebase, language-aware chunk via Tree-sitter, embed with LangChain.js, and store as a vector + graph database. Build memories, links, and typed relationships automatically along the way.
2. **Phase 2 (later):** Extend connectors to link code to external entities — GitLab issues, MRs, wikis, Slack threads, etc.

---

## Architecture

Three layers, designed so Phase 2 is additive (new connectors, same engine):

```
┌──────────────────────────────────────────┐
│  CONNECTORS (ingest layer)               │
│  Phase 1: filesystem walker + Tree-sitter│
│  Phase 2: GitLab, Slack, Notion, ...     │
├──────────────────────────────────────────┤
│  MEMORY ENGINE                           │
│  vector store + graph DB + decay         │
├──────────────────────────────────────────┤
│  AGENT INTERFACE                         │
│  MCP tools / REST API                    │
└──────────────────────────────────────────┘
```

---

## Phase 1: Codebase Ingestion

### Step 1 — Walk the filesystem

Recursively walk the repo, filtering by language extension. Skip `node_modules`, `build`, `.git`, etc.

For each file, record:
- relative path
- detected language (from extension)
- last modified time (for incremental re-indexing)

### Step 2 — Parse AST with web-tree-sitter + tree-sitter-wasms

Use **`web-tree-sitter`** (the WASM build of Tree-sitter) with **`tree-sitter-wasms`** as the grammar package. This covers 36+ languages from a single npm dependency — no native bindings, no per-language installs, works in any Node.js environment.

```ts
import Parser from "web-tree-sitter";

await Parser.init();
const lang = await Parser.Language.load(
  `node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm`
);
const parser = new Parser();
parser.setLanguage(lang);
const tree = parser.parse(fileContent);
// tree.rootNode → walk AST nodes
```

**Language detection** is a simple extension → grammar name map:

| Extension(s) | Grammar |
|---|---|
| `.ts`, `.tsx` | `typescript` / `tsx` |
| `.js`, `.mjs`, `.cjs`, `.jsx` | `javascript` |
| `.py` | `python` |
| `.go` | `go` |
| `.rs` | `rust` |
| `.java` | `java` |
| `.c`, `.h` | `c` |
| `.cpp`, `.cc`, `.hpp` | `cpp` |
| `.cs` | `c_sharp` |
| `.rb` | `ruby` |
| `.php` | `php` |
| `.swift` | `swift` |
| `.kt`, `.kts` | `kotlin` |
| `.scala` | `scala` |
| `.sol` | `solidity` |
| `.zig` | `zig` |
| `.sh`, `.bash`, `.zsh` | `bash` |
| `.vue` | `vue` |
| `.dart` | `dart` |
| `.ex`, `.exs` | `elixir` |
| `.ml` | `ocaml` |
| `.lua` | `lua` |
| `.toml`, `.yaml`, `.json`, `.html`, `.css` | structured grammars |

Grammars are lazy-loaded and cached per language — load once, reuse across all files.

### Step 2b — Chunk at symbol boundaries

Do **not** chunk by token count. Walk the AST and emit one chunk per meaningful declaration node:

| Language | Declaration node types |
|---|---|
| TypeScript / JS / TSX | `function_declaration`, `method_definition`, `class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration` |
| Python | `function_definition`, `class_definition` |
| Go | `function_declaration`, `method_declaration`, `type_spec` |
| Rust | `function_item`, `struct_item`, `enum_item`, `trait_item`, `impl_item` |
| Java / C# | `method_declaration`, `class_declaration`, `interface_declaration`, `enum_declaration` |
| C / C++ | `function_definition`, `class_specifier`, `struct_specifier` |

For each matched node, extract:
- symbol name (via `node.childForFieldName("name")`)
- symbol type (`function`, `class`, `method`, `interface`, `enum`, `type`, `struct`)
- start/end line numbers (`node.startPosition.row`, `node.endPosition.row`)
- parent context (class name if the node is nested inside a class body)
- full text (`node.text`)

Then wrap as a LangChain `Document`:
```ts
import { Document } from "@langchain/core/documents";

new Document({
  pageContent: `${filePath} ${symbolName} ${symbolType}\n${node.text}`,
  metadata: { filePath, language, symbolName, symbolType, startLine, endLine, source: "codebase" },
});
```

**File-level chunk:** also create one `Document` per file using the file header (first 30 lines: imports + top-level comments + exported names). Used for file-level similarity and `contains`/`imports` edges.

### Step 3 — Embed and store with LangChain.js

Pass the `Document[]` from Step 2b directly into `PGVectorStore` — it handles embedding, upsert, and similarity search:

```ts
import { OllamaEmbeddings } from "@langchain/ollama";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";

const embeddings = new OllamaEmbeddings({ model: "nomic-embed-text" });
// or: new OpenAIEmbeddings(), new CohereEmbeddings(), etc.

const vectorStore = await PGVectorStore.initialize(embeddings, {
  postgresConnectionOptions: { connectionString: process.env.DATABASE_URL },
  tableName: "chunks",
  columns: {
    idColumnName: "id",
    vectorColumnName: "embedding",
    contentColumnName: "content",
    metadataColumnName: "metadata",
  },
});

// initialize() only creates the table — HNSW index must be created explicitly.
// Safe to call on every startup (IF NOT EXISTS).
await vectorStore.createHnswIndex({ dimensions: 768 }); // match your embedding model's output size

await vectorStore.addDocuments(docs); // docs from Step 2
```

`PGVectorStore.initialize()` creates the table; the HNSW index requires an explicit `createHnswIndex()` call. Without it, pgvector falls back to a sequential scan (correct results, but slow at scale). Swap the `embeddings` instance to change models with no other changes.

Embed chunks as: `"[filePath] [symbolName] [symbolType]\n[body]"` — prepending metadata into the text improves retrieval quality significantly.

### Step 4 — Schema extensions for the graph

`PGVectorStore` manages the `chunks` table and its HNSW index. Add the graph edges table alongside it:

```sql
-- chunks table + HNSW index: managed by PGVectorStore.initialize()
-- extra columns stored in the metadata JSONB:
--   file_path, language, symbol_name, symbol_type, start_line, end_line,
--   source ('codebase' | 'gitlab' | ...), source_id, indexed_at, content_hash

-- BM25 index (requires pg_bm25 / ParadeDB)
CREATE INDEX chunks_bm25 ON chunks USING bm25(id, content) WITH (key_field = 'id');
-- Fallback if pg_bm25 unavailable: tsvector GIN index
-- ALTER TABLE chunks ADD COLUMN fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
-- CREATE INDEX ON chunks USING gin(fts);

-- Graph edges (manual)
CREATE TABLE edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  relation    TEXT NOT NULL,  -- see relation types below
  weight      FLOAT DEFAULT 1.0,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON edges (source_id);
CREATE INDEX ON edges (target_id);
```

### Step 5 — Build the graph automatically

After embedding, create edges without any LLM involvement:

**Structural edges — all languages: Tree-sitter AST**

Use Tree-sitter uniformly across all languages. For each file, extract import/use nodes from the AST to get the raw module specifier string, then resolve it to an actual file path:

- **Relative imports** (`"../auth/login"`) → `path.resolve(currentFileDir, specifier)` + try `.ts`, `.js`, `/index.ts` extensions
- **Path aliases** (`"@/utils"`) → read `tsconfig.json`'s `compilerOptions.paths` once at startup and apply the mapping before resolving
- **Third-party packages** (no leading `.` or `/`) → skip for graph purposes (external, not in the repo)

| Language | AST node types for imports |
|---|---|
| TypeScript / JS | `import_declaration`, `call_expression` (for `require()`) |
| Python | `import_statement`, `import_from_statement` |
| Go | `import_declaration` |
| Rust | `use_declaration`, `extern_crate` |

From the AST, create:
- `file → imports → file` for every resolved in-repo import
- `file → contains → function/class` from top-level declaration nodes
- `class → contains → method` from class body nodes

**Semantic edges** (from embeddings, all languages):
- Run approximate nearest neighbor over all chunk embeddings via pgvector HNSW
- Create `similar_to` edges for pairs with cosine ≥ 0.72
- Limit to top-5 neighbors per chunk to avoid edge explosion

**Reference edges** (from text parsing):
- Scan function bodies for identifiers matching known symbol names → `references` edges

### Relation Types

`contains` | `imports` | `similar_to` | `references` | `depends_on` | `implements`

Phase 2 will add: `relates_to` (code ↔ issue), `resolves` (MR ↔ issue), `mentions` (comment ↔ symbol)

---

## Memory Engine

### Node model

Every chunk is a node. Nodes track usage for decay:

```ts
interface Node {
  id: string;
  type: "file" | "function" | "class" | "method"; // Phase 2: "issue" | "concept" | "note"
  label: string;        // symbol name or file path
  content: string;      // chunk text used for embedding
  embedding: number[];
  accessCount: number;
  lastAccessed: Date;
  source: string;       // "codebase" | "gitlab" | "notion" | ...
  metadata: Record<string, string>;
}
```

### Retrieval — hybrid BM25 + vector + graph

Search is three-pass, combined with Reciprocal Rank Fusion (RRF):

1. **Keyword pass (BM25):** exact and near-exact term matching — good for symbol names, error messages, identifiers
2. **Vector pass:** semantic cosine similarity — good for concept-level queries
3. **Graph pass:** BFS from top hits, walking edges up to depth 2, collecting neighbors

**Why RRF:** instead of tuning weights between BM25 and vector scores (which are on different scales), RRF combines ranked lists by position:
$$\text{RRF}(d) = \sum_{i} \frac{1}{k + \text{rank}_i(d)}$$
where $k = 60$ (standard constant). Each pass contributes a ranked list; RRF merges them stably without score normalization.

**BM25 with `pg_bm25` (ParadeDB):**

```sql
-- Install once (requires ParadeDB-patched Postgres or pg_bm25 extension)
CREATE INDEX chunks_bm25 ON chunks
  USING bm25(id, content) WITH (key_field = 'id');

-- Keyword search
SELECT id, paradedb.score(id) AS bm25_score
FROM chunks
WHERE content @@@ $query
ORDER BY bm25_score DESC
LIMIT 20;
```

If `pg_bm25` is unavailable (managed Postgres, RDS, etc.), fall back to Postgres native `tsvector` + `ts_rank` — not true BM25 but available everywhere:

```sql
ALTER TABLE chunks ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX ON chunks USING gin(fts);
```

**Graph pass (BFS via recursive CTE):**

```sql
WITH RECURSIVE traversal AS (
  SELECT id, 0 AS depth FROM chunks WHERE id = ANY($directHitIds)
  UNION ALL
  SELECT e.target_id, t.depth + 1
  FROM edges e
  JOIN traversal t ON e.source_id = t.id
  WHERE t.depth < 2
)
SELECT DISTINCT c.* FROM chunks c JOIN traversal t ON c.id = t.id;
```

**Final scoring:** apply decay to graph neighbors: $\text{score} = \text{RRF\_rank} \times (w \cdot e^{-\lambda t})$

### Decay

Edge weights decay as $w \cdot e^{-\lambda t}$ ($\lambda = 0.05$/day). A nightly cron prunes edges below threshold (0.15) and orphan nodes with `accessCount ≤ 1` not accessed in 7+ days.

### Query performance

All three passes run inside Postgres — no round-trips to external services at query time:

| Pass | Mechanism | Expected latency |
|---|---|---|
| BM25 | `pg_bm25` index scan | ~1–5ms |
| Vector | pgvector HNSW ANN | ~1–10ms (100K vectors) |
| Graph BFS | Recursive CTE, depth ≤ 2 | ~5–20ms |
| **Total** | Sequential, single DB connection | **~10–35ms** for typical repos |

HNSW is approximate (trades tiny recall loss for speed). At 1M+ chunks you can tune `hnsw.ef_search` upward for better recall at the cost of a few extra ms. For codebases up to ~500K chunks the defaults are fine.

The only slow path is **initial embedding generation** — that's a one-time offline cost, not a query concern.

---

## Incremental Updates

### What triggers an update

Two modes:

- **Startup sync** — on server start, walk the repo and for each file:
  1. Call `fs.stat(filePath).mtimeMs` — if unchanged vs stored value, skip entirely (no file read)
  2. If `mtimeMs` changed, read the file and compute `sha256(content)` — if hash matches stored hash, skip (mtime changed but content didn't, e.g. git checkout, `touch`, copy)
  3. Only re-index if hash differs
- **Filesystem watcher** — use `fs.watch` (or `chokidar`) to watch the repo root during runtime. On change event, apply the same mtime + hash check before queuing. Debounce (e.g. 1.5s) and process in batches to avoid thrashing during large saves or git checkouts.

Store both `indexed_at` (timestamp) and `content_hash` (sha256 hex) in chunk metadata. `mtime` is a cheap pre-filter; hash is the authoritative change signal.

```ts
import { createHash } from "crypto";

const { mtimeMs } = await fs.stat(filePath);
if (mtimeMs <= storedMtime) continue; // fast path — no read needed

const content = await fs.readFile(filePath, "utf-8");
const hash = createHash("sha256").update(content).digest("hex");
if (hash === storedHash) continue; // content unchanged despite mtime change

// content truly changed — re-index
```

### What a file update actually touches

When file `src/auth/login.ts` changes, it's not just re-embedding — three things are stale:

**1. Chunks (vector store)**
- Delete all existing chunks where `metadata->>'file_path' = 'src/auth/login.ts'`
- Re-parse AST → emit new `Document[]`
- `PGVectorStore.addDocuments(newDocs)` — re-embeds and inserts with fresh `indexed_at`

**2. Structural edges**
- Delete all edges where `source_id` is any chunk from that file (removes old `imports`, `contains` edges)
- Delete all `imports` edges from *other* files pointing *to* any chunk of this file (they may now be broken if exports changed)
- Rebuild `imports` + `contains` edges from the new AST

**3. Semantic edges**
- Delete all `similar_to` edges involving the old chunk IDs (both directions — as source and target)
- After re-embedding the new chunks, re-run the cosine ANN pass for only those new chunk IDs against the existing index to rebuild `similar_to` edges

```sql
-- Full cleanup for a changed file
DELETE FROM edges
  WHERE source_id IN (SELECT id FROM chunks WHERE metadata->>'file_path' = $filePath)
     OR target_id IN (SELECT id FROM chunks WHERE metadata->>'file_path' = $filePath);

DELETE FROM chunks WHERE metadata->>'file_path' = $filePath;
```

### File deletion

Same as update, but skip the re-index step. Edges involving the deleted file's chunks are removed. Orphan `similar_to` edges from other files to those chunks are caught by the same cascade delete above.

### Avoiding full re-index of semantic edges

Re-running the full cosine ANN pass over the entire corpus after every file change is too expensive. Instead:

- Only query the pgvector index for each **new chunk's** top-K neighbors (`vectorStore.similaritySearch`)
- Only create `similar_to` edges for those pairs
- Edges from old neighbors to the now-deleted chunks are already cleaned up in the cascade delete above

This keeps the semantic edge update cost proportional to the number of changed chunks, not the total codebase size.

### What does NOT need updating

- Chunks and edges for **unchanged files** — untouched
- The HNSW index itself — pgvector maintains it automatically on insert/delete, no manual rebuild needed

---

## LangChain.js Integration Points

| Concern | Tool | Reason |
|---|---|---|
| AST parsing, chunking, static edges | `web-tree-sitter` + `tree-sitter-wasms` | Needs actual AST for symbol boundaries, import resolution, and `contains`/`imports` edge building. LangChain's splitter is regex-based — no AST, no metadata. |
| Document model | `@langchain/core` `Document` | Wraps chunk text + metadata for the pipeline |
| Embeddings | `OllamaEmbeddings` / `OpenAIEmbeddings` / `CohereEmbeddings` | Swappable via `Embeddings` interface |
| Vector store + upsert + HNSW index | `PGVectorStore` | `initialize()` creates the table; `createHnswIndex()` adds the HNSW ANN index; `addDocuments()` handles embedding + upsert; `similaritySearch()` for cosine search |
| Keyword search (BM25) | `pg_bm25` (`paradedb` extension) — or `tsvector` GIN as fallback | True BM25 ranking for exact/near-exact term matching (symbol names, identifiers, error strings) |
| Similarity retrieval | `vectorStore.similaritySearch(query, k)` | Built-in cosine search via pgvector |
| Hybrid retrieval | Custom `GraphRetriever extends BaseRetriever` | Merges BM25 + vector ranked lists via RRF, then BFS graph traversal |

`web-tree-sitter` is the only tool that can serve both chunking and static edge building — one AST parse per file covers both. LangChain's `RecursiveCharacterTextSplitter` is **not used**.

---

## Indexing CLI

The initial index is created by running an ingestion CLI against a local repo path. This is a one-time operation; subsequent runs are incremental (mtime + hash check).

```bash
# Full index of a repo
node cli.js index --root /path/to/repo

# Re-index only changed files (default after first run)
node cli.js index --root /path/to/repo --incremental

# Index a specific subtree
node cli.js index --root /path/to/repo --dir src/auth
```

### What `index` does

```
1. Walk filesystem → collect files with language + mtime
2. Filter by mtime + sha256 hash (skip unchanged)
3. For each changed file:
   a. Parse AST (web-tree-sitter) → emit Document[]
   b. Embed + store (PGVectorStore.addDocuments)
   c. Rebuild structural edges (imports + contains)
4. Post-pass: rebuild semantic (similar_to) edges for new chunks only
```

### Throughput and time estimates

The bottleneck is **embedding generation**, not AST parsing or DB writes:

| Embedding backend | Throughput | 10K chunks |
|---|---|---|
| Ollama local (nomic-embed-text, GPU) | ~200–500 chunks/min | ~20–50 min |
| Ollama local (CPU only) | ~30–80 chunks/min | ~2–5 hours |
| OpenAI `text-embedding-3-small` | ~2000 chunks/min (batched) | ~5 min |

A typical medium codebase (~50K LOC) produces ~3K–8K chunks. With a GPU-accelerated local model that's under 30 minutes for the initial index.

To speed up local Ollama: increase `--batch` size in the CLI to embed multiple chunks per call (Ollama supports batch embedding natively) and run with `OLLAMA_NUM_PARALLEL` set.

```ts
// Batch embedding — embed N chunks in one Ollama call instead of N calls
const batchSize = 32;
for (let i = 0; i < docs.length; i += batchSize) {
  await vectorStore.addDocuments(docs.slice(i, i + batchSize));
}
```

---

## Build Order (Phase 1)

1. **Postgres + pgvector schema** — `PGVectorStore.initialize()` (creates `chunks` table) + `createHnswIndex()` + manual `edges` table
2. **Filesystem walker** — recursive walk with gitignore support, language detection
3. **web-tree-sitter chunker** — load grammar per language, walk AST declaration nodes, emit `Document[]` with symbol metadata
4. **LangChain.js embed + store** — `PGVectorStore.addDocuments(docs)`
5. **Structural edges** — Tree-sitter AST → `imports` edges (all languages) + `contains` edges from declaration nodes
6. **Semantic edges** — pgvector HNSW cosine pass → `similar_to` edges
7. **BM25 index** — `pg_bm25` index on `chunks.content` (or `tsvector` GIN fallback)
8. **Incremental update pipeline** — mtime pre-filter + sha256 hash confirmation, cascade-delete stale chunks/edges, re-index changed files only
9. **Hybrid retriever** — `GraphRetriever extends BaseRetriever` (BM25 + vector via RRF + BFS graph)
10. **MCP server** — expose `search_code`, `get_symbol_context`, `get_file_graph` tools
11. **Decay cron** — nightly edge weight pruning

---

## Phase 2 (Future) — External Connectors

Once the codebase layer is solid, connectors follow the same node/edge model:

| Source | Node type | Key edges |
|---|---|---|
| GitLab issues | `issue` | `relates_to` code symbols mentioned in description |
| GitLab MRs | `note` | `resolves` issue, `modifies` file |
| Wiki pages | `concept` | `references` code files via `[[wikilink]]` or file paths |
| Slack threads | `note` | `mentions` symbol or issue |

Each connector: fetch → normalize to `Document` → embed → upsert → create edges. The memory engine and retriever are unchanged.

---

## Key Insight

> The graph layer on top of pure vector search is what makes retrieval genuinely useful. A search for "auth bug" should surface the relevant functions, the files they live in, and (in Phase 2) the issue that reported it and the MR that fixed it — not just the closest embedding hits in isolation.
