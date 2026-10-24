export * as DecisionUses from "./uses.js"

import { ApprovalUse } from "./uses/approval.js"
import { ClaimsUse } from "./uses/claims.js"
import { EffortUse } from "./uses/effort.js"
import { GuardUse } from "./uses/guard.js"
import { RetriesUse } from "./uses/retries.js"
import { RoutingUse } from "./uses/routing.js"
import { ScreeningUse } from "./uses/screening.js"
import { SkillsUse } from "./uses/skills.js"
import { DecideUse } from "./uses/decide.js"

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
] as const
