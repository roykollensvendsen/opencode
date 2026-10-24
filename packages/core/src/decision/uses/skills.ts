export * as SkillsUse from "./skills.js"

import { Message, type SystemPart } from "@opencode/ai"
import { Effect } from "effect"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * The skill list the model sees is cut to the skills relevant to the Session's first request. The choice is made once
 * per Session so the prompt prefix stays stable; if it cannot be made, every skill stays.
 */

const SKILL = /  <skill>\n    <id>([^<]*)<\/id>\n    <name>[^<]*<\/name>\n    <description>([^]*?)<\/description>\n  <\/skill>\n?/g

/** Skills listed in `<available_skills>` blocks of the system parts or messages, by ID. */
export function listed(system: ReadonlyArray<SystemPart>, messages: ReadonlyArray<Message>) {
  const found = new Map(
    [
      ...system.map((part) => part.text),
      ...messages.flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))),
    ]
      .filter((text) => text.includes("<available_skills>"))
      .flatMap((text) => [...text.matchAll(SKILL)].map((match) => [match[1] ?? "", match[2] ?? ""] as const)),
  )
  return [...found].map(([id, description]) => ({ id, description }))
}

/** Removes every listed skill not in `keep`, leaving the rest of the text as it was. */
export function filter(text: string, keep: ReadonlySet<string>) {
  if (!text.includes("<available_skills>")) return text
  return text.replace(SKILL, (block, id: string) => (keep.has(id) ? block : ""))
}

export const Use = DecisionUse.define({
  id: "skills",
  threshold: 0.5,
  setup: (ctx, kit) =>
    ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const state = kit.session(event.sessionID)
        if (!settings || !state.userRequest) return
        const chosen = state.skills ?? (yield* choose(kit, listed(event.system, event.messages), state.userRequest, settings.threshold))
        if (chosen === undefined) return
        state.skills = chosen
        if (chosen === "all") return
        event.system = event.system.map((part) => ({ ...part, text: filter(part.text, chosen) }))
        event.messages = event.messages.map((message) =>
          message.content.some((part) => part.type === "text" && part.text.includes("<available_skills>"))
            ? new Message({
                ...message,
                content: message.content.map((part) => (part.type === "text" ? { ...part, text: filter(part.text, chosen) } : part)),
              })
            : message,
        )
      }),
    ),
})

const choose = Effect.fnUntraced(function* (
  kit: DecisionUse.Kit,
  skills: ReadonlyArray<{ readonly id: string; readonly description: string }>,
  request: string,
  threshold: number,
) {
  if (skills.length === 0) return undefined
  const picked = yield* DecisionBlocks.select(kit, {
    state: { user_message: request },
    items: skills,
    question: (skill) => ({
      instructions: `Will the "${skill.id}" skill (${skill.description}) be useful for handling this request?`,
    }),
    threshold,
  })
  const result = picked.result
  const chosen: ReadonlySet<string> | "all" = picked.chosen ? new Set(picked.chosen.map((skill) => skill.id)) : "all"
  yield* kit.log({
    offered: skills.map((skill) => skill.id).join(","),
    kept: chosen === "all" ? "all" : [...chosen].join(","),
    ...(result ? { ms: result.ms, ...DecisionText.outcome(result) } : {}),
  })
  return chosen
})
