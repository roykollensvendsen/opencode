export * as DecisionTurn from "./turn.js"

import type { SessionMessage } from "../session/message.js"
import { DecisionText } from "./text.js"

/**
 * A short summary of the current turn, built from the Session's messages: everything after the latest user message.
 * Several uses judge the same turn (claims, done, stuck, todos, scope), so they share this builder instead of each
 * reading history its own way.
 */

export interface ToolCall {
  readonly name: string
  /** The path, URL or command the call worked on. */
  readonly target: string
  readonly status: "completed" | "error" | "running"
  /** The end of the call's output, clipped. */
  readonly output: string
}

export interface Summary {
  readonly request: string | undefined
  /** The agent's last text in the turn. */
  readonly final: string | undefined
  readonly calls: ReadonlyArray<ToolCall>
  /** The last completed shell call. */
  readonly lastShell: ToolCall | undefined
  /** Paths of files the turn edited or wrote. */
  readonly edited: ReadonlyArray<string>
  /** Each edit, write or patch with a short text of what changed. */
  readonly changes: ReadonlyArray<{ readonly path: string; readonly change: string }>
}

/** Edits, writes and patches with a short text of what changed, for the whole Session or since the last request. */
export function changes(messages: ReadonlyArray<SessionMessage.Info>, scope: "turn" | "session" = "turn") {
  const start = scope === "turn" ? messages.findLastIndex((message) => message.type === "user") : -1
  return changesOf(messages.slice(start + 1).flatMap((message) => (message.type === "assistant" ? message.content : [])))
}

export function summary(messages: ReadonlyArray<SessionMessage.Info>, outputChars = 600): Summary {
  const start = messages.findLastIndex((message) => message.type === "user")
  const user = messages[start]
  const parts = messages.slice(start + 1).flatMap((message) => (message.type === "assistant" ? message.content : []))
  const calls = parts.flatMap((part): ToolCall[] =>
    part.type === "tool" && part.state.status !== "streaming"
      ? [
          {
            name: part.name,
            target: DecisionText.sourceOf(part.name, part.state.input),
            status: part.state.status === "completed" ? "completed" : part.state.status === "error" ? "error" : "running",
            output:
              part.state.status === "completed" || part.state.status === "error"
                ? DecisionText.contentText(part.state.content).slice(-outputChars)
                : "",
          },
        ]
      : [],
  )
  return {
    changes: changesOf(parts),
    request: user?.type === "user" ? user.text.slice(0, 4_000) : undefined,
    final: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).at(-1)?.slice(-4_000),
    calls,
    lastShell: calls.findLast((call) => call.name === "shell" && call.status === "completed"),
    edited: [...new Set(calls.filter((call) => ["edit", "write", "patch"].includes(call.name)).map((call) => call.target))],
  }
}

function changesOf(parts: ReadonlyArray<Extract<SessionMessage.Info, { type: "assistant" }>["content"][number]>) {
  return parts.flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "completed" || !["edit", "write", "patch"].includes(part.name)) return []
    const input = DecisionText.toJson(part.state.input)
    const text = (key: string) => {
      const value = DecisionText.field(input, key)
      return typeof value === "string" ? value : ""
    }
    const change =
      part.name === "edit"
        ? `- ${text("oldString")}\n+ ${text("newString")}`
        : part.name === "write"
          ? `+ ${text("content")}`
          : text("patch") || text("input")
    return [{ path: DecisionText.sourceOf(part.name, part.state.input), change: DecisionText.clip(change, 800) }]
  })
}
