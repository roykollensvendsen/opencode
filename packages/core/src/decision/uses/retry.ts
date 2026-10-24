export * as RetryUse from "./retry.js"

import { Effect } from "effect"
import { Decision } from "../../decision.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * A model error OpenCode would retry is not retried when the model is confident retrying will not help. It never
 * starts a retry OpenCode's own policy declined.
 */

export const QUESTION = {
  type: "boolean",
  instructions:
    "A request to a language model API failed with the error below. Will sending the same request again soon succeed?",
  criteria: {
    true: "Temporary: rate limits, overload, timeouts, network or server errors.",
    false:
      "Permanent until something changes: invalid or missing key, no credit, unknown model, request too large, content rejected.",
  },
} as const

/** Stop when the probability that a retry succeeds is at or below one minus the threshold. */
export const stops = (willSucceed: number | undefined, threshold: number) =>
  willSucceed !== undefined && willSucceed <= 1 - threshold

export const Use = DecisionUse.define({
  id: "retry",
  threshold: 0.9,
  setup: (ctx, kit) =>
    ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || !event.decision.retry) return
        const result = yield* kit.ask(
          {
            type: event.error.type,
            status: event.error.status ?? null,
            message: event.error.message,
            body: event.error.response?.body.slice(0, 2_000) ?? null,
          },
          { will_succeed: QUESTION },
        )
        const p = Decision.probability(result, "will_succeed")
        const stop = stops(p, settings.threshold)
        if (stop) event.decision = { retry: false }
        yield* kit.log({ attempt: event.attempt, status: event.error.status, stop, p, ms: result.ms, ...DecisionText.outcome(result) })
      }),
    ),
})
