export * as DecisionUses from "./uses.js"

import { ApprovalUse } from "./uses/approval.js"
import { ClaimsUse } from "./uses/claims.js"
import { CompletionUse } from "./uses/completion.js"
import { DecideUse } from "./uses/decide.js"
import { EffortUse } from "./uses/effort.js"
import { FlakyUse } from "./uses/flaky.js"
import { FrustrationUse } from "./uses/frustration.js"
import { GuardUse } from "./uses/guard.js"
import { ModelsUse } from "./uses/models.js"
import { OutputUse } from "./uses/output.js"
import { QuestionsUse } from "./uses/questions.js"
import { RetriesUse } from "./uses/retries.js"
import { RoutingUse } from "./uses/routing.js"
import { ScreeningUse } from "./uses/screening.js"
import { SkillsUse } from "./uses/skills.js"
import { StuckUse } from "./uses/stuck.js"

/** Every built-in use. Adding one is a new module here; none of them knows about the others. */
export const all = [
  ApprovalUse.Use,
  ScreeningUse.Use,
  SkillsUse.Use,
  DecideUse.Use,
  ClaimsUse.Use,
  RetriesUse.Use,
  EffortUse.Use,
  GuardUse.Use,
  RoutingUse.Use,
  StuckUse.Use,
  CompletionUse.Use,
  FrustrationUse.Use,
  FlakyUse.Use,
  QuestionsUse.Use,
  OutputUse.Use,
  ModelsUse.Use,
] as const
