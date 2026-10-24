export * as TodosUse from "./todos.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * The agent's in-progress todo items are judged against its recent tool calls. An item that looks done, with its
 * work checked, gets one note so the agent can mark it and move on. The todo list itself is only changed by the agent.
 */

export const question = (item: { readonly content: string }) => ({
  instructions: `Given the todo item "${item.content}" and the agent's recent tool calls, is the item now done?`,
  criteria: {
    true: "The tool calls show the work the item asks for was done and, where relevant, checked to work.",
    false: "The work was not done, was only started, only partly done, or the check shows it still fails.",
  },
})

/** In-progress items from a todowrite input. */
export function inProgress(input: unknown) {
  const todos = DecisionText.field(DecisionText.toJson(input), "todos")
  if (!Array.isArray(todos)) return []
  return todos.flatMap((todo) => {
    const content = DecisionText.field(todo, "content")
    return DecisionText.field(todo, "status") === "in_progress" && typeof content === "string" ? [{ content }] : []
  })
}

export const Use = DecisionUse.define({
  id: "todos",
  title: "Notice finished todos",
  description: "Tell the agent when an in-progress todo item looks done",
  threshold: 0.8,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const open = new Map<string, ReadonlyArray<{ readonly content: string }>>()
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          if (!settings) return
          if (event.tool === "todowrite") return void open.set(event.sessionID, inProgress(event.input))
          const items = (open.get(event.sessionID) ?? []).filter((item) => !kit.session(event.sessionID).noted.has(`todo:${item.content}`))
          // Judge only after work that can finish an item, not after every read.
          if (items.length === 0 || !["shell", "edit", "write", "patch"].includes(event.tool)) return
          const state = kit.session(event.sessionID)
          const calls = state.recentCalls.slice(-6).map((call) => ({ name: call.name, target: call.target, status: call.status, output: call.output }))
          const picked = yield* DecisionBlocks.select(kit, {
            state: { tool_calls: calls },
            items,
            question,
            threshold: settings.threshold,
          })
          const done = picked.chosen ?? []
          yield* kit.log({
            open: items.length,
            done: done.map((item) => item.content.slice(0, 40)).join(" | "),
            ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
          })
          if (done.length === 0) return
          done.forEach((item) => state.noted.add(`todo:${item.content}`))
          yield* DecisionActions.note(ctx, {
            sessionID: event.sessionID,
            use: "todos",
            text: `these todo items look done: ${done.map((item) => `"${item.content}"`).join(", ")}. Mark them completed and move on.`,
          })
        }),
      )
    }),
})
