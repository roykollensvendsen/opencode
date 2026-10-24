export * as DecisionBlocks from "./blocks.js"

import type { EvaluationInput } from "@opencode/ai/experimental"
import { Effect } from "effect"
import { Decision } from "../decision.js"
import type { DecisionUse } from "./use.js"

/**
 * The four question forms every use is built from. Each asks through the use's kit, so purpose, limits, credentials and
 * logging stay uniform, and each reports `undefined` when the model could not answer, so the caller keeps OpenCode's
 * own behaviour.
 *
 * - `gate`: one yes/no about a state.
 * - `select`: one yes/no per item; keeps the items above the threshold, best first, optionally capped.
 * - `choose`: one of several options, kept only when its probability reaches the threshold.
 * - `rate`: a level on a scale, as a number from 0 to the number of levels minus one.
 */

export interface YesNo {
  readonly instructions: string
  readonly criteria?: { readonly true: string; readonly false: string }
}

export const gate = Effect.fnUntraced(function* (kit: DecisionUse.Kit, state: EvaluationInput, question: YesNo) {
  const result = yield* kit.ask(state, { answer: { type: "boolean", ...question } })
  return { p: Decision.probability(result, "answer"), result }
})

export const select = Effect.fnUntraced(function* <Item>(
  kit: DecisionUse.Kit,
  input: {
    readonly state: EvaluationInput
    readonly items: ReadonlyArray<Item>
    readonly question: (item: Item) => YesNo
    readonly threshold: number
    /** Keep at most this many, highest probability first. */
    readonly max?: number
  },
) {
  const none: Item[] = []
  if (input.items.length === 0) return { chosen: none, probabilities: [0].slice(1), result: undefined }
  const result = yield* kit.ask(
    input.state,
    Object.fromEntries(input.items.map((item, i) => [`i${i}`, { type: "boolean", ...input.question(item) } as const])),
  )
  if (result.status !== "ok") return { chosen: undefined, probabilities: undefined, result }
  const probabilities = input.items.map((_, i) => Decision.probability(result, `i${i}`) ?? 0)
  return { chosen: kept(input.items, probabilities, input.threshold, input.max), probabilities, result }
})

export const choose = Effect.fnUntraced(function* (
  kit: DecisionUse.Kit,
  state: EvaluationInput,
  question: { readonly instructions: string; readonly criteria: Readonly<Record<string, string>> },
  threshold: number,
) {
  const result = yield* kit.ask(state, { answer: { type: "choice", ...question } })
  const answer = result.status === "ok" ? result.answers.answer : undefined
  const probabilities = answer?.type === "choice" ? answer.probabilities : undefined
  return { choice: confident(probabilities, threshold), probabilities, result }
})

export const rate = Effect.fnUntraced(function* (
  kit: DecisionUse.Kit,
  state: EvaluationInput,
  question: { readonly instructions: string; readonly criteria: ReadonlyArray<string> },
) {
  const result = yield* kit.ask(state, { answer: { type: "score", ...question } })
  const answer = result.status === "ok" ? result.answers.answer : undefined
  return { score: answer?.type === "score" ? answer.score : undefined, result }
})

/** The items at or above the threshold, highest probability first, capped at `max`. */
export function kept<Item>(items: ReadonlyArray<Item>, probabilities: ReadonlyArray<number>, threshold: number, max?: number) {
  return items
    .map((item, i) => ({ item, p: probabilities[i] ?? 0 }))
    .filter((entry) => entry.p >= threshold)
    .toSorted((a, b) => b.p - a.p)
    .slice(0, max)
    .map((entry) => entry.item)
}

/** The option whose probability reaches the threshold, if any. */
export function confident(probabilities: Readonly<Record<string, number>> | undefined, threshold: number) {
  return Object.entries(probabilities ?? {})
    .filter((entry) => entry[1] >= threshold)
    .toSorted((a, b) => b[1] - a[1])[0]?.[0]
}
