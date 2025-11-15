Here you go — one big markdown doc you can drop into a repo and wire up from there.

---

````markdown
# Governed Workflows for Copilot (GPT‑5 / GPT‑5‑mini)

This document describes a way to **force all non‑trivial code changes through a governed workflow**, so that both GPT‑5 and GPT‑5‑mini:

- use your **graph + codemod + artifact** system as the *only* way to act, and  
- can’t “just refactor” based on empty tests or missing golden coverage.

The design assumes:

- VS Code + GitHub Copilot (GPT‑5, GPT‑5‑mini)  
- A local graph / “recipes” layer (intent → recipe → codemod steps)  
- Codemods that emit **exit artifacts** and have **entry requirements**  
- No extra LLMs, no external gen‑AI, everything local except Copilot itself

---

## High‑level design

There are four pieces:

1. **Graph + codemods (existing)**  
   - Graph: maps “intent” → “recipe” → ordered codemod steps.  
   - Each step has:
     - `requiredArtifacts` and `exitArtifacts`  
     - a codemod implementation you can invoke locally  
   - Codemods can run in `dryRun` or `apply` mode and emit artifacts.

2. **Governance engine (new)**  
   - Reads artifacts, repo risk profile, and recipe metadata.  
   - Decides:
     - `analysis-only`: no code changes allowed  
     - `propose-only`: only diffs / suggestions, no auto‑apply  
     - `auto-apply`: safe zone where apply is allowed  
   - Enforces rules like “no golden tests ⇒ never apply”.

3. **Governed runtime (new)**  
   - Owns **workflow sessions**, uses your graph + codemods, and applies governance.  
   - Offers three phases:
     - `analyze`: map intent → candidate recipes, no changes  
     - `plan`: choose recipe, expose steps and requirements  
     - `execute`: run selected steps in `dryRun`/`apply` under governance

4. **Copilot language model tool (new)**  
   - Single tool: `governed_workflow`  
   - This is the **only door** GPT‑5 / mini use for multi‑step work.  
   - Direct file edits / raw test runs are disabled or strongly discouraged.

Everything below is a concrete TypeScript skeleton for a VS Code extension implementing this.

---

## 0. Directory layout

You can aim for something like:

```text
.vscode/
src/
  domain.ts
  graphClient.ts
  codemodRunner.ts
  artifactStore.ts
  governance.ts
  runtime.ts
  extension.ts
package.json
tsconfig.json
````

You’ll plug your existing graph + codemod logic into `graphClient.ts` and `codemodRunner.ts`.

---

## 1. Domain model (`src/domain.ts`)

```ts
// src/domain.ts

export type Phase = "analyze" | "plan" | "execute";
export type Mode = "dryRun" | "apply";

export type GovernanceMode =
  | "analysis-only"
  | "propose-only"
  | "auto-apply";

export interface Artifact {
  id: string;              // stable ID (can be hash, path, etc.)
  kind: string;            // e.g. "route-map:payroll", "golden-test:ui-X"
  path?: string;           // where it lives on disk (if applicable)
  metadata?: any;          // small JSON blob
}

export interface CodemodStep {
  id: string;
  name: string;
  description: string;

  codemodId: string;       // identifier for your codemod runner

  requiredArtifacts: string[];  // artifact kinds/IDs that must exist first
  optionalArtifacts?: string[];

  exitArtifactKinds: string[];  // what this step is expected to emit

  riskLevel?: "low" | "medium" | "high";
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: CodemodStep[];
}

export interface WorkflowSession {
  id: string;
  intent: string;
  createdAt: number;
  lastUpdatedAt: number;

  selectedRecipe?: Recipe;

  completedSteps: string[]; // codemod step IDs
  blockedSteps: string[];   // codemod step IDs
}

export interface RepoState {
  // Very coarse‑grained knobs; you can refine this to per‑package / per‑route.
  riskProfile: "high" | "medium" | "low";
  hasTestFramework: boolean;
  hasNonEmptyTests: boolean;
  coveragePercent?: number;

