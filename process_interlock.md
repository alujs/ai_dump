# Process Interlock (Modes + Working Set)

## Modes
- **Explain Mode**: Produce clear, role-appropriate explanations (product, junior, architect). Grounded in retrieved code and the AI index.
- **Debug Mode**: From a failing test or bug report → hypothesize root cause → propose patch → list verification steps.
- **Implement Mode**: From acceptance criteria and invariants → plan → minimal patch → tests → risks.

## Working Set Discipline
- **READ set**: ≤ 12 symbols/files supplying context/dependencies.
- **WRITE set**: ≤ 5 symbols/files to modify.
- **Invariants**: ≤ 8 short truths that MUST hold.
- **Checkpoint**: 1–3 sentence summary of last change + last diff (trimmed).

All packets must include those four. If more context is needed:

```yaml
ScopeChange:
  add_read:
    - { file: <path>, symbol: <name> }
  add_write:
    - { file: <path>, symbol: <name> }
  justification: "Why expansion is required"
```

Stop after emitting `ScopeChange`.

## Token Budget
- Retrieved chunks: ≤ 15, each 150–300 tokens (header + snippet).
- Scaffold (task + acceptance + invariants + sets): ≤ ~900 tokens.
- Last diff/checkpoint: ≤ ~900 tokens.
- Reserve ≥ 40% of context for reasoning.
