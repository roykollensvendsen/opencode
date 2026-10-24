export * as HistoryUse from "./history.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * The first request of a Session is compared with the titles of recent Sessions. When it looks like the same task,
 * the agent gets a note naming that Session, so it can tell the user and offer to continue there.
 */

export const QUESTION = (earlier: ReadonlyArray<{ readonly id: string; readonly title: string }>) => ({
  instructions:
    "Is the new request a continuation of one of these earlier sessions (same task in the same project), or a new task?",
  criteria: {
    ...Object.fromEntries(earlier.map((session) => [session.id, session.title])),
    none: "A new task, not one of the sessions above.",
  },
})

export const Use = DecisionUse.define({
  id: "history",
  title: "Find the earlier session",
  description: "When a new session repeats an earlier task, point the agent to that session",
  threshold: 0.8,
  setup: (ctx, kit) =>
    ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.prompt.text.trim().length === 0) return
        const messages = yield* ctx.session.context({ sessionID: event.sessionID }).pipe(Effect.orElseSucceed(() => []))
        if (messages.some((message) => message.type === "user")) return
        const listed = yield* ctx.session.list({ limit: 12, order: "desc" }).pipe(Effect.orElseSucceed(() => undefined))
        const earlier = (listed?.data ?? [])
          .filter((session) => session.id !== event.sessionID && session.title)
          .slice(0, 8)
          .map((session) => ({ id: session.id, title: session.title ?? "" }))
        if (earlier.length === 0) return
        const { choice, result } = yield* DecisionBlocks.choose(
          kit,
          { new_request: DecisionText.clip(event.prompt.text, DecisionText.budget(kit.limit(), 0.4)) },
          QUESTION(earlier),
          settings.threshold,
        )
        const match = earlier.find((session) => session.id === choice)
        yield* kit.log({ match: match?.id ?? "none", sessions: earlier.length, ms: result.ms, ...DecisionText.outcome(result) })
        if (!match) return
        yield* DecisionActions.note(ctx, {
          sessionID: event.sessionID,
          use: "history",
          text: `this request looks like a continuation of the earlier session "${match.title}" (${match.id}). Mention it to the user and offer to continue there if that helps.`,
        })
      }),
    ),
})