  // Example: zones you explicitly bless as safer for auto‑apply
  safeZones?: string[]; // package names, tags, etc.
}
```

---

## 2. Graph adapter (`src/graphClient.ts`)

This is where you plug your existing graph RAG / recipe store.

```ts
// src/graphClient.ts
import { Recipe } from "./domain";

export class GraphClient {
  constructor(private workspaceRoot: string) {}

  /**
   * Given an intent string, return candidate recipes.
   * Implement this by calling into your existing graph / index.
   */
  async findRecipes(intent: string): Promise<Recipe[]> {
    // TODO: integrate your graph RAG here
    // For now, throw so it's obvious you need to fill this in.
    throw new Error("GraphClient.findRecipes not implemented");
  }

  async getRecipeById(id: string): Promise<Recipe | undefined> {
    // TODO: look up recipe by ID in your graph / config
    throw new Error("GraphClient.getRecipeById not implemented");
  }
}
```

---

## 3. Codemod runner (`src/codemodRunner.ts`)

This wraps your codemod system (scripts, CLIs, etc.). It gets a `CodemodStep` and a `Mode` and returns artifacts + logs.

```ts
// src/codemodRunner.ts
import { Artifact, CodemodStep, Mode } from "./domain";
import * as child_process from "child_process";
import * as path from "path";

export interface CodemodRunResult {
  success: boolean;
  diffPath?: string;        // where a patch file was written (for dry-run)
  applied?: boolean;        // true if changes were applied
  emittedArtifacts: Artifact[];
  logs: string;             // stdout + stderr
}

/**
 * Adapt this to your actual codemod runner.
 * The only requirement: you can map (codemodId, mode) -> CodemodRunResult.
 */
export class CodemodRunner {
  constructor(private workspaceRoot: string) {}

  async run(step: CodemodStep, mode: Mode): Promise<CodemodRunResult> {
    // Example: call a local Node script `tools/runCodemod.js`
    const cmd = "node";
    const script = path.join(
      this.workspaceRoot,
      "tools",
      "runCodemod.js"
    );

    const args = [
      script,
      "--codemod-id",
      step.codemodId,
      "--mode",
      mode,
      "--workspace",
      this.workspaceRoot,
    ];

    return new Promise<CodemodRunResult>((resolve) => {
      const proc = child_process.spawn(cmd, args, {
        cwd: this.workspaceRoot,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));

      proc.on("close", (code) => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // If not JSON, treat stdout as logs only.
        }

        const result: CodemodRunResult = {
          success: code === 0,
          diffPath: parsed?.diffPath,
          applied: parsed?.applied ?? false,
          emittedArtifacts: parsed?.artifacts ?? [],
          logs: stdout + (stderr ? "\n" + stderr : ""),
        };

        resolve(result);
      });
    });
  }
}
```

You’ll probably want your codemod driver to print a JSON payload like:

```json
{
  "diffPath": "artifacts/diffs/update-copy.patch",
  "applied": false,
  "artifacts": [
    {
      "id": "route-map:payroll-main",
      "kind": "route-map:payroll-main",
      "path": "artifacts/routes/payroll-main.json",
      "metadata": { "routes": ["/payroll/main", "/payroll/legacy"] }
    }
  ]
}
```

---

## 4. Artifact store (`src/artifactStore.ts`)

In‑memory per‑session store for artifacts; you can swap this for a disk‑backed version later.

```ts
// src/artifactStore.ts
import { Artifact } from "./domain";

export class ArtifactStore {
  private artifactsByWorkflow = new Map<string, Artifact[]>();

  add(workflowId: string, artifacts: Artifact[]) {
    if (!artifacts.length) return;
    const existing = this.artifactsByWorkflow.get(workflowId) ?? [];
    this.artifactsByWorkflow.set(workflowId, existing.concat(artifacts));
  }

  getAll(workflowId: string): Artifact[] {
    return this.artifactsByWorkflow.get(workflowId) ?? [];
  }

