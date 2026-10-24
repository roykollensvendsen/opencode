export * as TopicsUse from "./topics.js"

import { Effect } from "effect"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Each new user message is compared with the previous request. When it starts a different task, the Session's topic
 * counter is bumped, so the uses that pick once per Session (skills, tools, reading) pick again for the new task. It
 * changes nothing the agent sees by itself.
 */

export const QUESTION = {
  instructions:
    "A user sent a new message to a coding agent. Does it start a different task from the previous request, one that needs different files, tools or skills, rather than continuing, refining or confirming the same task?",
  criteria: {
    true: "A new, separate task: another feature, module, bug or kind of work, even if it shares words with the previous request.",
    false: "A follow-up on the same task: a refinement, next step, confirmation, question about it, or a fix to what was just done.",
  },
} as const

export const Use = DecisionUse.define({
  id: "topics",
  title: "Notice new topics",
  description: "When the user starts a different task, redo the skill, tool and file picks",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const state = kit.session(event.sessionID)
        if (!settings || event.prompt.text.trim().length === 0) return
        // The prompt hook runs before the new message is recorded, so the previous request is still the latest one:
        // in memory, or after a server restart in the Session's history.
        const previous =
          state.userRequest ??
          (yield* ctx.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => [])))
            .flatMap((message) => (message.type === "user" ? [message.text] : []))
            .at(-1)
        if (!previous) return
        const { p, result } = yield* DecisionBlocks.gate(
          kit,
          {
            previous_request: DecisionText.clip(previous, 1_500),
            new_message: DecisionText.clip(event.prompt.text, 1_500),
          },
          QUESTION,
        )
        const shift = p !== undefined && p >= settings.threshold
        if (shift) {
          state.topic += 1
          state.skills = undefined
        }
        yield* kit.log({ shift, p, topic: state.topic, ms: result.ms, ...DecisionText.outcome(result) })
      }),
    ),
})
