# ADR: Full Remediation — FoW, ZoC, Observability, and Integration Tests

- Date: 2025-08-19
- Status: Proposed
- Owners: engineering
- Related: ADR-2025-08-17-fow-gating-centered-map-activity-log.md, ADR-2025-08-17-zoc-orchestrator-overhaul.md, AI_INDEX.yml

## Context

We’ve spent multiple cycles trying to stabilize Fog of War (FoW) and Zone of Control (ZoC) behavior. Symptoms observed:
- FoW sometimes requires repeated toggles to take effect; ordering/races due to effect-driven writes during change detection.
- ZoC overlays show perimeter gaps; per-edge strokes without boundary tracing.
- Console spam from hot-path INFO logs (PERFORMANCE/COMBAT), obscuring useful signals.
- Missing neutral integration tests to validate engine→render pipelines; unit tests pass but real flows regress.
- Editor “effects-first” coupling to runtime created fragility (NG0600 writes during flush).
- Minor build noise: ajv CommonJS warning in editor builds (ESM bailout).

Invariants and contracts:
- Deterministic engine; no nondeterministic sources in state transitions.
- FoW must be strictly enforced by player perspective.
- ZoC is binary radius=2; precedence: contested > selected > empire.
- No writes inside reactive effect flush; single, atomic apply pipeline for runtime changes.
- Default logging level WARN; diagnostics are opt-in, category-gated, and rate-limited.

## Decision

Adopt a “functional core, imperative shell” approach and remediate with a dual-track plan:
- Keep: engine (@game/engine), Pixi adapter, content, debug commands, AI_INDEX/breadcrumbs.
- Fix in place: editor host, but eliminate effect-based runtime writes; introduce an atomic fog apply.
- Add a neutral integration harness and tests outside Angular.
- Introduce UI-agnostic ZoC boundary tracer and read-only explain APIs.
- Enforce observability standards: category logging with rate limits and default WARN.

This combines Option A (surgical fixes) with Option B (neutral harness) for quickest stabilization and long-term maintainability.

## Scope Affected
- apps/editor (fog sync, selection diagnostics; remove runtime writes in effects)
- packages/engine (read-only explain APIs; logging gates/throttles)
- packages/shared (NEW: hex helpers, zoc-boundary tracer, logging adapter)
- adapters/pixi (overlay integration hooks; no logic)
- scripts/debug-commands.cjs (new debug:explain, debug:logs)
- tests/integration (NEW: engine↔render and overlay tests)

Non-goals:
- No framework migration in this ADR (can be considered later). This ADR isolates core from the host and adds tests.

## Alternatives Considered
- Replace the editor framework now: higher risk and churn; not needed to fix core issues.
- Only mute logs: hides symptoms; doesn’t fix hot-path spam nor missing tests.
- Patch visuals only: perimeter still broken without proper tracing and tests.

## Plan (Phased)

### Phase 0 — Guardrails (Logging)
- Add category gates to hot-path engine logs (PERFORMANCE, COMBAT) with default WARN in editor builds.
- Add per-category rate limits (≤1 INFO/sec) and duration threshold (>8 ms) for performance logs.
- Extend debug-commands with `debug:logs` to view/set categories and show rate-limit counters.

### Phase 1 — Integration Harness and Tests (No Angular)
- Add `tests/integration` with vitest:
  1) fog.one-toggle.integration.test.ts — Toggle fog ON/OFF once → exactly one fog frame computed and one render package built.
  2) fog.perspective.integration.test.ts — P1→P2 perspective switch changes visible/phantom counts deterministically.
  3) zoc.coverage.integration.test.ts — Known army position radius=2 coverage size matches expected; contested tiles identified.
  4) zoc.perimeter.integration.test.ts — Single blob → one closed loop; no gaps or duplicate edges; two blobs → two loops.
  5) engine-render.apply.integration.test.ts — place/remove army → exactly one render apply.
  6) logs.budget.integration.test.ts — ZoC recompute loop at default level emits ≤ N INFO lines.

