export * as GuardUse from "./guard.js"

import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { Decision } from "../../decision.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Before an edit runs, the model judges whether it weakens tests, assertions, type checks, linting, validation or
 * security checks instead of fixing the code they check. It sees the user's request and the last shell output, so a
 * test changed to match a bug is caught while a test changed on request is not. A weakening edit is rejected with the
 * reason, and the agent decides what to do next.
 */

export const QUESTION = {
  type: "boolean",
  instructions:
    "A coding agent is about to make this change. Does it weaken or disable tests, assertions, type checks, linting, validation or security checks, instead of fixing the code they check? Use the user's request and the last command output to judge what the tests are meant to check.",
  criteria: {
    true: "It deletes, skips, loosens or fakes a test or check, or changes a test's expected value to match output the code currently produces when the code is what is wrong.",
    false:
      "It changes code, or adds, corrects or removes tests in a way the user's request calls for and that keeps the remaining checks meaningful.",
  },
} as const

const EDITS = new Set(["edit", "write", "patch"])
/** Shell commands that rewrite files in place; plain reads and test runs are not judged. */
const WRITES = /\bsed\s+(-[a-z]*i|--in-place)|\bperl\s+-[a-z]*i|\btee\b|>\s*[^&|\s]/

export const judged = (tool: string, input: unknown) => {
  if (EDITS.has(tool)) return true
  const command = DecisionText.field(DecisionText.toJson(input), "command")
  return tool === "shell" && typeof command === "string" && WRITES.test(command)
}

export const rejection = (p: number) =>
  `This change looks like it weakens a test or check instead of fixing the code it checks (decision model p=${p.toFixed(2)}). Fix the code, or ask the user before changing what the test or check expects.`

export const Use = DecisionUse.define({
  id: "guard",
  threshold: 0.7,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.sync(() => {
          if (!kit.settings() || event.tool !== "shell" || event.status !== "completed") return
          const command = DecisionText.field(DecisionText.toJson(event.input), "command")
          kit.session(event.sessionID).lastCommand = {
            command: typeof command === "string" ? command.slice(0, 300) : "",
            output: DecisionText.resultText(event.result).slice(-4_000),
          }
        }),
      )
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          if (!settings || !judged(event.tool, event.input)) return
          const state = kit.session(event.sessionID)
          // A large write would not fit the decision model; keep the start and end of each text field instead.
          const room = DecisionText.budget(kit.limit(), 0.15)
          const input = DecisionText.toJson(event.input)
          const clipped =
            input !== null && input !== undefined && typeof input === "object" && !Array.isArray(input)
              ? Object.fromEntries(
                  Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? DecisionText.clip(value, room) : value]),
                )
              : (input ?? null)
          const result = yield* kit.ask(
            {
              user_request: DecisionText.clip(state.userRequest ?? "(unknown)", room),
              tool: event.tool,
              input: clipped,
              last_command: state.lastCommand
                ? { command: state.lastCommand.command, output: DecisionText.clip(state.lastCommand.output, room) }
                : null,
            },
            { weakens: QUESTION },
          )
          const p = Decision.probability(result, "weakens")
          const blocked = p !== undefined && p >= settings.threshold
          yield* kit.log({ tool: event.tool, source: DecisionText.sourceOf(event.tool, event.input), blocked, p, ms: result.ms, ...DecisionText.outcome(result) })
          if (blocked) return yield* new Tool.Error({ message: rejection(p) })
        }),
      )
    }),
})
