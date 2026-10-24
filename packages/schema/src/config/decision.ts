export * as ConfigDecision from "./decision.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export class Use extends Schema.Class<Use>("Config.Decision.Use")({
  enabled: Schema.Boolean.pipe(optional).annotate({ description: "Turn this use of the decision model on or off" }),
  threshold: Probability.pipe(optional).annotate({
    description: "Probability the answer needs before it is acted on; each use has its own default",
  }),
  options: Schema.Record(Schema.String, Schema.Json).pipe(optional).annotate({
    description: "Settings specific to this use",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Decision")({
  model: Schema.String.pipe(optional).annotate({
    description: "Decision model as provider/model, e.g. decisionmodels/reax-1, using that provider's credentials",
  }),
  timeout: NonNegativeInt.pipe(optional).annotate({ description: "Milliseconds before a decision counts as unavailable" }),
  max_questions: NonNegativeInt.pipe(optional).annotate({ description: "Questions the model accepts per request" }),
  context: NonNegativeInt.pipe(optional).annotate({
    description: "Tokens the model accepts per request; larger questions are reported as too large, not sent",
  }),
  uses: Schema.Record(Schema.String, Use).pipe(optional).annotate({
    description:
      "Uses of the decision model by ID (approval, screening, skills, decide, claims, retries, effort, guard, routing, stuck, completion, frustration, flaky, questions, output, models, scope, search, history, todos, tools, fallback, reading, testing, compaction, screens, topics, commits); each is off unless enabled",
  }),
}) {}