  hasKinds(workflowId: string, kinds: string[]): boolean {
    const artifacts = this.getAll(workflowId);
    const present = new Set(artifacts.map((a) => a.kind));
    return kinds.every((k) => present.has(k));
  }
}
```

---

## 5. Governance engine (`src/governance.ts`)

This is where you encode the “there is no trivial edit” reality.

```ts
// src/governance.ts
import {
  CodemodStep,
  GovernanceMode,
  Recipe,
  RepoState,
  WorkflowSession,
} from "./domain";
import { ArtifactStore } from "./artifactStore";

export interface GovernanceConfig {
  // Turn the screws as hard as you need.
  minCoverageForPropose: number; // e.g. 1% if you just want "any" coverage
  minCoverageForApply: number;   // e.g. 70%
  requireGoldenForApply: boolean;
}

export class GovernanceEngine {
  constructor(
    private artifacts: ArtifactStore,
    private cfg: GovernanceConfig
  ) {}

  /**
   * Decide the overall governance mode for this workflow + recipe,
   * based on coarse repo risk and coverage.
   */
  overallMode(recipe: Recipe, repo: RepoState): GovernanceMode {
    // In a swampy 6+ year old codebase, default everything to analysis-only
    // and selectively relax.
    if (repo.riskProfile === "high") {
      return "analysis-only";
    }

    if (!repo.hasTestFramework || !repo.hasNonEmptyTests) {
      return "analysis-only";
    }

    const cov = repo.coveragePercent ?? 0;

    if (cov < this.cfg.minCoverageForPropose) {
      return "analysis-only";
    }

    if (cov < this.cfg.minCoverageForApply) {
      return "propose-only";
    }

    // Only allow auto-apply in explicitly blessed zones.
    if (
      repo.safeZones &&
      recipe.tags.some((tag) => repo.safeZones!.includes(tag))
    ) {
      return "auto-apply";
    }

    return "propose-only";
  }

  /**
   * Check whether a specific codemod step is allowed to run in this workflow.
   * This is where you enforce artifact preconditions (route maps, golden tests, etc.).
   */
  canRunStep(
    workflow: WorkflowSession,
    step: CodemodStep
  ): { allowed: boolean; reason?: string } {
    const wfId = workflow.id;

    // First, enforce codemod's own requiredArtifacts.
    if (
      step.requiredArtifacts.length > 0 &&
      !this.artifacts.hasKinds(wfId, step.requiredArtifacts)
    ) {
      return {
        allowed: false,
        reason: `Missing required artifacts: [${step.requiredArtifacts.join(
          ", "
        )}]`,
      };
    }

    // Example: high-risk steps require a "golden" artifact, if configured.
    if (this.cfg.requireGoldenForApply && step.riskLevel === "high") {
      const goldenKinds = step.exitArtifactKinds.filter((k) =>
        k.startsWith("golden:")
      );

      if (
        goldenKinds.length > 0 &&
        !this.artifacts.hasKinds(wfId, goldenKinds)
      ) {
        return {
          allowed: false,
          reason:
            "High-risk step without matching golden artifacts; discovery/guardrail steps must run first.",
        };
      }
    }

    return { allowed: true };
  }
}
```

You’ll also need a way to obtain a coarse `RepoState` for the current workspace (risk profile, coverage, etc.). You can wire that in via config or by running your existing analysis tools.

---

## 6. Governed runtime (`src/runtime.ts`)

This is the central orchestrator the LM tool calls into.

```ts
// src/runtime.ts
import {
  Artifact,
  Mode,
  Phase,
  Recipe,
  RepoState,
  WorkflowSession,
} from "./domain";
import { GraphClient } from "./graphClient";
import { CodemodRunner } from "./codemodRunner";
import { ArtifactStore } from "./artifactStore";
import { GovernanceEngine, GovernanceConfig } from "./governance";
import * as crypto from "crypto";

export interface AnalyzeResult {
  workflowId: string;
  intent: string;
  recipes: Array<{
    id: string;
    name: string;
    description: string;
    stepCount: number;
    tags: string[];
  }>;
}

export interface PlanResult {
  workflowId: string;
  recipe: Recipe;
  suggestedStepOrder: string[];
  governanceMode: string;
  notes: string;
}

