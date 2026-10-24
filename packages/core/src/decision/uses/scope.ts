export * as ScopeUse from "./scope.js"

import { Effect, Stream } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionTurn } from "../turn.js"
import { DecisionUse } from "../use.js"

/**
 * When a Session goes idle, each file the turn changed is judged against the user's request. Changes that look
 * unrelated are listed in one note per request, so the agent can explain or undo them.
 */

export const question = (change: { readonly path: string }) => ({
  instructions: `A coding agent changed ${change.path} while working on the user's request. Is the change unrelated to the request?`,
  criteria: {
    true: "The change does something the request did not ask for and does not need.",
    false:
      "The change is part of the request or a necessary consequence of it (imports, lockfiles, tests for the change, renames across files).",
  },
})

export const Use = DecisionUse.define({
  id: "scope",
  title: "Flag unrelated changes",
  description: "When the agent stops, list changed files that have nothing to do with the request",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const sessionID = event.data.sessionID
          const state = kit.session(sessionID)
          if (!settings || state.noted.has("scope")) return
          const turn = DecisionTurn.summary(yield* ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => [])))
          if (!turn.request || turn.changes.length === 0) return
          const room = Math.floor(DecisionText.budget(kit.limit(), 0.6) / turn.changes.length)
          const picked = yield* DecisionBlocks.select(kit, {
            state: {
              user_request: DecisionText.clip(turn.request, DecisionText.budget(kit.limit(), 0.15)),
              changes: turn.changes.map((change) => ({ path: change.path, change: DecisionText.clip(change.change, room) })),
            },
            items: turn.changes,
            question,
            threshold: settings.threshold,
          })
          const unrelated = [...new Set((picked.chosen ?? []).map((change) => change.path))]
          yield* kit.log({
            files: turn.changes.length,
            unrelated: unrelated.join(","),
            ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
          })
          if (unrelated.length === 0) return
          state.noted.add("scope")
          yield* DecisionActions.note(ctx, {
            sessionID,
            use: "scope",
            text: `these changes look unrelated to the user's request: ${unrelated.join(", ")}. Tell the user why they were needed, or undo them.`,
          })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
      Effect.asVoid,
    ),
})
