export * as FlakyUse from "./flaky.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * A failed shell command that looks like a test run is judged flaky (timing, ordering, ports, network) or a real
 * failure. A likely flaky failure gets a note in front of its output to rerun it once before changing code.
 */

export const QUESTION = {
  instructions:
    "A test failed with the output below. Is the failure likely flaky, from timing, ordering, ports or the network, so that rerunning it may pass, rather than a real bug in the code?",
  criteria: {
    true: "Timeouts, connection resets, port clashes, race or ordering effects, especially when it passed before with no related change.",
    false: "A deterministic wrong value, a type or reference error, or a failure that repeats on every run.",
  },
} as const

const TESTS = /\b(test|tests|spec|jest|vitest|pytest|mocha|cargo test|go test|bun test|node --test|playwright)\b/i

/** A failed shell command that ran tests, judged from its command and exit code. */
export const isFailedTestRun = (command: string, exit: unknown) => typeof exit === "number" && exit !== 0 && TESTS.test(command)

export const Use = DecisionUse.define({
  id: "flaky",
  title: "Spot flaky tests",
  description: "Mark test failures that look like timing or network noise, so the agent reruns before changing code",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.tool !== "shell" || event.status !== "completed") return
        const command = DecisionText.field(DecisionText.toJson(event.input), "command")
        const exit = DecisionText.field(DecisionText.toJson(event.result.output), "exit")
        if (typeof command !== "string" || !isFailedTestRun(command, exit)) return
        const output = DecisionText.clip(DecisionText.resultText(event.result), DecisionText.budget(kit.limit(), 0.6))
        const { p, result } = yield* DecisionBlocks.gate(kit, { command, output }, QUESTION)
        const flaky = p !== undefined && p >= settings.threshold
        yield* kit.log({ flaky, p, command: command.slice(0, 100), ms: result.ms, ...DecisionText.outcome(result) })
        if (!flaky) return
        event.result = DecisionActions.annotate(
          event.result,
          `this failure looks flaky, not a code bug (decision model p=${p.toFixed(2)}). Rerun it once before changing code.`,
        )
      }),
    ),
})
