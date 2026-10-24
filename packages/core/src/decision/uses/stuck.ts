export * as StuckUse from "./stuck.js"

import { Effect } from "effect"
import type { DecisionTurn } from "../turn.js"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * After a tool call that looks like repetition, the last calls are judged for a loop that makes no progress. If the
 * agent is stuck, it gets one note per request to step back and try something else or ask the user.
 */

export const QUESTION = {
  instructions:
    "These are the last tool calls of a coding agent, oldest first. Is the agent stuck: repeating the same or near-identical actions that keep producing the same failure or no new information, without making progress?",
  criteria: {
    true: "The same command fails the same way again and again, edits are undone and redone, or the same files are read repeatedly with nothing new learned.",
    false:
      "Each step changes something or yields new information: outputs improve, errors change, or a repeated check is waiting for something that then happens.",
  },
} as const

/** Only ask when the recent calls repeat a target, which a loop always does; varied work is not judged. */
export const repeats = (calls: ReadonlyArray<DecisionTurn.ToolCall>) => {
  if (calls.length < 4) return false
  const last = calls.at(-1)
  return calls.slice(-6, -1).filter((call) => call.name === last?.name && call.target === last.target).length >= 2
}

export const Use = DecisionUse.define({
  id: "stuck",
  title: "Notice loops",
  description: "Tell the agent when it repeats the same failing steps without progress",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const state = kit.session(event.sessionID)
        if (!settings || state.noted.has("stuck") || !repeats(state.recentCalls)) return
        const calls = state.recentCalls.slice(-6).map((call) => ({ name: call.name, target: call.target, status: call.status, output: call.output }))
        const { p, result } = yield* DecisionBlocks.gate(kit, { tool_calls: calls }, QUESTION)
        const stuck = p !== undefined && p >= settings.threshold
        yield* kit.log({ stuck, p, ms: result.ms, ...DecisionText.outcome(result) })
        if (!stuck) return
        state.noted.add("stuck")
        yield* DecisionActions.note(ctx, {
          sessionID: event.sessionID,
          use: "stuck",
          text: `your last steps repeat without progress (decision model p=${p.toFixed(2)}). Step back: try a different approach, or tell the user what blocks you.`,
        })
      }),
    ),
})
