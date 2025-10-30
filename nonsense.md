# GraphRAG Minimal Starter (Neo4j + Xenova + MCP)

A small, **local-only** starter you can drop into your 7‑year Angular repo under `/.ai/graph/`. No Docker. Uses **Neo4j 5.x** + **@xenova/transformers** for embeddings. Includes a tiny **MCP stdio server** with two tools: `vector.search` and `ingest.upsert`.

> Directory layout (put these files under `/.ai/graph/`):
>
> * `lock.json`
> * `seed/seed_examples.jsonl`
> * `scripts/ensure_index.mjs`
> * `scripts/ingest.mjs`
> * `scripts/search.mjs`
> * `mcp/server.mjs`
> * `package.json` (local to `/.ai/graph/`, not the Angular app)

---

## 1) `package.json` (ESM + scripts)

```json
{
  "name": "graphrag-local",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "scripts": {
    "graph:ensure-index": "node ./scripts/ensure_index.mjs",
    "graph:ingest": "node ./scripts/ingest.mjs",
    "graph:search": "node ./scripts/search.mjs",
    "graph:mcp": "node ./mcp/server.mjs"
  },
  "dependencies": {
    "@xenova/transformers": "^2.17.0",
    "neo4j-driver": "^5.23.0"
  },
  "devDependencies": {
    "@angular-eslint/template-parser": "^17.4.0",
    "ts-morph": "^22.0.0"
  }
}
```

> **Note:** versions here are examples; pin them to what you actually install.

---

## 2) `lock.json` (pin the math + config)

```json
{
  "embedding_model_id": "Xenova/bge-small-en-v1.5",
  "embedding_dim": 384,
  "similarity": "cosine",
  "neo4j_index": "code_example_embedding",
  "ruleset_version": "v0"
}
```

---

## 3) `seed/seed_examples.jsonl` (tiny initial exemplars)

Each line is one JSON object. Keep **summaries** short; no raw code.

```jsonl
{"path":"src/app/features/profile/profile-card.component.ts","summary":"Profile card component with tablist navigation; uses sdf-tabs; ARIA tablist/tabpanel; keyboard arrows; dark mode tokens.","tags":["a11y","tabs","sdf"]}
{"path":"src/app/shared/forms/input-accessible.component.ts","summary":"Accessible text field using sdf-input; label-for; describedby help text; error state announced; no adp-*.","tags":["a11y","forms","sdf"]}
{"path":"src/app/layout/nav/side-nav.component.ts","summary":"Nav with roving tabindex; proper roles; collapse/expand button announced; prefers tokens over hex.","tags":["a11y","navigation","tokens"]}
```

---

## 4) `scripts/ensure_index.mjs`

Creates the Neo4j **vector index** once. Reads `lock.json`.

```js
import fs from 'node:fs';
import neo4j from 'neo4j-driver';

const cfg = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
const session = driver.session();

const cypher = `
CREATE VECTOR INDEX ${cfg.neo4j_index} IF NOT EXISTS
FOR (n:CodeExample) ON (n.embedding)
OPTIONS {
  indexConfig: {
    ` +
  "`vector.dimensions`" +
  `: ${cfg.embedding_dim}, ` +
  "`vector.similarity_function`" +
  `: '${cfg.similarity}'
  }
};`;

try {
  console.log('Ensuring vector index…');
  await session.run(cypher);
  console.log('OK.');
} finally {
  await session.close();
  await driver.close();
}
```

---

## 5) `scripts/ingest.mjs`

Reads the seed JSONL, embeds each summary with **Transformers.js**, and upserts `:CodeExample` nodes with an `embedding` property.

```js
import fs from 'node:fs';
import readline from 'node:readline';
import neo4j from 'neo4j-driver';
const { pipeline } = await import('@xenova/transformers');

const cfg = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

const embedder = await pipeline('feature-extraction', cfg.embedding_model_id);

function asArray(tensor) {
  // Transformers.js returns a Tensor; `.data` is a TypedArray
  return Array.from(tensor.data);
}

async function embed(text) {
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  const arr = asArray(out);
  if (arr.length !== cfg.embedding_dim) throw new Error(`Dim mismatch: got ${arr.length}`);
  return arr;
}

const seedPath = new URL('../seed/seed_examples.jsonl', import.meta.url);
const rl = readline.createInterface({ input: fs.createReadStream(seedPath), crlfDelay: Infinity });

let count = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  const { path, summary, tags = [] } = row;
  const embedding = await embed(summary);
  await session.executeWrite(tx => tx.run(
    `MERGE (n:CodeExample { path: $path })
     SET n.summary = $summary,
         n.tags = $tags,
         n.embedding = $embedding,
         n.quality = coalesce(n.quality, 0.7)`,
    { path, summary, tags, embedding }
  ));
  count++;
}

console.log(`Ingested ${count} exemplar(s).`);
await session.close();
await driver.close();
```

