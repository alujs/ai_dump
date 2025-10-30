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

### Add this to the copilot-instructions.md
“Always call vector.search for shape cards before emitting code. Obey attributes/events exactly; don’t invent props; prefer programmatic names over aria-label.”

Do this now (one pass)

Freeze inputs: back up current rules; keep copilot-instructions.md tiny (3 lines: “call vector.search; obey cards; skip other preload”).

Emit seeds: use GPT-5-mini to convert active rules + any *.md into seed/rule_cards.jsonl (≤150 tokens per rule, tight tags).

Start storage: docker compose up -d (or skip if you’re snapshot-only for now).

Create index: run your ensure-index once.

Ingest: run the ingest script on the rule cards only (no code yet).

Smoke test: run 3–5 golden queries with graph:search (expect sensible rule hits).

Add rerank: enable KNN→rerank in the MCP’s vector.search.

Launch MCP: start server; confirm it logs tool handshake.

Open fresh Copilot chat: new session (don’t reuse an old context).

Test: in a real file, ask Copilot to refactor using vector.search for shape/tech/rule cards and run the micro-critic before emit.

Then

If retrieval looks good → add code exemplars in small batches (5–10), re-ingest, retest.

If it wobbles → adjust rule texts/tags (don’t add volume yet).

Optional later: add snapshot fallback; keep Neo4j optional.


