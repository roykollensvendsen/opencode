export * as ConfigDecision from "./decision.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export class Purpose extends Schema.Class<Purpose>("Config.Decision.Purpose")({
  enabled: Schema.Boolean.pipe(optional).annotate({ description: "Turn this use of the decision model on or off" }),
  threshold: Probability.pipe(optional).annotate({ description: "Probability the answer needs before it is acted on" }),
}) {}

export class Info extends Schema.Class<Info>("Config.Decision")({
  model: Schema.String.pipe(optional).annotate({
    description: "Decision model as provider/model, e.g. decisionmodels/reax-1, using that provider's credentials",
  }),
  timeout: NonNegativeInt.pipe(optional).annotate({ description: "Milliseconds before a decision counts as unavailable" }),
  max_questions: NonNegativeInt.pipe(optional).annotate({ description: "Questions the model accepts per request" }),
  approve: Purpose.pipe(optional).annotate({ description: "Allow routine tool calls that would otherwise ask" }),
  screen: Purpose.pipe(optional).annotate({ description: "Flag tool results that try to instruct the agent" }),
  skills: Purpose.pipe(optional).annotate({ description: "Offer only the skills relevant to the session's request" }),
}) {}