---

## 6) `scripts/search.mjs`

Embeds a natural-language query, runs **KNN** against the vector index, returns top‑k.

```js
import fs from 'node:fs';
import neo4j from 'neo4j-driver';
const { pipeline } = await import('@xenova/transformers');

const cfg = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const query = process.argv.slice(2).join(' ') || 'accessible tabbed profile card';
const k = Number(process.env.K || 5);

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
const session = driver.session();
const embedder = await pipeline('feature-extraction', cfg.embedding_model_id);

function asArray(t) { return Array.from(t.data); }

const qvec = asArray(await embedder(query, { pooling: 'mean', normalize: true }));
if (qvec.length !== cfg.embedding_dim) throw new Error('Dim mismatch with lock.json');

const cypher = `
CALL db.index.vector.queryNodes($index, $k, $vec)
YIELD node, score
RETURN node.path AS path, node.summary AS summary, score
ORDER BY score DESC
LIMIT $k`;

const res = await session.run(cypher, { index: cfg.neo4j_index, k, vec: qvec });
for (const r of res.records) {
  console.log(`${r.get('score').toFixed(4)}  |  ${r.get('path')}\n  → ${r.get('summary')}`);
}

await session.close();
await driver.close();
```

---

## 7) `mcp/server.mjs` (minimal stdio server with two tools)

This is a **tiny JSON‑RPC/MCP‑style** server over stdio exposing `vector.search` and `ingest.upsert`. It’s intentionally minimal—good enough for local experiments.

```js
import fs from 'node:fs';
import neo4j from 'neo4j-driver';
const { pipeline } = await import('@xenova/transformers');

const cfg = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
const session = driver.session();
let embedder = null;

function write(id, result) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(payload + '\n');
}
function writeError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function ensureEmbedder() {
  if (!embedder) embedder = await pipeline('feature-extraction', cfg.embedding_model_id);
  return embedder;
}

async function doSearch(query, k = 5) {
  const e = await ensureEmbedder();
  const vec = Array.from((await e(query, { pooling: 'mean', normalize: true })).data);
  const cypher = `CALL db.index.vector.queryNodes($index, $k, $vec) YIELD node, score
                  RETURN node.path AS path, node.summary AS summary, node.tags AS tags, score
                  ORDER BY score DESC LIMIT $k`;
  const res = await session.run(cypher, { index: cfg.neo4j_index, k, vec });
  return res.records.map(r => ({
    path: r.get('path'),
    summary: r.get('summary'),
    tags: r.get('tags') || [],
    score: r.get('score')
  }));
}

async function doIngest(file = '../seed/seed_examples.jsonl') {
  const seedPath = new URL(file, import.meta.url);
  const lines = fs.readFileSync(seedPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const e = await ensureEmbedder();
  let n = 0;
  for (const line of lines) {
    const { path, summary, tags = [] } = JSON.parse(line);
    const embedding = Array.from((await e(summary, { pooling: 'mean', normalize: true })).data);
    await session.executeWrite(tx => tx.run(
      `MERGE (n:CodeExample { path: $path })
       SET n.summary = $summary, n.tags = $tags, n.embedding = $embedding,
           n.quality = coalesce(n.quality, 0.7)`,
      { path, summary, tags, embedding }
    ));
    n++;
  }
  return { ingested: n };
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  for (const line of chunk.split(/\n/).filter(Boolean)) {
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = msg;

    try {
      if (method === 'initialize') {
        return write(id, { protocolVersion: '0.1', capabilities: { tools: true } });
      }
      if (method === 'tools/list') {
        return write(id, {
          tools: [
            {
              name: 'vector.search',
              description: 'KNN search over CodeExample embeddings',
              input_schema: {
                type: 'object',
                properties: { query: { type: 'string' }, k: { type: 'integer', default: 5 } },
                required: ['query']
              }
            },
            {
              name: 'ingest.upsert',
              description: 'Ingest seed examples (JSONL) into Neo4j',
              input_schema: {
                type: 'object',
                properties: { file: { type: 'string', default: '../seed/seed_examples.jsonl' } }
              }
            }
          ]
        });
      }
      if (method === 'tools/call') {
        const { name, arguments: args = {} } = params;
        if (name === 'vector.search') {
          const out = await doSearch(String(args.query || ''), Number(args.k || 5));
          return write(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        }
        if (name === 'ingest.upsert') {
          const out = await doIngest(String(args.file || '../seed/seed_examples.jsonl'));
          return write(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        }
        return writeError(id, -32601, 'Unknown tool');
      }
      if (method === 'shutdown') { write(id, null); }
      if (method === 'exit') { process.exit(0); }
    } catch (err) {
      writeError(id, -32000, (err && err.message) || 'Internal error');
    }
  }
});

process.on('SIGINT', async () => { await session.close(); await driver.close(); process.exit(0); });
```

