export * as RouteUse from "./route.js"

import { Agent } from "@opencode/schema/agent"
import { Effect } from "effect"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * The first request of a Session that runs the build agent is routed to the plan agent when the model is confident it
 * is large, ambiguous or architectural. Later requests and Sessions on any other agent are left alone.
 */

export const QUESTION = {
  type: "choice",
  instructions:
    "Should a coding agent start this request by planning with the user before changing code, or just build it?",
  criteria: {
    build: "The request is clear and small or medium: start working on it directly.",
    plan: "The request is large, ambiguous or architectural: agree on a plan first.",
  },
} as const

export const routes = (probabilities: Readonly<Record<string, number>> | undefined, threshold: number) =>
  (probabilities?.plan ?? 0) >= threshold

export const Use = DecisionUse.define({
  id: "routing",
  threshold: 0.9,
  setup: (ctx, kit) =>
    ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.prompt.text.trim().length === 0) return
        const messages = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => []))
        if (messages.some((message) => message.type === "user")) return
        const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => undefined))
        if (session?.agent !== undefined && session.agent !== "build") return
        const { probabilities, result } = yield* DecisionBlocks.choose(
          kit,
          { user_request: event.prompt.text.slice(0, 4_000) },
          QUESTION,
          settings.threshold,
        )
        const plan = routes(probabilities, settings.threshold)
        if (plan)
          yield* ctx.session.switchAgent({ sessionID: event.sessionID, agent: Agent.ID.make("plan") }).pipe(Effect.ignore)
        yield* kit.log({ agent: plan ? "plan" : "unchanged", p: probabilities?.plan, ms: result.ms, ...DecisionText.outcome(result) })
      }),
    ),
})