export interface ExecuteResult {
  workflowId: string;
  recipeId: string;
  mode: Mode;
  governanceMode: string;
  completedSteps: string[];
  blockedSteps: Array<{ stepId: string; reason: string }>;
  emittedArtifacts: Artifact[];
  logs: string;
}

export class GovernedRuntime {
  private workflows = new Map<string, WorkflowSession>();
  private artifacts = new ArtifactStore();
  private governance: GovernanceEngine;

  private graph: GraphClient;
  private codemods: CodemodRunner;

  constructor(
    private workspaceRoot: string,
    cfg: GovernanceConfig,
    private repoStateProvider: () => Promise<RepoState>
  ) {
    this.graph = new GraphClient(workspaceRoot);
    this.codemods = new CodemodRunner(workspaceRoot);
    this.governance = new GovernanceEngine(this.artifacts, cfg);
  }

  private newWorkflow(intent: string): WorkflowSession {
    const id = crypto.randomUUID();
    const now = Date.now();
    const wf: WorkflowSession = {
      id,
      intent,
      createdAt: now,
      lastUpdatedAt: now,
      completedSteps: [],
      blockedSteps: [],
    };
    this.workflows.set(id, wf);
    return wf;
  }

  private getWorkflow(id: string): WorkflowSession {
    const wf = this.workflows.get(id);
    if (!wf) throw new Error(`Unknown workflowId: ${id}`);
    return wf;
  }

