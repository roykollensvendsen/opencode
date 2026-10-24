export * as OutputUse from "./output.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Long shell output is split into chunks, and only the chunks that matter for the user's request are kept for the
 * agent: the cause, the failing item, the key error or the summary. The rest is replaced by a marker saying what was
 * left out. The full output stays in the tool result's structured `output`.
 */

const LONG = 6_000
const CHUNKS = 8
const PER_CHUNK = 600

export const question = (index: number) => ({
  instructions: `Is chunk c${index} of the command output worth showing the agent for this task? It is worth showing if it states the cause, the failing item, the key error or the summary the task needs; progress lines, banners, warnings and hints unrelated to the task are not.`,
})

/** Splits text into at most `count` chunks on line breaks, keeping lines whole. */
export function split(text: string, count = CHUNKS) {
  const lines = text.split("\n")
  const size = Math.ceil(lines.length / count)
  return Array.from({ length: Math.ceil(lines.length / size) }, (_, i) => lines.slice(i * size, (i + 1) * size).join("\n"))
}

/** The kept chunks in their original order, with a marker for each run of left-out chunks. */
export function join(chunks: ReadonlyArray<string>, keep: ReadonlySet<number>) {
  return chunks
    .map((chunk, i) => (keep.has(i) ? chunk : undefined))
    .reduce<string[]>((out, chunk, i) => {
      if (chunk !== undefined) return [...out, chunk]
      if (i > 0 && !keep.has(i - 1)) return out
      return [...out, "[… output left out as not relevant to the task …]"]
    }, [])
    .join("\n")
}

export const Use = DecisionUse.define({
  id: "output",
  title: "Trim long output",
  description: "Keep only the parts of long command output that matter for the request",
  threshold: 0.5,
  setup: (ctx, kit) =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.tool !== "shell" || event.status !== "completed") return
        const text = DecisionText.resultText(event.result)
        if (text.length < LONG) return
        const chunks = split(text)
        // Short excerpts per chunk: they judge as well, and long requests go to a slower, often busy queue on hosts like
        // Decision Models (measured 2026-10-24: 600 characters a chunk kept the failure at 0.95; 2,800 hit "capacity busy").
        const room = Math.min(PER_CHUNK, Math.floor(DecisionText.budget(kit.limit(), 0.8) / chunks.length))
        const picked = yield* DecisionBlocks.select(kit, {
          state: {
            task: kit.session(event.sessionID).userRequest ?? "(unknown)",
            output_chunks: Object.fromEntries(chunks.map((chunk, i) => [`c${i}`, DecisionText.clip(chunk, room)])),
          },
          items: chunks.map((_, i) => i),
          question,
          threshold: settings.threshold,
        })
        yield* kit.log({
          chunks: chunks.length,
          kept: picked.chosen?.length ?? "all",
          ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
        })
        // Keep everything when the model could not answer or kept nothing, so no output is ever lost silently.
        if (!picked.chosen || picked.chosen.length === 0 || picked.chosen.length === chunks.length) return
        const kept = join(chunks, new Set(picked.chosen))
        event.result = DecisionActions.annotate(
          { ...event.result, content: kept },
          `long output trimmed to ${picked.chosen.length} of ${chunks.length} parts that matter for the task; run the command again with a filter if you need the rest.`,
        )
      }),
    ),
})
