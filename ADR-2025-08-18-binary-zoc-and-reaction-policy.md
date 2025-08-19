# ADR: Binary ZoC, Inner-Ring Retention, and Reaction Policy (v0.12)

Status: Accepted
Date: 2025-08-18
Owner: systems/combat.zoc

## Decision

Replace the “pressure/thresholds” ZoC model with a binary, stance-based coverage model and formalize reactions as binary and pre-planned.

- ZoC is a set of tiles within a stance-defined radius around each army. No scalar magnitudes.
- Inner-ring retention: rings 0–1 remain owned unless physically occupied by hostile units during combat ticks. Outer rings can be lost tile-by-tile due to absence/presence.
- Reactions are pre-authorized during PLAN and are binary: a faction either gets an INSTANTS/Reaction window or it does not. Resolution uses a deterministic, seeded tie-break table.

## Context

Previous docs used “pressure” (continuous 0..1 field with falloff/thresholds) to classify fronts and drive withdraw/overrun. The design intent has shifted:

- PLAN → (optional INSTANTS/Reaction) → RESOLVE; all simultaneous and deterministic.
- Visibility/intel gates whether reactions are available; not pressure.
- Withdraw/Chase resolve via pin/escape and screen spend (see TODO_COMBAT config), not Δ-pressure.

## Rationale

- Determinism and clarity: binary sets avoid ambiguity and micro-spam; reactions are pre-planned.
- Performance: set operations over hex rings are simpler and predictable.
- UX: overlays and contested perimeters align naturally with coverage and overlap.

## Details

Stance radii (initial):
- AGGRESSIVE: 4
- NORMAL: 2
- STEALTH: 1
- TRAVEL: limited/non-engaging, may use `travelRadius` for pass-through lanes (does not engage).

Inner-ring retention:
- Tiles at range 0 and 1 around the army’s current position remain owned unless an enemy occupies that tile during a RESOLVE tick.
- When the army moves, the retained rings move with it; tiles outside the new radius drop immediately unless covered by another friendly source.

Reactions:
- Binary eligibility based on explicit intel triggers (e.g., detected enemy intent into region R). Pre-authorized policies are set in PLAN.
- Ordering within INSTANTS is deterministic: sort by (factionId, entityId, insertionIndex) with a seeded tie-break table for exact ties.

Withdraw/Chase:
- Use pin/escape checks and screen spend from TODO_COMBAT config. No Δ-pressure. “Overrun” occurs when withdrawing with `screenPool <= 0` and chaser pins successfully.

FoW/Intel:
- Coverage is visible per FoW rules. Phantom ZoC outlines persist for configured turns after loss of sight.

## Impact

- Docs: Update README_ZOC_v0.12.md and ZOC_RECIPIES.md to remove pressure/falloff/thresholds. Replace with coverage sets and retention rules.
- Engine (follow-up): Migrate ZoneOfControlManager APIs from scalar fields to set membership (owned, contested). Keep a private AI “threat index” only if needed, not used by mechanics/UI.
- Editor: Overlays already render perimeters; ensure logic reads set membership, not magnitudes.
- Tests: Replace pressure-based tests with set membership tests (rings, overlap, retention during movement).

## Alternatives Considered

1) Rename pressure → control (doc-only). Rejected: leaves ambiguity; engine/UI still drift.
2) Hybrid: keep AI-only scalar. Deferred: only if AI evaluation needs it later; must remain invisible to mechanics/UI.

## Migration Plan

1. Docs (this change): README_ZOC_v0.12.md, ZOC_RECIPIES.md updated; add ADR (this file).
2. Engine: add set-based helpers alongside existing functions; deprecate scalar APIs; flip callers; remove scalar.
3. Tests: add ring/overlap/retention tests; then remove scalar tests.
4. AI_INDEX and breadcrumbs: update entries and debug commands.

## Open Questions

- Terrain gating for coverage projection (mountains/rivers) and road pass-through: define blockers/allowances.
- Coalition stacking cap: whether allied union extends beyond max of member radii.
- Exact intel triggers catalog for granting Reaction windows.