  async analyze(intent: string): Promise<AnalyzeResult> {
    const wf = this.newWorkflow(intent);
    const recipes = await this.graph.findRecipes(intent);

    return {
      workflowId: wf.id,
      intent,
      recipes: recipes.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        stepCount: r.steps.length,
        tags: r.tags,
      })),
    };
  }

  async plan(workflowId: string, recipeId: string): Promise<PlanResult> {
    const wf = this.getWorkflow(workflowId);
    const recipe =
      wf.selectedRecipe ??
      (await this.graph.getRecipeById(recipeId));
    if (!recipe) throw new Error(`Recipe not found: ${recipeId}`);

    wf.selectedRecipe = recipe;
    wf.lastUpdatedAt = Date.now();

    const repoState = await this.repoStateProvider();
    const govMode = this.governance.overallMode(recipe, repoState);

    const suggestedStepOrder = recipe.steps.map((s) => s.id);

    return {
      workflowId,
      recipe,
      suggestedStepOrder,
      governanceMode: govMode,
      notes:
        "All changes must go through this plan. The LLM should not edit files directly.",
    };
  }

  async execute(
    workflowId: string,
    recipeId: string,
    stepIds: string[],
    mode: Mode
  ): Promise<ExecuteResult> {
    const wf = this.getWorkflow(workflowId);
    const recipe =
      wf.selectedRecipe ??
      (await this.graph.getRecipeById(recipeId));
    if (!recipe) throw new Error(`Recipe not found: ${recipeId}`);

    wf.selectedRecipe = recipe;

    const repoState = await this.repoStateProvider();
    const overallMode = this.governance.overallMode(recipe, repoState);

    // Never let the model escalate beyond what governance allows.
    const effectiveMode: Mode =
      overallMode === "auto-apply" ? mode : "dryRun";

    const completed: string[] = [];
    const blocked: Array<{ stepId: string; reason: string }> = [];
    const emitted: Artifact[] = [];
    const logLines: string[] = [];

    for (const stepId of stepIds) {
      const step = recipe.steps.find((s) => s.id === stepId);
      if (!step) {
        blocked.push({ stepId, reason: "Unknown step" });
        continue;
      }

      const can = this.governance.canRunStep(wf, step);
      if (!can.allowed) {
        blocked.push({ stepId, reason: can.reason ?? "Blocked" });
        continue;
      }

      const result = await this.codemods.run(step, effectiveMode);

      logLines.push(
        [
          `Step ${step.id} (${step.name})`,
          `Mode: ${effectiveMode}`,
          `Success: ${result.success}`,
        ].join(" | ")
      );

      if (!result.success) {
        blocked.push({
          stepId,
          reason: "Codemod runner reported failure",
        });
        continue;
      }

      completed.push(stepId);
      emitted.push(...result.emittedArtifacts);
      this.artifacts.add(workflowId, result.emittedArtifacts);
    }

    wf.completedSteps.push(...completed);
    wf.blockedSteps.push(...blocked.map((b) => b.stepId));
    wf.lastUpdatedAt = Date.now();

    return {
      workflowId,
      recipeId: recipe.id,
      mode: effectiveMode,
      governanceMode: overallMode,
      completedSteps: completed,
      blockedSteps: blocked,
      emittedArtifacts: emitted,
      logs: logLines.join("\n"),
    };
  }
}
```

You’ll need a simple `repoStateProvider` that inspects your repo (or reads config) and returns a coarse `RepoState`.

---

## 7. VS Code extension entry (`src/extension.ts`)

This registers the LM tool `governed_workflow` and routes calls into the runtime.

````ts
// src/extension.ts
import * as vscode from "vscode";
import { GovernedRuntime } from "./runtime";
import { Mode, Phase, RepoState } from "./domain";

interface GovernedWorkflowInput {
  intent: string;
  phase: Phase;
  workflowId?: string;
  recipeId?: string;
  approvedStepIds?: string[];
  mode?: Mode;
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    console.warn(
      "governed_workflow tool disabled: no workspace open."
    );
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const repoStateProvider = async (): Promise<RepoState> => {
    // TODO: wire this into real analysis.
    // For a first pass, hard-code the reality: this repo is a swamp.
    return {
      riskProfile: "high",
      hasTestFramework: true,
      hasNonEmptyTests: false,
      coveragePercent: 0,
      safeZones: [],
    };
  };

  const runtime = new GovernedRuntime(
    workspaceRoot,
    {
      minCoverageForPropose: 1,
      minCoverageForApply: 70,
      requireGoldenForApply: true,
    },
    repoStateProvider
  );

  const tool: vscode.LanguageModelTool<GovernedWorkflowInput> = {
    async prepareInvocation(options, _token) {
      const { intent, phase } = options.input;

      const md = new vscode.MarkdownString(
        [
          `**Governed workflow**`,
          "",
          `Phase: \`${phase}\``,
          "",
          "Intent:",
          "",
          "```text",
          intent,
          "```",
          "",
          "This tool runs your local graph/codemod governance pipeline. " +
            "No changes are ever applied directly by the language model.",
        ].join("\n")
      );
      md.isTrusted = true;

      return {
        invocationMessage: `Governed workflow (${phase})`,
        confirmationMessages: {
          title: "Run governed workflow",
          message: md,
        },
      };
    },

    async invoke(options, _token) {
      const { intent, phase, workflowId, recipeId, approvedStepIds } =
        options.input;
      const mode: Mode = options.input.mode ?? "dryRun";

      const parts: vscode.LanguageModelChatMessagePart[] = [];

      try {
        if (phase === "analyze") {
          const result = await runtime.analyze(intent);
          const summary = [
            `**Governed workflow – analyze**`,
            "",
            `Workflow ID: \`${result.workflowId}\``,
            `Intent: \`${result.intent}\``,
            "",
            "Candidate recipes:",
            "",
            ...result.recipes.map(
              (r) =>
                `- \`${r.id}\`: **${r.name}** (${r.stepCount} steps) – ${r.description}`
            ),
          ].join("\n");

          parts.push(new vscode.LanguageModelTextPart(summary));
          parts.push(
            new vscode.LanguageModelTextPart(
              "```json\n" +
                JSON.stringify(
                  { kind: "analyzeResult", ...result },
                  null,
                  2
                ) +
                "\n```"
            )
          );
        } else if (phase === "plan") {
          if (!workflowId || !recipeId) {
            throw new Error(
              "phase=plan requires workflowId and recipeId"
            );
          }

          const result = await runtime.plan(workflowId, recipeId);
          const summary = [
            `**Governed workflow – plan**`,
            "",
            `Workflow ID: \`${result.workflowId}\``,
            `Recipe: \`${result.recipe.id}\` – **${result.recipe.name}**`,
            "",
            `Governance mode: \`${result.governanceMode}\``,
            "",
            "Steps:",
            "",
            ...result.recipe.steps.map(
              (s, i) =>
                `${i + 1}. \`${s.id}\` – **${s.name}** (${s.description})`
            ),
          ].join("\n");

          parts.push(new vscode.LanguageModelTextPart(summary));
          parts.push(
            new vscode.LanguageModelTextPart(
              "```json\n" +
                JSON.stringify(
                  { kind: "planResult", ...result },
                  null,
                  2
                ) +
                "\n```"
            )
          );
        } else if (phase === "execute") {
          if (
            !workflowId ||
            !recipeId ||
            !approvedStepIds ||
            approvedStepIds.length === 0
          ) {
            throw new Error(
              "phase=execute requires workflowId, recipeId, and approvedStepIds"
            );
          }

          const result = await runtime.execute(
            workflowId,
            recipeId,
            approvedStepIds,
            mode
          );

          const summary = [
            `**Governed workflow – execute (${result.mode})**`,
            "",
            `Workflow ID: \`${result.workflowId}\``,
            `Recipe: \`${result.recipeId}\``,
            "",
            `Governance mode: \`${result.governanceMode}\``,
            "",
            `Completed steps: ${
              result.completedSteps.length
                ? result.completedSteps.join(", ")
                : "(none)"
            }`,
            `Blocked steps: ${
              result.blockedSteps.length
                ? result.blockedSteps
                    .map((b) => `${b.stepId} (${b.reason})`)
                    .join("; ")
                : "(none)"
            }`,
            "",
            `Artifacts emitted: ${
              result.emittedArtifacts.length
                ? result.emittedArtifacts
                    .map((a) => `${a.kind}:${a.id}`)
                    .join(", ")
                : "(none)"
            }`,
          ].join("\n");

          parts.push(new vscode.LanguageModelTextPart(summary));
          parts.push(
            new vscode.LanguageModelTextPart(
              "```json\n" +
                JSON.stringify(
                  { kind: "executeResult", ...result },
                  null,
                  2
                ) +
                "\n```"
            )
          );
        } else {
          throw new Error(`Unknown phase: ${phase}`);
        }
      } catch (err: any) {
        parts.push(
          new vscode.LanguageModelTextPart(
            [
              "**Governed workflow error**",
              "",
              String(err?.message ?? err),
            ].join("\n")
          )
        );
      }

      return new vscode.LanguageModelToolResult(parts);
    },
  };

  context.subscriptions.push(
    vscode.lm.registerTool("governed_workflow", tool)
  );
}

