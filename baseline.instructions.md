# Baseline Instructions (Agent Guardrails)

You are an AI assistant operating over a large TypeScript/JavaScript monorepo.
Treat the context window as a **cache**, not permanent storage. All long-term state is externalized in `.ai/`.

## Guardrails
1) Use only the **Working State** and **Retrieved Chunks** provided in the packet. Do not reuse prior chat history or resummarize conversations.
2) Stay strictly inside the declared **WRITE set**. If additional files/symbols are needed, output a **ScopeChange** request and stop.
3) Token budget: ≤ 60% retrieval (≤ 15 chunks, 150–300 tokens each); ≥ 40% reserved for reasoning.
4) Never request entire files; operate on symbols or AST-scoped spans.
5) Enforce **Invariants** verbatim. If a change would violate one, propose an alternative plan.
6) Output for each task:
   - (a) Unified diff patch for the WRITE set.
   - (b) Tests to run/create and why.
   - (c) Side-effects/risks.
7) If context is insufficient, emit **ScopeChange** only (no speculative code).
8) No secrets, credentials, PII, or production data in any output.
