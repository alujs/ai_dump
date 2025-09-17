
# ADR-2025-09-SICA—Agentic Schema, Gates, and Runtime Logging (Detailed)

**Status:** Proposed  
**Owners:** <ADD OWNERS>  
**Ticket:** <ADD TICKET>  
**Date:** 2025‑09‑17

---

## 0) Context

We are implementing a **Self‑Improving Coding Agent (SICA)** inside a **Copilot-only** workflow over an Angular/TypeScript monorepo. We do **not** have LLM API access or token telemetry. We will use:
- **AI_INDEX** (sharded `.jsonl` / packet) as the *authoritative map* for retrieval.
- **Agentic JSONL runtime logs** (copy‑paste into Copilot) to route the agent directly to the correct spans without repo-wide fishing.
- **Gates** to enforce safety/correctness and a mandatory **Explain/Justify** step between *Edit* and *Evaluate*.
- **Rulesets** (policy‑as‑code) and **Agent versions** (lineage) to prove Day‑to‑Day progress and causality of improvements.

Non-goal: we do **not** measure tokens. We will use time, hops, edits, and gate fail rates as proxies.

---

## 1) Goals

1. Make the agent **code agentically**: paste JSONL → agent uses AI_INDEX keys → builds tiny READ set → proposes constrained edits.
2. Enforce **Explain/Justify** before any eval.
3. Record **comparable** progress (D0 → D3/4) with lineage and rule epochs.
4. Keep **runtime overhead** negligible in Angular (compiled out or sampled).

---

## 2) Architecture (Theory → Flow → Implementation)

### 2.1 Theory (control loop)
`User → ADR → Plan/Retrieve → Edit → Explain/Justify → Gates → Evaluate → Decide → Archive → Retool`

### 2.2 Attempt spine (IDs carried everywhere)
- `attempt_id` (ksuid/uuidv7), `request_id`, `adr_id`, `agent_version_id`, `ruleset_version_id`, `created_at`

### 2.3 Components
- **Gate Engine (CLI)** — enforces rule_gates; consumes `self_report.json`, `git_diff.patch`, `diff_meta.json`, `ruleset.jsonl`, `ai_index.packet.jsonl`, `waivers.json`.
- **Checkers** — `diff-inspector`, `self-report-validator`, `index-coverage-checker`, `ts-abi-check`, `style-check`.
- **Eval Wrapper** — executes tests/benchmarks; captures metrics (no tokens).
- **JSONL Runtime Logger** — Angular dev/test tracer; “Copy JSONL” button for paste-back.
- **Ingestion** — promote JSONL and gate/eval results into SQLite/Postgres for queries.

---

## 3) Data Model (SQLite/Postgres)

> Types use Postgres names; adapt for SQLite where needed.

### 3.1 Core
```sql
create table requests (
  id uuid primary key,
  created_at timestamptz not null default now(),
  branch text, ticket text, user_prompt text,
  intent text check (intent in ('debug','implement','migrate','analyze','adr')),
  code_change boolean not null default false
);

create table adrs (
  id uuid primary key,
  request_id uuid references requests(id),
  ticket text, title text, status text default 'Draft',
  decision_md text, risks_md text, verification_md text,
  created_at timestamptz default now()
);

create table agents (
  id uuid primary key,
  name text, purpose text, created_at timestamptz default now()
);

create table agent_versions (
  id uuid primary key,
  agent_id uuid references agents(id),
  code_hash text, prompt_hash text, toolset_hash text, env_fp text,
  created_at timestamptz default now()
);

create table rulesets (
  id uuid primary key,
  semver text, checksum text, created_at timestamptz default now()
);

create table attempts (
  id uuid primary key,
  request_id uuid references requests(id),
  adr_id uuid references adrs(id),
  agent_version_id uuid references agent_versions(id),
  ruleset_id uuid references rulesets(id),
  iteration int not null,
  started_at timestamptz default now(),
  ended_at timestamptz
);
```

