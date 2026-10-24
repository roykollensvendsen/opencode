export * as FallbackUse from "./fallback.js"

import { Effect } from "effect"
import { Model } from "../../model.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * When a model call fails and OpenCode will not retry it, the model picks the best other available model for the same
 * request, and the Session switches to it and retries once. Only models listed in `options.models` (as
 * `provider/model`) are candidates, so it never moves a Session to a model the user did not allow.
 */

export const QUESTION = (failed: string, candidates: ReadonlyArray<{ readonly ref: string; readonly note: string }>) => ({
  instructions: `A coding agent's model call failed (${failed}) with the error below. Which available model is the best fallback to retry the same request on? Pick one that avoids the cause of the error and keeps tool calling.`,
  criteria: Object.fromEntries(candidates.map((candidate) => [candidate.ref, candidate.note])),
})

const REF = /^[^/#]+\/[^#]+(#[^#]+)?$/

export const Use = DecisionUse.define({
  id: "fallback",
  title: "Fall back to another model",
  description: "When a model call fails for good, retry once on the best allowed alternative",
  threshold: 0.6,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const models = yield* Model.Service
      const tried = new Set<string>()
      yield* ctx.session.hook("retry", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const allowed = settings?.options.models
          if (!settings || event.decision.retry || !Array.isArray(allowed) || tried.has(event.sessionID)) return
          const failed = `${event.model.providerID}/${event.model.id}`
          const candidates = yield* Effect.forEach(
            allowed.filter((ref): ref is string => typeof ref === "string" && REF.test(ref) && ref !== failed),
            (ref) =>
              Effect.gen(function* () {
                const parsed = Model.Ref.parse(ref)
                const info = yield* models.get(parsed.providerID, parsed.id)
                return info ? [{ ref, note: `${info.name ?? info.id} on ${parsed.providerID}` }] : []
              }),
          ).pipe(Effect.map((lists) => lists.flat()))
          if (candidates.length === 0) return
          const { choice, result } = yield* DecisionBlocks.choose(
            kit,
            { error: DecisionText.clip(`${event.error.status ?? ""} ${event.error.message}`, 2_000), failed },
            QUESTION(failed, candidates),
            settings.threshold,
          )
          yield* kit.log({ failed, choice: choice ?? "none", ms: result.ms, ...DecisionText.outcome(result) })
          if (!choice) return
          tried.add(event.sessionID)
          yield* ctx.session.switchModel({ sessionID: event.sessionID, model: Model.Ref.parse(choice) }).pipe(Effect.ignore)
          event.decision = { retry: true, delay: 0 }
        }),
      )
    }),
})
