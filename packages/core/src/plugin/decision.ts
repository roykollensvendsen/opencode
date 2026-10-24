export * as DecisionPlugin from "./decision.js"

import type { Message } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { Config } from "../config.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { Decision } from "../decision.js"
import { DecisionText } from "../decision/text.js"
import { DecisionUses } from "../decision/uses.js"
import type { PluginInternal } from "./internal.js"

/**
 * Starts every use of the decision model in `decision/uses` with its own kit, and keeps the Session facts the uses
 * share (the user's latest request) up to date. Each use is off unless `decision.uses.<id>.enabled` is true, and is
 * checked at call time, so config changes apply without a restart.
 */
export const Plugin = define({
  id: "opencode.decision",
  effect: Effect.fn("DecisionPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const decision = yield* Decision.Service
    // Internal plugins are not re-run on config changes; the tool use reads settings inside its transform.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const current = () => Config.latest(loaded.entries, "decision")
    // A choice made in the UI wins over config; clearing it lets config decide again.
    const model = () => decision.controls.current().model ?? current()?.model
    yield* decision.controls.changes.pipe(
      Stream.runForEach(() => ctx.tool.reload()),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        const state = decision.session(event.sessionID)
        const request = lastUserText(event.messages)
        if (!request || request === state.userRequest) return
        state.userRequest = request
        state.claimNotes = 0
        state.noted.clear()
        state.frustrated = undefined
      }),
    )

    // Recent tool calls are a shared fact several uses judge, so the loader keeps them, not each use.
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.sync(() => {
        const calls = decision.session(event.sessionID).recentCalls
        calls.push({
          name: event.tool,
          target: DecisionText.sourceOf(event.tool, event.input),
          status: event.status === "completed" ? "completed" : "error",
          output: (event.status === "completed" ? DecisionText.resultText(event.result) : event.error.message).slice(-600),
        })
        if (calls.length > 8) calls.splice(0, calls.length - 8)
      }),
    )

    yield* Effect.forEach(DecisionUses.all, (use) =>
      use.setup(ctx, {
        settings: () => {
          const configured = current()?.uses?.[use.id]
          const enabled = decision.controls.current().uses[use.id] ?? configured?.enabled === true
          if (!model() || !enabled) return undefined
          return { threshold: configured?.threshold ?? use.threshold, options: configured?.options ?? {} }
        },
        ask: (state, questions) =>
          decision.ask({
            model: model() ?? "",
            purpose: use.id,
            state,
            questions,
            timeout: current()?.timeout,
            maxQuestions: current()?.max_questions,
            contextTokens: current()?.context,
          }),
        session: decision.session,
        limit: () => current()?.context ?? Decision.DEFAULT_CONTEXT_TOKENS,
        log: (fields) => Effect.logInfo("decision").pipe(Effect.annotateLogs({ purpose: use.id, ...fields })),
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

function lastUserText(messages: ReadonlyArray<Message>) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      message.content
        .flatMap((part) => (part.type === "text" && !part.text.includes("<available_skills>") ? [part.text] : []))
        .join("\n")
        .trim(),
    )
    .findLast((text) => text.length > 0)
    ?.slice(0, 4_000)
}