export function deactivate() {}
````

Finally, in `package.json`, expose the tool:

```json
{
  "contributes": {
    "languageModelTools": [
      {
        "name": "governed_workflow",
        "displayName": "Governed Workflow Runner",
        "description": "Runs graph-based codemod recipes under strict governance.",
        "inputSchema": {
          "type": "object",
          "required": ["intent", "phase"],
          "properties": {
            "intent": { "type": "string" },
            "phase": {
              "type": "string",
              "enum": ["analyze", "plan", "execute"]
            },
            "workflowId": { "type": "string" },
            "recipeId": { "type": "string" },
            "approvedStepIds": {
              "type": "array",
              "items": { "type": "string" }
            },
            "mode": {
              "type": "string",
              "enum": ["dryRun", "apply"]
            }
          }
        }
      }
    ]
  }
}
```

---

## How GPT‑5 / GPT‑5‑mini fit into this

Once this is wired up and the extension is installed, your instructions to Copilot look like:

* For any non‑read‑only task, call `governed_workflow`:

  * `phase="analyze"` to discover recipes
  * `phase="plan"` to inspect steps and governance mode
  * `phase="execute"` with `mode="dryRun"` and a list of approved steps
* Never directly refactor files or run tests for multi‑step work; always go through the governed tool.

Mini will still be overeager, full GPT‑5 will still be smart — but the only actions either of them can take are:

* choose recipes and steps,
* call the governed tool,
* explain what it did and why some steps were blocked.

All the dangerous stuff lives behind the extension and the governance rules you encode here.

```
::contentReference[oaicite:0]{index=0}
```
