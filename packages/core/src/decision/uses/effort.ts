export * as EffortUse from "./effort.js"

import { Effect } from "effect"
import { Model } from "../../model.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Each new user request is scored trivial, normal or hard. A trivial request runs on the model's lowest reasoning
 * variant, a hard one on its highest, and a normal one on the variant the Session had before. It never turns
 * reasoning off, and it does nothing for a model without variants.
 */

export const QUESTION = {
  type: "score",
  instructions: "How much reasoning does a coding agent need to handle this request well?",
  criteria: [
    "Trivial: a quick answer, lookup, rename or one obvious edit",
    "Normal: an ordinary bug fix or small feature",
    "Hard: subtle bugs, design across several files, concurrency, security, performance or anything needing careful thought",
  ],
} as const

const OFF = new Set(["none", "off", "disabled", "minimal"])

/**
 * The variant for a score from 0 (trivial) to 2 (hard), from the model's variants in catalogue order; `undefined`
 * keeps the base variant. A score is only acted on when it is within `margin` of a level.
 */
export function pick<V extends string>(variants: ReadonlyArray<V>, base: V | undefined, score: number, margin = 0.35) {
  const graded = variants.filter((id) => !OFF.has(id))
  const level = Math.round(score)
  if (graded.length < 2 || Math.abs(score - level) > margin) return base
  if (level <= 0) return graded[0]
  if (level >= 2) return graded.at(-1)
  return base
}

export const Use = DecisionUse.define({
  id: "effort",
  threshold: 0.35,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const models = yield* Model.Service
      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          if (!settings || event.prompt.text.trim().length === 0) return
          const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => undefined))
          const state = kit.session(event.sessionID)
          const fallback = yield* models.default()
          const base =
            state.baseModel ?? session?.model ?? (fallback && { providerID: fallback.providerID, id: fallback.id })
          if (!base) return yield* kit.log({ skipped: "no Session or default model" })
          const info = yield* models.get(base.providerID, base.id)
          const variants = info?.variants.map((variant) => variant.id) ?? []
          if (variants.length < 2) return yield* kit.log({ skipped: "model has no reasoning variants", model: base.id })
          const { score, result } = yield* DecisionBlocks.rate(kit, { user_request: event.prompt.text.slice(0, 4_000) }, QUESTION)
          const variant = score === undefined ? base.variant : pick(variants, base.variant, score, settings.threshold)
          state.baseModel = base
          if (variant !== session?.model?.variant)
            yield* ctx.session
              .switchModel({ sessionID: event.sessionID, model: { ...base, variant } })
              .pipe(Effect.ignore)
          yield* kit.log({ score, variant: variant ?? "default", from: session?.model?.variant ?? "default", ms: result.ms, ...DecisionText.outcome(result) })
        }),
      )
    }),
})