### 3.2 Retrievals & Edits
```sql
create table retrievals (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  packet_hash text, shards jsonb, symbols jsonb, routes jsonb,
  reads_count int, chunks_count int, duration_ms int,
  created_at timestamptz default now()
);

create table edits (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  file text, hunk_hash text, loc int,
  touches_public_api boolean default false,
  golden_violation boolean default false,
  work_region boolean default false,
  pre_patch_sha text, post_patch_sha text,
  created_at timestamptz default now()
);
```

### 3.3 Explain/Justify, Gates, Evals, Decisions
```sql
create table self_reports (
  id uuid primary key,
  attempt_id uuid references attempts(id) unique,
  summary_md text,
  invariants jsonb, risks jsonb,
  claims jsonb,          -- [{acc, evidence:[testIds], diffRefs:[hunk hashes]}]
  coverage_map jsonb,    -- symbol->shard/route mapping
  expected_metrics jsonb,
  created_at timestamptz default now()
);

create table rule_gates (
  id uuid primary key,
  ruleset_id uuid references rulesets(id),
  key text, params jsonb
);

create table rule_evaluations (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  ruleset_id uuid references rulesets(id),
  gate_key text, pass_bool boolean, severity text default 'hard',
  evidence jsonb, duration_ms int,
  created_at timestamptz default now()
);

create table evaluations (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  test text, pass_bool boolean, duration_ms int,
  err_code text, err_fingerprint text,
  created_at timestamptz default now()
);

create table decisions (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  utility numeric,       -- computed (no tokens)
  outcome text check (outcome in ('promote','keep','reject')),
  rationale_md text,
  created_at timestamptz default now()
);

create table archives (
  id uuid primary key,
  attempt_id uuid references attempts(id),
  snapshot_hash text, diff_summary jsonb, best_so_far boolean default false,
  created_at timestamptz default now()
);
```

### 3.4 Rules Evolution (optional but recommended)
```sql
create table rule_proposals (
  id uuid primary key,
  agent_version_id uuid references agent_versions(id),
  ruleset_id uuid references rulesets(id),
  gate_key text, params jsonb,
  expected_utility_delta numeric,
  expected_false_block numeric,
  status text default 'draft',
  created_at timestamptz default now()
);
```

---

## 4) Rulesets & Gates (policy-as-code)

### 4.1 Minimal enforced gates
- `self_report_required` (hard): `exists(self_reports.attempt_id)`
- `index_coverage_ok` (hard): all touched symbols map to AI_INDEX or ScopeChange present
- `golden_guard_ok` (hard): golden region hashes unchanged unless ADR flag set
- `style_ok` (soft→hard): formatter autofix + lint-on-diff; block only on remaining errors
- `abi_ok` (hard): TS build/typecheck; public API deltas require ADR flag
- `work_region_only` (hard): edits constrained to `@work` blocks unless ADR flag

### 4.2 CLI contracts
```
diff-inspector --patch git_diff.patch > diff_meta.json
self-report-validator --self self_report.json --diff diff_meta.json
index-coverage-checker --index .ai/packet.jsonl --diff diff_meta.json > idx.json
style-check --diff diff_meta.json --autofix > style.json
ts-abi-check --project tsconfig.json > abi.json

gate-engine run   --rules ruleset.jsonl   --self self_report.json   --diff diff_meta.json   --idx idx.json   --style style.json   --abi abi.json   --waivers waivers.json   --out gate_results.json
# exit 0 pass | 2 soft-fail | 3 hard-fail
```

---

## 5) Explain/Justify (Self-Report) — JSON schema (Zod/TS)

```ts
const SelfReport = z.object({
  attempt_id: z.string(),
  plan_hash: z.string().optional(),
  diff_set_hash: z.string(),
  summary_md: z.string().max(1200),
  invariants: z.array(z.string()),
  risks: z.array(z.string()),
  claims: z.array(z.object({
    acc: z.string(),                  // acceptance criterion
    evidence: z.array(z.string()),    // test ids or scripts
    diffRefs: z.array(z.string())     // hunk hashes
  })).min(1),
  coverage_map: z.record(z.string(), z.array(z.string())), // symbol -> [shard keys]
  expected_metrics: z.object({
    eval_time_ms: z.number().int().nonnegative().optional(),
    reads: z.number().int().nonnegative().optional(),
    edits: z.number().int().nonnegative().optional()
  }).partial()
});
```

