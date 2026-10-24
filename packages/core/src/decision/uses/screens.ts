export * as ScreensUse from "./screens.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * When a tool returns a screenshot (an image in its content, e.g. from a browser or computer-use tool), a vision
 * decision model judges whether it shows an error, and the result gets a note when it does. The vision model is
 * `options.model` (e.g. `decisionmodels/s1-vision-2`); without it nothing runs. Images must be data URLs under the
 * host's limit (Decision Models rejects over 2 megapixels or 4 MiB); larger ones are skipped, not resized.
 */

export const QUESTION = {
  instructions:
    "Does this screenshot of an application show an error: an error message, a failed state, a crash, or a validation problem?",
  criteria: {
    true: "Error banners, red validation text, failure or crash pages, 404 or 500 pages, or a message that something went wrong.",
    false: "Normal content, empty states, loading, promotions or success messages.",
  },
} as const

const MAX_BYTES = 4 * 1024 * 1024

/** Image data URLs in a tool result's content, skipping any over the host's size limit. */
export function images(content: unknown) {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const uri = part?.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/") ? part.uri : undefined
    if (typeof uri !== "string" || !uri.startsWith("data:image/")) return []
    // Base64 is 4 characters per 3 bytes.
    return uri.length * 0.75 <= MAX_BYTES ? [uri] : []
  })
}

/** Image data URLs among a prompt's file attachments; attachments given as file paths are not read here. */
export const attached = (files: ReadonlyArray<{ readonly uri: string }> | undefined) =>
  (files ?? []).flatMap((file) => (file.uri.startsWith("data:image/") && file.uri.length * 0.75 <= MAX_BYTES ? [file.uri] : []))

export const Use = DecisionUse.define({
  id: "screens",
  title: "Check screenshots",
  description: "When a tool returns or the user attaches a screenshot, tell the agent if it shows an error",
  threshold: 0.7,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      // A screenshot the user attaches: the agent's own model may not see images, so it gets a note either way.
      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const model = settings?.options.model
          const shot = attached(event.prompt.files).at(-1)
          if (!settings || typeof model !== "string" || !shot) return
          const { p, result } = yield* DecisionBlocks.gate(kit, "A screenshot the user attached.", QUESTION, {
            model,
            images: [shot],
          })
          const error = p !== undefined && p >= settings.threshold
          yield* kit.log({ source: "attachment", error, p, ms: result.ms, ...DecisionText.outcome(result) })
          if (!error) return
          yield* DecisionActions.note(ctx, {
            sessionID: event.sessionID,
            use: "screens",
            text: `the screenshot the user attached appears to show an error (vision model p=${p.toFixed(2)}).`,
          })
        }),
      )
      yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const model = settings?.options.model
        if (!settings || typeof model !== "string" || event.status !== "completed") return
        const shot = images(event.result.content).at(-1)
        if (!shot) return
        const { p, result } = yield* DecisionBlocks.gate(kit, "A screenshot of an application.", QUESTION, {
          model,
          images: [shot],
        })
        const error = p !== undefined && p >= settings.threshold
        yield* kit.log({ tool: event.tool, error, p, ms: result.ms, ...DecisionText.outcome(result) })
        if (!error) return
        event.result = DecisionActions.annotate(
          event.result,
          `this screenshot appears to show an error (vision model p=${p.toFixed(2)}). Look at it before reporting success.`,
        )
      }),
      )
    }),
})
