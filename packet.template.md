<!-- Paste this whole packet into the model. Keep it under ~8k tokens. -->

# System / Guardrails
{{contents of .ai/baseline.instructions.md}}

# Task
{{title}}

## Acceptance
{{each acceptance bullet on its own line}}

## Invariants (MUST hold)
{{each invariant on its own line}}

## Working Sets
READ:
{{list file#symbol entries from working-state.json}}
WRITE:
{{list file#symbol entries from working-state.json}}

## Failing Test (if any)
{{name}} — key assertion: {{trimmed trace}}

## Last Checkpoint
{{1–3 sentences}}

## Last Diff (trimmed)
```diff
{{diff or empty}}
```

## Retrieved Chunks (≤ 15 total; each with a 5–10 line header)
--- CHUNK 1 ---
header: {{file#symbol — purpose, invariants, deps}}
```ts
{{snippet}}
```

<!-- If more context is needed, the model must output a ScopeChange block and stop. -->