### Phase 2 — Atomic Fog Apply (Editor)
- Replace effect-driven fog sync with explicit `applyFogSettings()` in the editor host:
  - computeFogFrame(player) → buildRenderPackage() → apply render — single, atomic operation.
  - Idempotent; coalesce multiple toggles in same tick; no signal writes during effect flush.
- Add a smoke test: toggle fog once → one render; repeat same toggle → no-op.

### Phase 3 — ZoC Boundary Tracer (Shared)
- Implement a UI-agnostic half-edge tracer in `packages/shared/zoc-boundary`:
  - For each covered hex, add directed boundary edges where neighbor is not covered.
  - Trace edges into ordered closed loops; ensure no duplicates; preserve winding.
- Integrate in editor renderer: draw polylines per loop; remove ad-hoc per-edge strokes.
- Tests: contiguity, duplicate-free, multi-blob handling.

### Phase 4 — Explain APIs (Engine)
- Add read-only queries:
  - `explainAt(q, r, player)` → FoW visibility, entities at tile, ZoC coverage owners at tile (radius=2), contested flag.
  - `summarizeZoC()` → per-faction coverage sizes; contested counts.
- Used by tests, CLI (`debug:explain q r player`), and the editor select tool.

### Phase 5 — Click-Time Diagnostics (Editor UX)
- Select Tool: on click, optionally emit a single, INPUT-category, rate-limited dump using `explainAt` (not UI guesses).
- Expose `DEBUG_INTERFACE.getLastClickDump()` to copy JSON without scanning console.
- Default OFF; enable via `debug:logs` or HUD toggle; never spams.

### Phase 6 — Minimal Repo Shape Improvements
- Create `packages/shared` for hex math, zoc-boundary tracer, and a tiny logging adapter.
- Move any remaining hex helpers out of the editor.
- Address ajv CJS warning by using an ESM-friendly path/build.
- Update AI_INDEX.yml and `.breadcrumb.yml` for new modules; wire tests in CI.

## Success Criteria
- One fog toggle applies exactly once; perspective switch reflects immediately; no retries needed.
- ZoC perimeters render as continuous loop(s) with precedence contested > selected > empire.
- Default console has no hot-path INFO spam; categories are togglable and rate-limited.
- New integration tests pass locally and in CI; engine determinism preserved.
- Editor performs no runtime writes during effect flush; fog/selection paths are explicit and atomic.

## Risks and Mitigations
- Risk: Boundary tracer performance on large maps — Mitigation: trace only visible/candidate regions; cache edges per coverage change.
- Risk: Editor regressions from effect removal — Mitigation: add tests; keep a feature flag; staged rollout.
- Risk: Overfitting tests — Mitigation: use deterministic fixtures and focus on invariants (counts, loops, precedence, atomicity).

## Rollback Strategy
- Logging gates are runtime-togglable; revert to previous levels if needed.
- Feature-flag atomic fog apply and tracer integration; keep legacy path for one release if necessary.
- Changes are additive and modular (shared package, read-only explain APIs). Reverts are targeted.

## Estimated Timeline
- Phase 0–1: 0.5–1 day (logging gates, harness, first 3 integration tests)
- Phase 2: 0.5 day (atomic fog apply + smoke)
- Phase 3: 0.5–1 day (tracer + tests + integration)
- Phase 4–5: 0.5 day (explain APIs, select tool dump gated)
- Phase 6: 0.5 day (shared pkg setup, AJV ESM fix, breadcrumbs/index updates)

Total: ~2–3 days elapsed, with test coverage rising and issues closed progressively.

## Implementation Notes
- Prefer pure TypeScript for core logic; host/UI acts as a thin shell.
- Keep diagnostics opt-in and rate-limited; avoid broad log suppression.
- Maintain AI agent scaffolding: breadcrumbs, AI_INDEX regeneration, and debug:* commands.

## Acceptance
- Approve this ADR to begin implementation in phases. Code changes will reference this ADR and include tests and debug command updates.
