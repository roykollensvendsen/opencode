export * as DecisionActions from "./actions.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import type { SessionSchema } from "../session/schema.js"
import { DecisionText } from "./text.js"

/** What a use can do with an answer. Each keeps OpenCode's own flow and only adds to it. */

/** A note in the Session the agent reads on its next step; with `resume` the agent continues right away. */
export const note = (
  ctx: Context,
  input: { readonly sessionID: SessionSchema.ID; readonly use: string; readonly text: string; readonly resume?: boolean },
) =>
  ctx.session
    .synthetic({
      sessionID: input.sessionID,
      resume: input.resume === true,
      description: `Decision: ${input.use}`,
      text: `[OpenCode: ${input.text}]`,
      metadata: { source: "decision", purpose: input.use },
    })
    .pipe(Effect.ignore)

/** A warning put in front of a tool result, so the agent reads it with the result. */
export const annotate = <R extends { readonly content?: unknown }>(result: R, text: string) =>
  DecisionText.prepend(result, `[OpenCode: ${text}]`)

/** Rejects a tool call before it runs, with the reason the agent sees as the tool's error. */
export const reject = (text: string) => new Tool.Error({ message: text })
