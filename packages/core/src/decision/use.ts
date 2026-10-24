export * as DecisionUse from "./use.js"

import type { EvaluationInput, EvaluationQuestions } from "@opencode/ai/experimental"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Effect, Schema, Scope } from "effect"
import type { Decision } from "../decision.js"
import type { PluginInternal } from "../plugin/internal.js"

/**
 * One use of the decision model. Each use is its own module: it registers its hooks in `setup` and reaches the model,
 * the shared Session state and its own settings only through the kit. Uses never import each other; what one use
 * finds, another reads from the Session state.
 */
export interface Use {
  readonly id: string
  /** Short name shown in the UI, e.g. "Approve routine actions". */
  readonly title: string
  /** One line on what the use does, shown next to the title. */
  readonly description: string
  /** Default probability threshold; `decision.uses.<id>.threshold` overrides it. */
  readonly threshold: number
  readonly setup: (ctx: Context, kit: Kit) => Effect.Effect<void, never, PluginInternal.Requirements | Scope.Scope>
}

export interface Settings {
  readonly threshold: number
  readonly options: Readonly<Record<string, Schema.Json>>
}

export interface Kit {
  /** This use's settings, read at call time; undefined while the use or the decision model is not configured. */
  readonly settings: () => Settings | undefined
  /** Asks the configured decision model, recording this use as the purpose. Never fails. */
  readonly ask: (state: EvaluationInput, questions: EvaluationQuestions) => Effect.Effect<Decision.Result>
  readonly session: Decision.Interface["session"]
  /** Tokens the decision model accepts per request; trim what you send to fit (see `DecisionText.clip`). */
  readonly limit: () => number
  readonly log: (fields: Record<string, unknown>) => Effect.Effect<void>
}

export const define = (use: Use) => use