Gate: `self_report_required` checks `claims.length ≥ 1` and `diffRefs` present.

---

## 6) Golden/Work Regions (source-only; zero runtime)

**In code:**
```ts
/* @golden:start name=AccountSelectors sha256=<filled by tool> */
// … immutable region
/* @golden:end */

/* @work:start topic=profile-refactor */
// … agent may edit here
/* @work:end */
```

**Checker pseudocode:**
```python
for region in scan_regions(file):
    if region.type == "golden":
        digest = sha256(ast_normalize(region.text))
        assert digest == region.meta.sha256 or adr_flag("allow_golden_change")
    if region.type == "work":
        allow_edits_only_inside(region.span) or require_adr_flag("expand_work")
```

Sidecar: `.golden.map.json` with `{file, startLine, endLine, sha256}` maintained by the checker.

---

## 7) Agentic Runtime JSONL (copy‑paste format)

**Common header fields included on every line:**
```
ts, commit, app, project, route, routeEntryPoint, env, session, build
```

**Events (examples)**

`error`:
```json
{"type":"error","module":"libs/users/data-access/src/lib/user.service.ts","symbol":"getUserById","stack":[{"file":"user.service.ts","line":48,"symbol":"mapUser"},{"file":"users.effects.ts","line":72,"symbol":"loadUser$"}],"messageHash":"e2f1","code":"HTTP_404"}
```

`ngrx`:
```json
{"type":"ngrx","actionType":"[Users] Load User","effect":"loadUser$","selector":"selectUserById","duration_ms":87,"ok":false}
```

`http`:
```json
{"type":"http","method":"GET","url":"/api/users/42","service":"UserService","symbol":"getUserById","status":404,"duration_ms":92}
```

`trace`:
```json
{"type":"trace","module":"libs/users/ui/src/lib/user-detail.component.ts","symbol":"ngOnInit","args_hash":"ad92","duration_ms":2.6,"ok":true}
```

**Paste Contract (header to precede logs):**
```
AGENTIC_DEBUG_LOG v1
INDEX_KEYS: project,module,symbol,routeEntryPoint,selector,actionType,service
GOAL: Diagnose and fix failures using AI_INDEX; avoid repo-wide scans.
OUTPUT: self_report → diffs (work regions only) → tests.
```

---

## 8) Angular Instrumentation (dev/test only)

### 8.1 Trace decorator (services/utils)
```ts
export function Trace(): MethodDecorator {
  return (_t, key, desc: any) => {
    const orig = desc.value;
    desc.value = function(...args: any[]) {
      if (!__TRACE__) return orig.apply(this, args);
      const t0 = performance.now();
      try {
        const res = orig.apply(this, args);
        const done = (ok: boolean, err?: any) => traceEmit({
          type: "trace", module: __FILENAME__, symbol: String(key),
          args_hash: hashArgs(args), duration_ms: performance.now() - t0, ok, err: err && hashErr(err)
        });
        return (res && typeof res.then === "function")
          ? res.then((v:any)=>{done(true); return v;}).catch((e:any)=>{done(false,e); throw e;})
          : (done(true), res);
      } catch (e) { traceEmit({type:"trace", module:__FILENAME__, symbol:String(key), ok:false}); throw e; }
    };
    return desc;
  };
}
```

### 8.2 HttpInterceptor → `http`/`error`
```ts
@Injectable()
export class TraceHttpInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler) {
    if (!__TRACE__) return next.handle(req);
    const t0 = performance.now();
    return next.handle(req).pipe(
      tap({
        next: (evt) => {
          if (evt instanceof HttpResponse) {
            traceEmit({type:"http", method:req.method, url:req.url, status:evt.status, duration_ms: performance.now()-t0});
          }
        },
        error: (err) => {
          traceEmit({type:"error", code: err.status, messageHash: hashErr(err), module:"http", symbol:req.method, stack:[]});
        }
      })
    );
  }
}
```

