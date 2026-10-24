export * as CompletionUse from "./completion.js"

import { Effect, Stream } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionTurn } from "../turn.js"
import { DecisionUse } from "../use.js"

/**
 * When a Session goes idle, the turn is judged done, partly done or blocked. A turn judged only partly done gets one
 * note per request; with `options.resume` the agent continues. Done and blocked turns are left alone.
 */

export const QUESTION = {
  instructions:
    "A coding agent stopped working on the user's request with the final message below. Judge from the request, the message and the tool calls whether the request is fully done, only partly done, or blocked waiting for the user or something outside the agent's control.",
  criteria: {
    done: "Everything the request asked for is done or answered.",
    partial: "Some of the request is done but parts are missing or still failing, whatever the tone of the message.",
    blocked: "The agent cannot continue without the user's input, a decision, access or an external fix.",
  },
} as const

export const Use = DecisionUse.define({
  id: "completion",
  title: "Check the work is done",
  description: "When the agent stops, note anything the request asked for that is still missing",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const sessionID = event.data.sessionID
          const state = kit.session(sessionID)
          if (!settings || state.noted.has("completion")) return
          const turn = DecisionTurn.summary(yield* ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => [])))
          if (!turn.request || !turn.final) return
          const room = DecisionText.budget(kit.limit(), 0.25)
          const { choice, probabilities, result } = yield* DecisionBlocks.choose(
            kit,
            {
              user_request: DecisionText.clip(turn.request, room),
              final_message: DecisionText.clip(turn.final, room),
              tool_calls: turn.calls.slice(-12).map((call) => ({ name: call.name, target: call.target, status: call.status })),
            },
            QUESTION,
            settings.threshold,
          )
          yield* kit.log({ choice: choice ?? "unsure", partial: probabilities?.partial, ms: result.ms, ...DecisionText.outcome(result) })
          if (choice !== "partial") return
          state.noted.add("completion")
          yield* DecisionActions.note(ctx, {
            sessionID,
            use: "completion",
            resume: settings.options.resume === true,
            text: "parts of the user's request look unfinished or still failing. Check what is left, finish it or say clearly what is not done.",
          })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
      Effect.asVoid,
    ),
})
