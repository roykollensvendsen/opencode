import { Decision } from "@opencode/core/decision"
import { DecisionStatus } from "@opencode/core/decision/status"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

export const DecisionHandler = HttpApiBuilder.group(Api, "server.decision", (handlers) =>
  handlers
    .handle("decision.status", () => response(DecisionStatus.current()))
    .handle("decision.update", (ctx) =>
      response(
        Decision.Service.use((decision) => decision.controls.set(ctx.payload)).pipe(
          Effect.andThen(DecisionStatus.current()),
        ),
      ),
    )
    .handle("decision.models", (ctx) => response(DecisionStatus.models(ctx.query.provider))),
)