### 8.3 NgRx meta‑reducer / helper (sketch)
```ts
export const traceMetaReducer: MetaReducer<any> = reducer => (state, action) => {
  if (__TRACE__) traceEmit({type:"ngrx", actionType: action.type});
  return reducer(state, action);
};
```

### 8.4 Devtool: “Copy JSONL”
- Keep a ring buffer of last N events; stringify and copy to clipboard.

---

## 9) Evaluation Wrapper & Utility

### 9.1 Eval wrapper (Node script)
- Executes `yarn test`/`jest` with per‑test timing (`--reporters=json`).
- Emits `evaluations.json` with `{test, pass, duration_ms, err_fingerprint}`.

### 9.2 Utility (no tokens)
```
utility = w_pass*pass_rate + w_time*(-normalized_eval_time) + w_gates*(-gate_fail_rate)
# choose stable weights (e.g., 0.6 / 0.25 / 0.15)
```

Store on `decisions.utility`.

---

## 10) Ingestion Pipeline (JSONL → DB)

1) **Runtime JSONL** (Angular dev/test) → file or `/trace` dev endpoint.  
2) **Gate results** & **Eval results** (CI) → JSON outputs.  
3) Nightly job:
   - Load JSONL into staging table `runtime_events`.
   - Aggregate features → insert/update `retrievals`, `edits`, `evaluations`.
   - Commit `attempts` and `decisions`.
   - Flip `archives.best_so_far=true` when promoted.

---

## 11) Proving Progress (queries)

### 11.1 Best utility per day
```sql
select date_trunc('day', a.started_at) as day,
       max(d.utility) as best_utility
from attempts a
join decisions d on d.attempt_id = a.id
group by 1 order by 1;
```

### 11.2 Gate fail rate drop
```sql
select date_trunc('day', re.created_at) as day,
       avg((re.pass_bool=false)::int) as fail_rate
from rule_evaluations re
group by 1 order by 1;
```

### 11.3 Edit discipline (loc/hunk)
```sql
select date_trunc('day', created_at) as day,
       avg(loc) as avg_hunk_loc
from edits group by 1 order by 1;
```

---

## 12) Performance and Overhead Budgets

- **Angular runtime**: tracing compiled out in prod (`__TRACE__=false`); dev sampling optional. Target ≤ 5µs per traced call, ≤ 1KB per event pre-batch.
- **Gates**: diff-only style checks; ABI/type checks on changed projects only; run in CI or pre-commit.
- **Golden checker**: hashes AST‑normalized slices; parallel across files.

---

## 13) Security & PII

- Hash arguments and error messages; never log raw PII.  
- Sampling in prod; dev/test default on.  
- Protect `/trace` dev endpoint by local‑only binding or auth.

---

## 14) Rollout Plan (D0 → D4)

- **D0**: Land gate-engine skeleton, `self_report` schema, golden/work markers, style check (autofix+diff).  
- **D1**: Angular tracer (http/ngrx/trace) + Copy JSONL devtool.  
- **D2**: Eval wrapper + ingestion to SQLite; basic queries.  
- **D3**: Ruleset v1 (self_report_required, index_coverage_ok, golden_guard_ok, style_ok, abi_ok, work_region_only).  
- **D4**: First promotions; show best‑utility curve and gate‑fail drop.

---

## 15) Risks

- False blocks from strict gates → mitigate with waivers and trial phases.  
- Index gaps → require ScopeChange generation rather than blind scans.  
- Log volume → ring buffer + sampling; nightly ingestion not per‑event.

---

## 16) Open Questions

- Exact weights for utility; per‑mode utility variants?  
- How strict should `work_region_only` be for surgical fixes?  
- Where to store sidecars (`.golden.map.json`) and who owns rotation?

---

## Decision

Proceed with implementation as specified; cut **Ruleset v1.0.0** and **Agent v0.1.0**; instrument dev runtime and CI; schedule D3/D4 demos to show progress metrics.
