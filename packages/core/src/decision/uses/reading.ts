export * as ReadingUse from "./reading.js"

import { SystemPart } from "@opencode/ai"
import { Effect } from "effect"
import { DecisionFiles } from "../files.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"

/**
 * On a Session's first request, the project's files are judged for the few most likely to hold the cause or the place
 * to change, and the agent gets a short system note naming them. It is a hint: the agent still reads what it wants.
 * The pick is made once per Session, so the prompt prefix stays stable.
 */

export const question = (path: string) => ({
  instructions: `Should a coding agent read ${path} first to handle this request? Yes only if it is one of the two or three files most likely to hold the cause or the place to change.`,
})

export const note = (files: ReadonlyArray<string>) =>
  `Files most likely to matter for this request, judged from their paths: ${files.join(", ")}. Start there unless you know better.`

export const Use = DecisionUse.define({
  id: "reading",
  title: "Suggest files to read",
  description: "Point the agent at the few files most likely to matter for the first request",
  threshold: 0.5,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const picks = new Map<string, ReadonlyArray<string>>()
      const list = yield* DecisionFiles.lister()
      yield* ctx.session.hook("context", (event) =>
        Effect.gen(function* () {
          const settings = kit.settings()
          const request = kit.session(event.sessionID).userRequest
          if (!settings || !request) return
          const files =
            picks.get(event.sessionID) ??
            (yield* Effect.gen(function* () {
              const picked =
                (yield* DecisionFiles.pick(kit, {
                  request: DecisionText.clip(request, DecisionText.budget(kit.limit(), 0.3)),
                  files: (yield* list()).filter((path) => !DecisionFiles.isTest(path)),
                  question,
                  threshold: settings.threshold,
                  max: 3,
                })) ?? []
              picks.set(event.sessionID, picked)
              yield* kit.log({ files: picked.join(",") || "none" })
              return picked
            }))
          if (files.length === 0) return
          event.system = [...event.system, SystemPart.make(note(files))]
        }),
      )
    }),
})