> This is a minimal, MCP‑style stdio server. For production, swap to an official MCP SDK when you’re ready.

---

## 8) Quick runbook

1. **Start Neo4j** (one‑time password set via [http://localhost:7474](http://localhost:7474)).
2. From repo root: `cd .ai/graph && npm install`
3. Create index: `npm run graph:ensure-index`
4. Ingest seeds: `npm run graph:ingest`
5. Query KNN: `npm run graph:search -- "accessible tabbed profile card"`
6. Optional MCP: `npm run graph:mcp` (then hook up in VS Code via `.vscode/mcp.json`)

---

## 9) `.vscode/mcp.json` (optional, if you want Copilot to see it)

```json
{
  "mcpServers": {
    "graphrag-local": {
      "command": "node",
      "args": ["./.ai/graph/mcp/server.mjs"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASS": "YOUR_PASSWORD"
      },
      "autoStart": false
    }
  }
}
```

Turn it on when you want it; otherwise it stays silent.

## 10) Gotta fold in the re-ranker logic
```
// scripts/search_rerank.mjs
import fs from 'node:fs';
import neo4j from 'neo4j-driver';
const { pipeline } = await import('@xenova/transformers');

const cfg = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const query = process.argv.slice(2).join(' ') || 'accessible tabbed profile card';
const kEmbed = Number(process.env.K_EMBED || 50);     // initial KNN pool
const kFinal  = Number(process.env.K_FINAL  || 10);    // after rerank

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
const session = driver.session();

const embedder = await pipeline('feature-extraction', cfg.embedding_model_id);
const reranker = await pipeline('text-classification', cfg.reranker_model_id, { topk: 1 });

const qvec = Array.from((await embedder(query, { pooling: 'mean', normalize: true })).data);
if (qvec.length !== cfg.embedding_dim) throw new Error('Dim mismatch with lock.json');

const cypher = `
CALL db.index.vector.queryNodes($index, $k, $vec)
YIELD node, score
RETURN node.path AS path, node.summary AS summary, node.tags AS tags, score
ORDER BY score DESC
LIMIT $k`;

const res = await session.run(cypher, { index: cfg.neo4j_index, k: kEmbed, vec: qvec });
const pool = res.records.map(r => ({
  path: r.get('path'),
  summary: r.get('summary'),
  tags: r.get('tags') || [],
  knn: r.get('score')
}));

// Cross-encoder rerank (query, doc) → relevance score
function pairScore(q, d) {
  // Many rerankers output a single positive-class score in .score
  const out = reranker([{ text: q, text_pair: d }])[0];
  return (Array.isArray(out) ? out[0].score : out.score) ?? 0;
}

for (const item of pool) {
  // Keep doc text concise: summary + lightweight tag hint
  const doc = `${item.summary} [${item.tags.slice(0,5).join(', ')}]`;
  item.rerank = await pairScore(query, doc);
}

pool.sort((a, b) => b.rerank - a.rerank);
for (const it of pool.slice(0, kFinal)) {
  console.log(`${it.rerank.toFixed(4)}  |  ${it.path}\n  → ${it.summary}`);
}

await session.close();
await driver.close();
```


### Step 3 — Micro-Critic (Pre-Emit)
Evaluate the planned code changes against the shape cards retrieved earlier. 
Checklist:
- Are all required attributes present?
- Any disallowed attributes added?
- Do ARIA names follow policy?
- Is component event/output naming correct?
If any item fails, revise the plan and retry once before emitting code.


