# ADR: ZoC Combat Orchestrator Overhaul (Per-Tick, Resolver-Based)

- Date: 2025-08-17
- Status: Proposed
- Decision Owner: gameplay/engine

## Context

We must implement the ZoC spec as a deterministic, tick-driven combat system integrated with the editor. Current concrete-combat provides strike math but not movement/outer-ring/stance logic or per-tick control. Editor needs begin/step/end hooks and stance/tileLength controls. Determinism and aiLogger-only logging are mandatory.

## Decision

Adopt a resolver-based, per-tick Combat Orchestrator (Option B). We will:

- Extract per-tick resolvers for RangedPhase → MovementPhase (speed × tileLength; stance range) → MeleePhase → Morale/Break → ReinforcementPhase.
- Orchestrate outer-ring engagements on hex grids; ranged-first ordering; no while-loops in production paths.
- Keep concrete-combat as the strike/damage model invoked from MeleePhase; gradually align APIs if needed.
- Provide editor/runtime APIs for begin/step/end encounters, setStance, setTileLength. Implement sub-unit CRUD mutators.

## Scope

- Engine: `packages/engine/src/systems/combat-orchestrator/*`, integrate with `concrete-combat.ts` and `Runtime` mutators.
- Editor: `apps/editor/src/app/runtime.service.ts` bridge; node harness remains for tests.
- Tests: unit (resolvers), integration (editor harness), debug commands.

## Interfaces (contract)

Engine Orchestrator (new/expanded):
- beginEncounter(spec: EncounterSpec, opts?: { tileLength?: number; seed?: number }): CombatState
- stepEncounter(state: CombatState, ticks?: number): CombatState
- endEncounter(state: CombatState): CombatResult
- setTileLength(state: CombatState, tileLength: number): void
- setStance(state: CombatState, side: 'attacker'|'defender', stance: 'normal'|'aggressive'|'defensive'|'skirmish'): void

Runtime Bridge (engine):
- runtime.beginEncounter(spec, opts)
- runtime.stepEncounter(encounterId, ticks)
- runtime.endEncounter(encounterId)
- runtime.setEncounterTileLength(encounterId, tileLength)
- runtime.setEncounterStance(encounterId, side, stance)
- Mutators: 'army.unit.add'|'army.unit.update'|'army.unit.remove'

Editor Service:
- Mirrored methods to engine runtime for the above; return small result DTOs for UI.

Debug Commands:
- debug:combat:orchestrator → dump CombatState and last phases
- debug:combat:health → validate invariants and determinism per tick

## Invariants & Constraints

- Deterministic only (seeded RNG); no Math.random.
- aiLogger categories for all logs; no console.log.
- Ranged resolves before movement/melee within a tick.
- Engagement at outer ring until contact; contact only when movement crosses ring threshold.
- Performance near-linear per tick relative to engaged units/tiles.

## Test Plan

Unit (engine):
- Outer-ring detection across stances/ranges on hex grid
- Movement timing with speed × tileLength (time-to-contact)
- Ranged-first ordering; ammo consumption; no melee before contact
- Reinforcement scheduling (arrival windows), integration into line
- HQ rules: pullback trigger; destruction conditions

Integration (editor harness, fast Node):
- begin/step/end happy path; reproducible per seed
- Stance changes affect ring closure time and ranged engagement duration
- TileLength scaling impacts ticks-to-contact deterministically
- Multi-army reinforcements; stable results under seed
- Placement unchanged; removal/undo intact

Quality Gates:
- All current suites remain green throughout
- New orchestrator unit/integration suites green
- debug:status and debug:combat:* pass
- Breadcrumbs + AI_INDEX updated at the end

## Migration & Phasing

1) Implement resolvers and orchestrator API; keep concrete-combat as strike engine.
2) Add Runtime + Editor bridges; wire minimal UI-facing DTOs; maintain old paths.
3) Introduce tests per matrix; keep green at each checkpoint.
4) Add debug commands, breadcrumbs; regenerate AI_INDEX.

## Alternatives Considered

- Incremental without resolver extraction (Option A): faster start but leaves layered complexity.
- Hybrid (Option C): stepwise toward resolvers; acceptable but prolongs duplication.

## Consequences

- Clear per-tick mental model; better logging/telemetry; easier to test.
- Initial refactor cost; broader API surface for editor/runtime.

## Open Questions

- LOS/terrain gating for ranged this phase? (default: basic range only; extend later)
- Exact HQ pullback thresholds (use design defaults; parameterize in rules)
