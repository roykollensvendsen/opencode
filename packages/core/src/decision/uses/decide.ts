export * as DecideUse from "./decide.js"

import { EvaluationQuestion } from "@opencode/ai/experimental"
import { Effect, Schema } from "effect"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/** A `decide` tool the agent asks its own typed questions with. */

const DESCRIPTION = [
  "Ask a fast decision model typed questions about some text and get probabilities back instead of prose.",
  "Use it for yes/no checks, picking one of several options, or scoring on a scale: 'is this log line an error?', 'which of these files most likely holds the bug?'.",
  "Questions: {type:'boolean', instructions} | {type:'choice', instructions, criteria:{option: description}} | {type:'score', instructions, criteria:[level, ...]}.",
].join(" ")

const Input = Schema.Struct({
  about: Schema.String.annotate({ description: "The text the questions are about" }),
  questions: Schema.Record(Schema.String, EvaluationQuestion).annotate({
    description: "Question id to question; at most a few per call",
  }),
})

export const Use = DecisionUse.define({
  id: "decide",
  title: "Decide tool",
  description: "Give the agent a tool for its own yes/no, choice and score questions",
  threshold: 0,
  setup: (ctx, kit) =>
    ctx.tool.transform((editor) => {
      if (!kit.settings()) return
      editor.add({
        name: "decide",
        description: DESCRIPTION,
        input: Input,
        execute: (input) =>
          Effect.gen(function* () {
            const result = yield* kit.ask(input.about, input.questions)
            yield* kit.log({ questions: Object.keys(input.questions).join(","), ms: result.ms, ...DecisionText.outcome(result) })
            return {
              content: JSON.stringify(
                result.status === "ok"
                  ? { answers: result.answers, model: result.version ?? result.model }
                  : { unavailable: result.reason, message: result.message },
              ),
            }
          }),
      })
    }),
})
