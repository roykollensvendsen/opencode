export * as ConfigDecision from "./decision.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export class Purpose extends Schema.Class<Purpose>("Config.Decision.Purpose")({
  enabled: Schema.Boolean.pipe(optional).annotate({ description: "Turn this use of the decision model on or off" }),
  threshold: Probability.pipe(optional).annotate({ description: "Probability the answer needs before it is acted on" }),
}) {}

export class Claims extends Schema.Class<Claims>("Config.Decision.Claims")({
  enabled: Schema.Boolean.pipe(optional).annotate({ description: "Turn this use of the decision model on or off" }),
  threshold: Probability.pipe(optional).annotate({ description: "Probability the answer needs before it is acted on" }),
  resume: Schema.Boolean.pipe(optional).annotate({
    description: "Let the agent continue after a contradicted claim instead of only leaving a note",
  }),
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
  tool: Purpose.pipe(optional).annotate({ description: "Give the agent a decide tool for its own typed questions" }),
  claims: Claims.pipe(optional).annotate({
    description: "When a Session goes idle, check the agent's last message against the last command output",
  }),
  retry: Purpose.pipe(optional).annotate({ description: "Stop retrying model errors that retrying will not fix" }),
}) {}
