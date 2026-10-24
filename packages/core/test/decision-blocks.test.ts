import { describe, expect } from "bun:test"
import type { EvaluationQuestions } from "@opencode/ai/experimental"
import { Decision } from "@opencode/core/decision"
import { DecisionBlocks } from "@opencode/core/decision/blocks"
import type { DecisionUse } from "@opencode/core/decision/use"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

/** A kit whose model answers from `answer`, or is unavailable when `answer` is undefined; it records every question set. */
const kit = (answer: ((questions: EvaluationQuestions) => Record<string, unknown>) | undefined, asked: EvaluationQuestions[] = []) => {
  const value: DecisionUse.Kit = {
    settings: () => ({ threshold: 0.5, options: {} }),
    session: () => ({ flags: [], claimNotes: 0, recentCalls: [], noted: new Set() }),
    limit: () => Decision.DEFAULT_CONTEXT_TOKENS,
    log: () => Effect.void,
    ask: (_state, questions) =>
      Effect.sync((): Decision.Result => {
        asked.push(questions)
        if (!answer) return { status: "unavailable", purpose: "test", model: "x/y", reason: "deadline", ms: 0 }
        return {
          status: "ok",
          purpose: "test",
          model: "x/y",
          answers: answer(questions) as Extract<Decision.Result, { status: "ok" }>["answers"],
          inputTokens: 1,
          requests: 1,
          ms: 1,
          cached: false,
        }
      }),
  }
  return value
}

describe("decision blocks", () => {
  it.effect("gate returns the probability, or undefined when the model cannot answer", () =>
    Effect.gen(function* () {
      const yes = yield* DecisionBlocks.gate(kit(() => ({ answer: { type: "boolean", probability: 0.8 } })), "x", { instructions: "?" })
      expect(yes.p).toBe(0.8)
      const down = yield* DecisionBlocks.gate(kit(undefined), "x", { instructions: "?" })
      expect(down.p).toBeUndefined()
    }),
  )

  it.effect("select keeps items above the threshold, best first, capped, and asks one question per item", () =>
    Effect.gen(function* () {
      const asked: EvaluationQuestions[] = []
      const probabilities = [0.2, 0.9, 0.6, 0.7]
      const picked = yield* DecisionBlocks.select(
        kit(
          (questions) =>
            Object.fromEntries(Object.keys(questions).map((id, i) => [id, { type: "boolean", probability: probabilities[i] }])),
          asked,
        ),
        { state: "x", items: ["a", "b", "c", "d"], question: (item) => ({ instructions: `is ${item}?` }), threshold: 0.5, max: 2 },
      )
      expect(picked.chosen).toEqual(["b", "d"])
      expect(Object.keys(asked[0] ?? {})).toHaveLength(4)
      const none = yield* DecisionBlocks.select(kit(undefined), { state: "x", items: [], question: () => ({ instructions: "?" }), threshold: 0.5 })
      expect(none.chosen).toEqual([])
      const down = yield* DecisionBlocks.select(kit(undefined), { state: "x", items: ["a"], question: () => ({ instructions: "?" }), threshold: 0.5 })
      expect(down.chosen).toBeUndefined()
    }),
  )

  it.effect("choose keeps an option only when it reaches the threshold", () =>
    Effect.gen(function* () {
      const answer = (plan: number) => () => ({
        answer: { type: "choice", choice: "plan", probabilities: { plan, build: 1 - plan } },
      })
      const question = { instructions: "?", criteria: { plan: "p", build: "b" } }
      expect((yield* DecisionBlocks.choose(kit(answer(0.95)), "x", question, 0.9)).choice).toBe("plan")
      expect((yield* DecisionBlocks.choose(kit(answer(0.6)), "x", question, 0.9)).choice).toBeUndefined()
    }),
  )

  it.effect("rate returns the score", () =>
    Effect.gen(function* () {
      const rated = yield* DecisionBlocks.rate(
        kit(() => ({ answer: { type: "score", score: 1.9, probabilities: {} } })),
        "x",
        { instructions: "?", criteria: ["a", "b", "c"] },
      )
      expect(rated.score).toBe(1.9)
    }),
  )
})
