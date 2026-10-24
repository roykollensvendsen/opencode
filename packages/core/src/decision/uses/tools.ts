export * as ToolsUse from "./tools.js"

import { Effect } from "effect"
import { Mcp } from "../../mcp/index.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * With many MCP tools, the model sees only the ones relevant to the Session's first request. The choice is made once
 * per Session so the tool list, and the prompt cache, stay stable. Built-in tools are never removed, and with fewer
 * MCP tools than `options.min` (default 10) nothing is filtered.
 */

export const question = (tool: { readonly name: string; readonly description: string }) => ({
  instructions: `Would a coding agent need to call the "${tool.name}" tool (${tool.description}) to handle this request? Count tools needed to find information as well as to act.`,
})

/** The tool names to drop: MCP tools that were not picked. */
export const dropped = (tools: ReadonlyArray<string>, mcp: ReadonlySet<string>, keep: ReadonlySet<string>) =>
  tools.filter((name) => mcp.has(name) && !keep.has(name))

export const Use = DecisionUse.define({
  id: "tools",
  title: "Pick MCP tools",
  description: "With many MCP tools, offer only the ones relevant to the request",
  threshold: 0.5,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const mcp = yield* Mcp.Service
      const chosen = new Map<string, ReadonlySet<string> | "all">()
      yield* ctx.session.hook("context", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const request = kit.session(event.sessionID).userRequest
          if (!settings || !request) return
          const names = new Set((yield* mcp.tools().pipe(Effect.orElseSucceed(() => []))).map((tool) => tool.name))
          const offered = Object.entries(event.tools)
            .filter(([name]) => names.has(name) || [...names].some((tool) => name.endsWith(`_${tool}`)))
            .map(([name, tool]) => ({ name, description: tool.description.slice(0, 200) }))
          const min = typeof settings.options.min === "number" ? settings.options.min : 10
          if (offered.length < min) return
          const keep =
            chosen.get(event.sessionID) ??
            (yield* Effect.gen(function* () {
              const picked = yield* DecisionBlocks.select(kit, {
                state: { user_message: DecisionText.clip(request, DecisionText.budget(kit.limit(), 0.3)) },
                items: offered,
                question,
                threshold: settings.threshold,
              })
              const result: ReadonlySet<string> | "all" = picked.chosen ? new Set(picked.chosen.map((tool) => tool.name)) : "all"
              chosen.set(event.sessionID, result)
              yield* kit.log({
                offered: offered.length,
                kept: result === "all" ? "all" : [...result].join(","),
                ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
              })
              return result
            }))
          if (keep === "all") return
          const mcpNames = new Set(offered.map((tool) => tool.name))
          for (const name of dropped(Object.keys(event.tools), mcpNames, keep)) delete event.tools[name]
        }),
      )
    }),
})
