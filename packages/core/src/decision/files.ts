export * as DecisionFiles from "./files.js"

import { Effect } from "effect"
import { Location } from "../location.js"
import { Ripgrep } from "../ripgrep.js"
import { DecisionBlocks } from "./blocks.js"
import type { DecisionUse } from "./use.js"

/**
 * The project's files, and a two-step pick of the ones relevant to a request: first the top-level directories, then
 * files inside the chosen ones, so a large repository never turns into hundreds of questions. Shared by the uses that
 * point the agent at files (read-first, test selection).
 */

const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git)\/|\.(lock|map|min\.js|png|jpe?g|gif|svg|ico|woff2?|pdf|zip)$|(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py)$|^test_.*\.py$/

export const isTest = (path: string) => TEST.test(path)

/**
 * A lister of the project's files relative to its directory, without generated, vendored, binary or lock files. Made
 * in a use's setup, where the services are available, and called from its hooks.
 */
export const lister = Effect.fn("DecisionFiles.lister")(function* () {
  const ripgrep = yield* Ripgrep.Service
  const location = yield* Location.Service
  return (limit = 3_000) =>
    ripgrep.glob({ cwd: location.directory, pattern: "**/*", limit }).pipe(
      Effect.map((entries) => entries.map((entry) => String(entry.path)).filter((path) => !SKIP.test(path))),
      Effect.orElseSucceed((): string[] => []),
    )
})

/** The top-level directory of a path, or "." for files at the root. */
export const top = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : ".")

/**
 * Up to `max` files most relevant to `request` among `files`, best first. With more than `cap` files, directories are
 * picked first. Returns undefined when the model could not answer.
 */
export const pick = Effect.fnUntraced(function* (
  kit: DecisionUse.Kit,
  input: {
    readonly request: string
    readonly files: ReadonlyArray<string>
    readonly question: (path: string) => DecisionBlocks.YesNo
    readonly threshold: number
    readonly max: number
    readonly cap?: number
  },
) {
  const cap = input.cap ?? 40
  const narrowed =
    input.files.length <= cap
      ? input.files
      : yield* Effect.gen(function* () {
          const dirs = [...new Set(input.files.map(top))]
          const sample = (dir: string) =>
            input.files
              .filter((path) => top(path) === dir)
              .slice(0, 6)
              .join(", ")
          const chosen = yield* DecisionBlocks.select(kit, {
            state: { request: input.request },
            items: dirs,
            question: (dir) => ({
              instructions: `Is the directory "${dir}" (files such as ${sample(dir)}) likely to hold files a coding agent needs for this request?`,
            }),
            threshold: 0.5,
            max: 4,
          })
          if (!chosen.chosen) return undefined
          const keep = new Set(chosen.chosen)
          return input.files.filter((path) => keep.has(top(path))).toSorted((a, b) => a.split("/").length - b.split("/").length)
        })
  if (!narrowed || narrowed.length === 0) return undefined
  const picked = yield* DecisionBlocks.select(kit, {
    state: { request: input.request },
    items: narrowed.slice(0, cap),
    question: input.question,
    threshold: input.threshold,
    max: input.max,
  })
  return picked.chosen
})