### Fallback 
```
// mcp/server.mjs  (dual-backend with snapshot fallback)
import fs from 'node:fs';
import zlib from 'node:zlib';
import neo4j from 'neo4j-driver';
const { pipeline } = await import('@xenova/transformers');

// --- config/env ---
const cfg  = JSON.parse(fs.readFileSync(new URL('../lock.json', import.meta.url)));
const SNAP = new URL('../snapshot.json.gz', import.meta.url);
const uri  = process.env.NEO4J_URI  || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const pass = process.env.NEO4J_PASS || 'neo4j';
const K_DEFAULT = Number(process.env.K || 8);

// --- embedder + reranker (lazy) ---
let embedder = null, reranker = null;
async function E() { return embedder ||= await pipeline('feature-extraction', cfg.embedding_model_id); }
async function R() { return reranker ||= await pipeline('text-classification', cfg.reranker_model_id || 'Xenova/bge-reranker-base', { topk:1 }); }

// --- backend wiring ---
let backend = 'neo4j';
let driver, session;

// fp16↦f32 decode (matches snapshot.mjs)
function f16tof32(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if (!e) return (s?-1:1) * Math.pow(2,-14) * (f/1024);
  if (e===31) return f?NaN:((s?-1:1)*Infinity);
  return (s?-1:1) * Math.pow(2, e-15) * (1 + f/1024);
}
function decodeFp16Base64(b64) {
  const buf = Buffer.from(b64, 'base64');
  const u16 = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength/2);
  const out = new Float32Array(u16.length);
  for (let i=0;i<u16.length;i++) out[i] = f16tof32(u16[i]);
  return out;
}

// snapshot store (filled if fallback)
let SNAP_ENTRIES = []; // {id,path,summary,tags,vec:Float32Array,norm:number}

// cosine KNN over snapshot
function knnSnapshot(qvec, k) {
  const qnorm = Math.hypot(...qvec);
  const scores = SNAP_ENTRIES.map(e => {
    let dot = 0; const v = e.vec;
    for (let i=0;i<v.length;i++) dot += v[i]*qvec[i];
    return { e, score: dot / (e.norm * qnorm) };
  });
  scores.sort((a,b)=>b.score-a.score);
  return scores.slice(0,k).map(({e,score}) => ({
    path: e.path, summary: e.summary, tags: e.tags||[], score
  }));
}

// try Neo4j quickly; else load snapshot
async function initBackend() {
  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
    session = driver.session();
    await Promise.race([
      session.run('RETURN 1 AS ok'),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('neo4j timeout')), 1200))
    ]);
    backend = 'neo4j';
    console.error('[MCP] backend=neo4j');
  } catch {
    backend = 'snapshot';
    if (!fs.existsSync(SNAP)) throw new Error('snapshot.json.gz not found and Neo4j unavailable');
    const raw = zlib.gunzipSync(fs.readFileSync(SNAP));
    const snap = JSON.parse(raw);
    SNAP_ENTRIES = snap.entries.map(x => {
      const vec = decodeFp16Base64(x.vector_b16);
      const norm = Math.hypot(...vec);
      return { id:x.id, path:x.path||null, summary:x.summary, tags:x.tags||[], vec, norm };
    });
    console.error(`[MCP] backend=snapshot entries=${SNAP_ENTRIES.length}`);
  }
}
await initBackend();

// --- shared search with rerank ---
async function doSearch(query, k = K_DEFAULT) {
  const e = await E();
  const q = Array.from((await e(query, { pooling:'mean', normalize:true })).data);
  if (q.length !== cfg.embedding_dim) throw new Error('Dim mismatch with lock.json');

  let pool;
  if (backend === 'neo4j') {
    const cypher = `
      CALL db.index.vector.queryNodes($index, $k, $vec)
      YIELD node, score
      RETURN node.path AS path, node.summary AS summary, node.tags AS tags, score
      ORDER BY score DESC LIMIT $k`;
    const res = await session.run(cypher, { index: cfg.neo4j_index, k: Math.max(k, K_DEFAULT*4), vec: q });
    pool = res.records.map(r => ({
      path: r.get('path'), summary: r.get('summary'), tags: r.get('tags')||[], knn: r.get('score')
    }));
  } else {
    // wider pool for rerank, similar to neo4j path
    pool = knnSnapshot(q, Math.max(k, K_DEFAULT*4)).map(x => ({ ...x, knn: x.score }));
  }

  // cross-encoder rerank
  const rr = await R();
  for (const it of pool) {
    const out = rr([{ text: query, text_pair: `${it.summary} [${(it.tags||[]).slice(0,5).join(',')}]` }])[0];
    it.rerank = (Array.isArray(out) ? out[0].score : out.score) ?? 0;
  }
  pool.sort((a,b)=>b.rerank-a.rerank);
  return pool.slice(0, k).map(it => ({
    path: it.path, summary: it.summary, tags: it.tags || [], score: it.rerank
  }));
}

// --- MCP plumbing (unchanged API) ---
function write(id, result) { process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result })+'\n'); }
function writeError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, error:{code,message} })+'\n'); }

process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  for (const line of chunk.split(/\n/).filter(Boolean)) {
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params = {} } = msg;
    try {
      if (method === 'initialize')  return write(id, { protocolVersion:'0.1', capabilities:{ tools:true } });
      if (method === 'tools/list')  return write(id, { tools:[
        { name:'vector.search',
          description:`KNN search (${backend}) with cross-encoder rerank`,
          input_schema:{ type:'object', properties:{ query:{type:'string'}, k:{type:'integer',default:K_DEFAULT} }, required:['query'] } }
      ]});
      if (method === 'tools/call') {
        const { name, arguments: args = {} } = params;
        if (name === 'vector.search') {
          const out = await doSearch(String(args.query||''), Number(args.k||K_DEFAULT));
          // echo provenance to logs (quick sanity)
          console.error('[vector.search]', { backend, k: out.length, q: (args.query||'').slice(0,80) });
          return write(id, { content:[{ type:'text', text: JSON.stringify(out, null, 2) }] });
        }
        return writeError(id, -32601, 'Unknown tool');
      }
      if (method === 'shutdown') return write(id, null);
      if (method === 'exit')     return process.exit(0);
    } catch (err) {
      writeError(id, -32000, err?.message || 'Internal error');
    }
  }
});

process.on('SIGINT', async () => { try { await session?.close(); await driver?.close(); } finally { process.exit(0); } });

```

