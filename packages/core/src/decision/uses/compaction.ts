export * as CompactionUse from "./compaction.js"

import { Message } from "@opencode/ai"
import { Effect } from "effect"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Before OpenCode compacts a Session, earlier tool results are scored for how much the current request still needs
 * them. Results judged not needed are replaced by a one-line stub in what the compaction model reads, so its summary
 * keeps what matters. The Session's own history is not changed.
 */

export const QUESTION = {
  instructions:
    "A coding agent's context is being compacted. Given the current request, how much is this earlier tool result still needed?",
  criteria: ["Not needed any more", "Might help", "Needed to finish the request"],
} as const

type Part = Message["content"][number]
type Result = Extract<Part, { type: "tool-result" }>

const STUB = "[left out of the compaction summary as no longer needed]"

/**
 * The text of a tool result for judging it. Each result is judged in its own request, so it can take most of the
 * model's context: a fact deep in a file is what decides whether the result is still needed.
 */
export const preview = (part: Result, max: number) => {
  const value = part.result.value
  const text = typeof value === "string" ? value : DecisionText.contentText(value) || JSON.stringify(value ?? "")
  return `${part.name}: ${DecisionText.clip(text, max)}`
}

export const Use = DecisionUse.define({
  id: "compaction",
  title: "Focus compaction",
  description: "Leave stale tool results out of the summary when a session is compacted",
  threshold: 0.75,
  setup: (ctx, kit) =>
    ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const request = kit.session(event.sessionID).userRequest
        if (!settings || !request) return
        const results = event.messages.flatMap((message) =>
          message.content.flatMap((part) => (part.type === "tool-result" ? [part] : [])),
        )
        if (results.length < 4) return
        // Score every result but the most recent three, which the next step almost always needs.
        const judged = results.slice(0, -3)
        const scores = yield* Effect.forEach(
          judged,
          (part) =>
            DecisionBlocks.rate(
              kit,
              {
                current_request: DecisionText.clip(request, 1_500),
                tool_result: preview(part, DecisionText.budget(kit.limit(), 0.6)),
              },
              QUESTION,
            ),
          { concurrency: 4 },
        )
        // A result the model could not score is kept.
        const stale = new Set(
          judged
            .filter((_, i) => {
              const score = scores[i]?.score
              return score !== undefined && score < settings.threshold
            })
            .map((part) => part.id),
        )
        yield* kit.log({ results: results.length, judged: judged.length, dropped: stale.size })
        if (stale.size === 0) return
        event.messages = event.messages.map((message) =>
          message.content.some((part) => part.type === "tool-result" && stale.has(part.id))
            ? new Message({
                ...message,
                content: message.content.map((part) =>
                  part.type === "tool-result" && stale.has(part.id)
                    ? { ...part, result: { type: "text", value: STUB } }
                    : part,
                ),
              })
            : message,
        )
      }),
    ),
})
