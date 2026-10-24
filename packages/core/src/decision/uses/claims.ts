export * as ClaimsUse from "./claims.js"

import { Effect, Stream } from "effect"
import { Decision } from "../../decision.js"
import type { SessionMessage } from "../../session/message.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * When a Session goes idle, the agent's last message is checked against the output of the last shell command it ran.
 * A success claim the output contradicts gets a note; with `options.resume` the agent continues. At most one note per
 * user request, so the check never loops.
 */

export const QUESTION = {
  type: "boolean",
  instructions:
    "A coding agent finished with the final message below. Does the message claim that something works, passes, is fixed or is done, while the output of the last command it ran shows that it fails?",
  criteria: {
    true: "The message claims success and the command output shows a failure, error or failing test.",
    false: "The message makes no such claim, admits the failure, or the output agrees with it.",
  },
} as const

/** The agent's last text and the last shell command it ran since the latest user message, if it ran one. */
export function lastTurn(messages: ReadonlyArray<SessionMessage.Info>) {
  const after = messages
    .slice(messages.findLastIndex((message) => message.type === "user") + 1)
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
  const text = after.flatMap((part) => (part.type === "text" ? [part.text] : [])).at(-1)
  const command = after
    .flatMap((part) =>
      part.type === "tool" && part.name === "shell" && part.state.status === "completed"
        ? [
            {
              command: String(part.state.input.command ?? ""),
              output: DecisionText.contentText(part.state.content).slice(-4_000),
            },
          ]
        : [],
    )
    .at(-1)
  if (!text || !command) return undefined
  return { text: text.slice(-4_000), command }
}

export const note = (command: string, p: number) =>
  `[OpenCode: your last message claims success, but the output of \`${command}\` shows a failure (decision model p=${p.toFixed(2)}). Re-check before reporting the task as done, and tell the user what actually failed.]`

export const Use = DecisionUse.define({
  id: "claims",
  threshold: 0.7,
  setup: (ctx, kit) =>
    ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const sessionID = event.data.sessionID
          const state = kit.session(sessionID)
          if (!settings || state.claimNotes > 0) return
          const last = lastTurn(yield* ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => [])))
          if (!last) return yield* kit.log({ skipped: "no final message with a shell command after it" })
          const result = yield* kit.ask({ final_message: last.text, last_command: last.command }, { contradicted: QUESTION })
          const p = Decision.probability(result, "contradicted")
          const contradicted = p !== undefined && p >= settings.threshold
          yield* kit.log({ contradicted, p, command: last.command.command.slice(0, 100), ms: result.ms, ...DecisionText.outcome(result) })
          if (!contradicted) return
          state.claimNotes += 1
          yield* ctx.session
            .synthetic({
              sessionID,
              resume: settings.options.resume === true,
              description: "Claim check",
              text: note(last.command.command, p),
              metadata: { source: "decision", purpose: "claims" },
            })
            .pipe(Effect.ignore)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
      Effect.asVoid,
    ),
})
