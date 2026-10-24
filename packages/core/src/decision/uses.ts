export * as DecisionUses from "./uses.js"

import { ApproveUse } from "./uses/approve.js"
import { ClaimsUse } from "./uses/claims.js"
import { EffortUse } from "./uses/effort.js"
import { GuardUse } from "./uses/guard.js"
import { RetryUse } from "./uses/retry.js"
import { RouteUse } from "./uses/route.js"
import { ScreenUse } from "./uses/screen.js"
import { SkillsUse } from "./uses/skills.js"
import { ToolUse } from "./uses/tool.js"

/** Every built-in use. Adding one is a new module here; none of them knows about the others. */
export const all = [
  ApproveUse.Use,
  ScreenUse.Use,
  SkillsUse.Use,
  ToolUse.Use,
  ClaimsUse.Use,
  RetryUse.Use,
  EffortUse.Use,
  GuardUse.Use,
  RouteUse.Use,
] as const
