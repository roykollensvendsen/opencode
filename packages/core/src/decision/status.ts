export * as DecisionStatus from "./status.js"

import { Effect } from "effect"
import { Config } from "../config.js"
import { Decision } from "../decision.js"
import { DecisionUses } from "./uses.js"

/**
 * What each use and the model are set to and where that setting comes from, for the UI. A choice made in the UI
 * (an override) wins over config; with neither, a use is off.
 */
export const current = Effect.fn("DecisionStatus.current")(function* () {
  const configs = yield* Config.Service
  const decision = yield* Decision.Service
  const config = Config.latest(yield* configs.entries(), "decision")
  const overrides = decision.controls.current()
  const model = overrides.model ?? config?.model
  return {
    model,
    modelSource: overrides.model ? ("override" as const) : config?.model ? ("config" as const) : ("none" as const),
    uses: DecisionUses.all.map((use) => {
      const override = overrides.uses[use.id]
      const configured = config?.uses?.[use.id]
      const last = decision.last(use.id)
      return {
        id: use.id,
        title: use.title,
        description: use.description,
        enabled: override ?? configured?.enabled === true,
        source:
          override !== undefined ? ("override" as const) : configured?.enabled !== undefined ? ("config" as const) : ("default" as const),
        threshold: configured?.threshold ?? use.threshold,
        ...(last ? { last } : {}),
      }
    }),
  }
})

/** Decision models the current model's provider lists, as `provider/model`; empty when no model is chosen. */
export const models = Effect.fn("DecisionStatus.models")(function* (providerID?: string) {
  const status = yield* current()
  const provider = providerID ?? status.model?.split("/")[0]
  if (!provider) return []
  const decision = yield* Decision.Service
  return ((yield* decision.models(provider)) ?? []).map((id) => `${provider}/${id}`)
})
