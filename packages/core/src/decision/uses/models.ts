export * as ModelsUse from "./models.js"

import { Effect } from "effect"
import { Model } from "../../model.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Each new request is routed to a small or a large model, set in `options.small` and `options.large` as
 * `provider/model`. Without both options the use does nothing. It switches the Session's model for the request.
 */

export const QUESTION = {
  instructions:
    "Pick the cheapest model that will do this coding request well. Judge by how much reasoning the work needs, not by how long the request is or how many files it touches: repetitive edits across many files are small-model work; a short request about a subtle bug, concurrency, security or algorithm correctness needs the large model.",
  criteria: {
    small: "Mechanical or well-defined work: renames, version bumps, typo fixes, moving data, simple tests, simple explanations.",
    large: "Needs real reasoning: debugging unclear causes, concurrency, security review, algorithm design, architecture.",
  },
} as const

const REF = /^[^/#]+\/[^#]+(#[^#]+)?$/

export const Use = DecisionUse.define({
  id: "models",
  title: "Pick small or large model",
  description: "Send mechanical requests to a small model and hard ones to a large one",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const small = settings?.options.small
        const large = settings?.options.large
        if (!settings || typeof small !== "string" || typeof large !== "string") return
        if (event.prompt.text.trim().length === 0) return
        const { choice, probabilities, result } = yield* DecisionBlocks.choose(
          kit,
          { user_request: DecisionText.clip(event.prompt.text, DecisionText.budget(kit.limit(), 0.5)) },
          QUESTION,
          settings.threshold,
        )
        const target = choice === "small" ? small : choice === "large" ? large : undefined
        // A malformed option is ignored rather than failing the prompt.
        const model = target !== undefined && REF.test(target) ? Model.Ref.parse(target) : undefined
        if (model) yield* ctx.session.switchModel({ sessionID: event.sessionID, model }).pipe(Effect.ignore)
        yield* kit.log({ choice: choice ?? "unsure", large: probabilities?.large, model: target ?? "unchanged", ms: result.ms, ...DecisionText.outcome(result) })
      }),
    ),
})
