export * as QuestionsUse from "./questions.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Before the agent asks the user a question, the model judges whether the user's own messages already answer it. If
 * they do, the question is not shown and the agent is told to go on with what it was told. The agent's own reading
 * of the answer is still its call; this only saves the user a question they already answered.
 */

export const QUESTION = {
  instructions:
    "A coding agent is about to ask the user the question below. Does the context already answer it, so the agent could proceed without asking?",
  criteria: {
    true: "The context states or clearly implies the answer.",
    false: "The context does not settle it; the user really has to decide.",
  },
} as const

export const Use = DecisionUse.define({
  id: "questions",
  title: "Skip answered questions",
  description: "Stop the agent asking something the user already said",
  threshold: 0.8,
  setup: (ctx, kit) =>
    ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.tool !== "question") return
        const questions = DecisionText.field(DecisionText.toJson(event.input), "questions")
        const asked = Array.isArray(questions)
          ? questions.flatMap((question) => {
              const text = DecisionText.field(question, "question")
              return typeof text === "string" ? [text] : []
            })
          : []
        if (asked.length === 0) return
        const messages = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => []))
        const said = messages
          .flatMap((message) => (message.type === "user" ? [message.text] : []))
          .slice(-5)
          .join("\n---\n")
        if (!said) return
        const room = DecisionText.budget(kit.limit(), 0.6)
        const { p, result } = yield* DecisionBlocks.gate(
          kit,
          { question: asked.join("\n"), context: { user_messages: DecisionText.clip(said, room) } },
          QUESTION,
        )
        const answered = p !== undefined && p >= settings.threshold
        yield* kit.log({ answered, p, ms: result.ms, ...DecisionText.outcome(result) })
        if (answered)
          return yield* DecisionActions.reject(
            `the user's earlier messages already answer this (decision model p=${p.toFixed(2)}). Re-read them and continue without asking.`,
          )
      }),
    ),
})
