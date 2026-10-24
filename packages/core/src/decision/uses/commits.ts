export * as CommitsUse from "./commits.js"

import { AppProcess } from "@opencode/util/process"
import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import { Location } from "../../location.js"
import { gitExecutable } from "../../util/git-executable.js"
import { DecisionActions } from "../actions.js"
import { DecisionBlocks } from "../blocks.js"
import { DecisionText } from "../text.js"
import { DecisionUse } from "../use.js"
import { ScopeUse } from "./scope.js"

/**
 * Before the agent runs `git commit`, the files the commit will carry (staged, or every changed file with `-a`) are
 * judged against the user's request, with the same question as scope and the agent's own change text where it made
 * one. If some look unrelated, the commit is rejected with their names, so the agent commits only the related files or
 * asks the user.
 */

const COMMIT = /\bgit\s+(-[a-zA-Z]\s+\S+\s+)*commit\b/

export const isCommit = (command: string) => COMMIT.test(command)

/** Whether the commit takes every changed tracked file (`-a`, `--all`, `-am`) rather than only staged ones. */
export const commitsAll = (command: string) => /\bcommit\b[^|;&]*(\s--all\b|\s-[a-zA-Z]*a[a-zA-Z]*\b)/.test(command)

/** Paths named after `git commit` (a path-limited commit), skipping options and the values of -m, -F, -C and similar. */
export function commitPaths(command: string) {
  const args = command.match(/\bcommit\b([^&|;]*)/)?.[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const valued = new Set(["-m", "--message", "-F", "--file", "-C", "-c", "--author", "--date", "-t", "--template"])
  return args.filter((arg, i) => !arg.startsWith("-") && !valued.has(args[i - 1] ?? "") && !/^["']/.test(arg) && arg !== "--")
}

/** The part of a multi-file patch that belongs to one file. */
export function patchOf(patch: string, file: string) {
  return (
    patch
      .split(/^(?=diff --git )/m)
      .find((section) => section.startsWith(`diff --git a/${file} `))
      ?.slice(0, 1_500) ?? ""
  )
}

/** Paths a `git add` in the same command stages, e.g. `git add a.js b.js && git commit`; `.` and `-A` mean everything. */
export function addedPaths(command: string) {
  return [...command.matchAll(/\bgit\s+add\s+([^&|;]+)/g)]
    .flatMap((match) => (match[1] ?? "").trim().split(/\s+/))
    .filter((arg) => arg.length > 0 && !arg.startsWith("-") && arg !== ".")
}

export const Use = DecisionUse.define({
  id: "commits",
  title: "Check commits",
  description: "Before the agent commits, stop it from including changes unrelated to the request",
  threshold: 0.8,
  setup: (ctx, kit) =>
    Effect.gen(function* () {
      const proc = yield* AppProcess.Service
      const location = yield* Location.Service
      const git = (args: string[]) =>
        proc
          .run(ChildProcess.make(gitExecutable(), args, { cwd: location.directory, stdin: "ignore" }))
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8") : "")),
            Effect.orElseSucceed(() => ""),
          )
      // The diff of what the commit will carry: named paths and -a against HEAD, otherwise the staged changes.
      const carried = (base: string[], paths: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const names = (yield* git(["diff", ...base, "--name-only", "--", ...paths])).split("\n").filter(Boolean)
          const patch = yield* git(["diff", ...base, "--no-color", "-U2", "--", ...paths])
          return names.map((name) => ({ path: name, change: patchOf(patch, name) }))
        })
      yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const settings = kit.settings()
        const command = DecisionText.field(DecisionText.toJson(event.input), "command")
        if (!settings || event.tool !== "shell" || typeof command !== "string" || !isCommit(command)) return
        const state = kit.session(event.sessionID)
        if (!state.userRequest) return
        // This runs before the command, so paths a `git add` in it will stage are taken from the command itself.
        const named = commitPaths(command)
        const added = addedPaths(command)
        const changes =
          named.length > 0 || commitsAll(command) || added.length > 0
            ? yield* carried(["HEAD"], named.length > 0 ? named : added)
            : yield* carried(["--cached"], [])
        if (changes.length === 0) return
        const room = Math.floor(DecisionText.budget(kit.limit(), 0.6) / changes.length)
        const picked = yield* DecisionBlocks.select(kit, {
          state: {
            user_request: DecisionText.clip(state.userRequest, 1_500),
            commit_command: DecisionText.clip(command, 300),
            changes: changes.map((change) => ({ path: change.path, change: DecisionText.clip(change.change, room) })),
          },
          items: changes,
          question: ScopeUse.question,
          threshold: settings.threshold,
        })
        const unrelated = (picked.chosen ?? []).map((change) => change.path)
        yield* kit.log({
          files: changes.length,
          unrelated: unrelated.join(","),
          ...(picked.result ? { ms: picked.result.ms, ...DecisionText.outcome(picked.result) } : {}),
        })
        if (unrelated.length === 0) return
        return yield* DecisionActions.reject(
          `this commit would include changes that look unrelated to the user's request: ${unrelated.join(", ")}. Commit only the related files, or ask the user whether these belong in it.`,
        )
      }),
      )
    }),
})
