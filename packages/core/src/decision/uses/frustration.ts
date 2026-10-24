export * as FrustrationUse from "./frustration.js"

import { SystemPart } from "@opencode/ai"
import { Effect } from "effect"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Each new user message is judged for frustration with the agent. While the current request is from a frustrated
 * user, the agent gets a short system note to slow down, check its work and keep the user informed.
 */

export const QUESTION = {
  instructions: "Is the user frustrated with the coding agent in this message?",
  criteria: {
    true: "Annoyed, impatient or fed up with the agent's work, including sarcasm, resignation or polite but strained repetition of failures.",
    false:
      "Neutral, pleased, or simply brief and direct; venting about the code itself rather than the agent does not count.",
  },
} as const

export const NOTE =
  "The user seems frustrated with how this is going. Slow down: re-read their request, check your work before claiming it is done, say plainly what you changed and what is still open, and ask when unsure instead of guessing."

export const Use = DecisionUse.define({
  id: "frustration",
  title: "Notice frustration",
  description: "When the user sounds frustrated, ask the agent to slow down and check its work",
  threshold: 0.7,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          if (!settings || event.prompt.text.trim().length === 0) return
          const { p, result } = yield* DecisionBlocks.gate(
            kit,
            { message: DecisionText.clip(event.prompt.text, DecisionText.budget(kit.limit(), 0.5)) },
            QUESTION,
          )
          const frustrated = p !== undefined && p >= settings.threshold
          // The prompt hook runs before the request becomes the Session's current one; keep it for the next steps.
          kit.session(event.sessionID).frustrated = frustrated
          yield* kit.log({ frustrated, p, ms: result.ms, ...DecisionText.outcome(result) })
        }),
      )
      yield* ctx.session.hook("context", (event) =>
        Effect.sync(() => {
          if (!kit.settings() || kit.session(event.sessionID).frustrated !== true) return
          event.system = [...event.system, SystemPart.make(NOTE)]
        }),
      )
    }),
})
