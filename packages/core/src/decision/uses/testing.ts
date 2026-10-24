export * as TestingUse from "./testing.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionFiles } from "../files.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * After an edit to a source file, the project's test files are judged for the ones that check the changed code, and
 * the edit result gets a note naming them, so the agent can run those first. It never says to skip other tests.
 */

export const question = (change: string) => (path: string) => ({
  instructions: `Should the test file ${path} be run to check this change (${change})? Yes if the changed code is used by what the test covers, directly or through other modules.`,
})

export const Use = DecisionUse.define({
  id: "testing",
  title: "Suggest tests to run",
  description: "After an edit, name the test files most likely to check the change",
  threshold: 0.5,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const done = new Set<string>()
      const list = yield* DecisionFiles.lister()
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          if (!settings || event.status !== "completed" || !["edit", "write", "patch"].includes(event.tool)) return
          const path = DecisionText.sourceOf(event.tool, event.input)
          const key = `${event.sessionID}:${path}`
          if (DecisionFiles.isTest(path) || done.has(key)) return
          done.add(key)
          const tests = (yield* list()).filter(DecisionFiles.isTest)
          if (tests.length === 0) return
          const change = `${path}: ${DecisionText.clip(kit.session(event.sessionID).userRequest ?? "", 300)}`
          const picked = yield* DecisionFiles.pick(kit, {
            request: change,
            files: tests,
            question: question(change),
            threshold: settings.threshold,
            max: 5,
          })
          yield* kit.log({ changed: path, tests: picked?.join(",") || "none" })
          if (!picked || picked.length === 0) return
          event.result = DecisionActions.annotate(
            event.result,
            `tests most likely to check this change: ${picked.join(", ")}. Run those first; they do not replace the full suite.`,
          )
        }),
      )
    }),
})
