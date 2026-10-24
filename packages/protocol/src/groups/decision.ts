import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const DecisionSource = Schema.Literals(["override", "config", "default"]).annotate({
  identifier: "DecisionSource",
})

export const DecisionOutcome = Schema.Struct({
  status: Schema.Literals(["ok", "unavailable"]),
  reason: Schema.optional(Schema.Literals(["not-configured", "no-credential", "too-large", "deadline", "error"])),
  ms: Schema.Number,
  at: Schema.Number,
}).annotate({ identifier: "DecisionOutcome" })

export const DecisionUseStatus = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  source: DecisionSource,
  threshold: Schema.Number,
  last: Schema.optional(DecisionOutcome),
}).annotate({ identifier: "DecisionUseStatus" })

export const DecisionStatus = Schema.Struct({
  model: Schema.optional(Schema.String),
  modelSource: Schema.Literals(["override", "config", "none"]),
  uses: Schema.Array(DecisionUseStatus),
}).annotate({ identifier: "DecisionStatus" })

export const DecisionGroup = HttpApiGroup.make("server.decision")
  .add(
    HttpApiEndpoint.get("decision.status", "/api/experimental/decision", {
      query: LocationQuery,
      success: Location.response(DecisionStatus),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.decision.status",
          summary: "Decision model status",
          description:
            "The decision model and each use of it, whether it is on, where that comes from, and how its last request went.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("decision.update", "/api/experimental/decision", {
      query: LocationQuery,
      payload: Schema.Struct({
        model: Schema.optional(Schema.NullOr(Schema.String)),
        uses: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean))),
      }),
      success: Location.response(DecisionStatus),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.decision.update",
          summary: "Change decision model settings",
          description:
            "Choose the decision model or switch uses on and off. Choices are stored per user and win over config; null clears a choice.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("decision.models", "/api/experimental/decision/models", {
      query: Schema.Struct({ ...LocationQuery.fields, provider: Schema.optional(Schema.String) }),
      success: Location.response(Schema.Array(Schema.String)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.decision.models",
          summary: "List decision models",
          description: "Decision models the provider's host lists, as provider/model, using the provider's credentials.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "decision",
      description: "Experimental decision model routes.",
    }),
  )
