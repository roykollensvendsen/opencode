export * as SearchUse from "./search.js"

import { Effect } from "effect"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * Web search results are judged against the user's request, and a note in front of them names the results worth
 * fetching. Nothing is removed; the agent still sees every result.
 */

export const question = (result: { readonly index: number }) => ({
  instructions: `Is search result ${result.index + 1} worth fetching to handle this request? It is worth fetching if its title and snippet show it addresses the actual problem, not just shares words with it.`,
})

/** Search results from a websearch tool output, in their order. */
export function results(output: unknown) {
  const list = DecisionText.field(DecisionText.toJson(output), "results")
  if (!Array.isArray(list)) return []
  return list.flatMap((entry, index) => {
    const url = DecisionText.field(entry, "url")
    if (typeof url !== "string") return []
    const title = DecisionText.field(entry, "title")
    const content = DecisionText.field(entry, "content")
    return [
      {
        index,
        url,
        title: typeof title === "string" ? title : url,
        snippet: typeof content === "string" ? content.slice(0, 300) : "",
      },
    ]
  })
}

export const Use = DecisionUse.define({
  id: "search",
  title: "Rank search results",
  description: "Name the web search results worth fetching for the request",
  threshold: 0.5,
  setup: (ctx, kit) =>
    ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        if (!settings || event.tool !== "websearch" || event.status !== "completed") return
        const found = results(event.result.output)
        if (found.length < 2) return
        const picked = yield* DecisionBlocks.select(kit, {
          state: {
            task: kit.session(event.sessionID).userRequest ?? "(unknown)",
            results: found.map((result) => ({ n: result.index + 1, title: result.title, snippet: result.snippet })),
          },
          items: found,
          question,
          threshold: settings.threshold,
        })
        yield* kit.log({
          results: found.length,
          worth: (picked.chosen ?? []).map((result) => result.index + 1).join(","),
          ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
        })
        if (!picked.chosen || picked.chosen.length === 0 || picked.chosen.length === found.length) return
        event.result = DecisionActions.annotate(
          event.result,
          `results worth fetching for this task: ${picked.chosen.map((result) => `${result.index + 1} (${result.url})`).join(", ")}. The others look unrelated.`,
        )
      }),
    ),
})
