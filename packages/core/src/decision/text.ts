export * as DecisionText from "./text.js"

import { Option, Schema } from "effect"
import type { Decision } from "../decision.js"

/** Helpers the uses share for turning hook data into state a decision model can read. */

export const toJson = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(value))

export function field(value: Schema.Json | undefined, key: string) {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.entries(value).find((entry) => entry[0] === key)?.[1]
}

export function contentText(content: unknown) {
  return Array.isArray(content)
    ? content.flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
    : ""
}

export function resultText(result: { readonly output?: unknown; readonly content?: unknown }) {
  if (typeof result.content === "string") return result.content
  if (Array.isArray(result.content)) return contentText(result.content)
  if (typeof result.output === "string") return result.output
  return result.output === undefined ? "" : JSON.stringify(result.output)
}

export function prepend<R extends { readonly content?: unknown }>(result: R, note: string): R {
  if (typeof result.content === "string") return { ...result, content: `${note}\n\n${result.content}` }
  if (Array.isArray(result.content)) return { ...result, content: [{ type: "text", text: note }, ...result.content] }
  return { ...result, content: note }
}

/**
 * Shortens text to `max` characters, keeping its start and end, which carry most of the meaning in code, diffs and
 * logs, with a marker saying how much was left out.
 */
export function clip(text: string, max: number) {
  if (text.length <= max) return text
  const keep = Math.max(0, max - 40)
  const head = Math.ceil(keep * 0.6)
  return `${text.slice(0, head)}\n[… ${text.length - keep} characters left out …]\n${text.slice(text.length - (keep - head))}`
}

/** Characters of free text that fit in `share` of a model's token limit, at the estimate's 3.5 characters a token. */
export const budget = (limit: number, share: number) => Math.floor(limit * share * 3.5)

/** Path, URL or command a tool call worked on, for naming where a result came from. */
export function sourceOf(tool: string, input: unknown) {
  const record = toJson(input)
  const value =
    field(record, "filePath") ??
    field(record, "path") ??
    field(record, "url") ??
    field(record, "command") ??
    field(record, "pattern") ??
    field(record, "query")
  return typeof value === "string" ? value.slice(0, 300) : tool
}

/** The fields worth logging about a result: why it was unavailable, or which model version answered. */
export const outcome = (result: Decision.Result) =>
  result.status === "unavailable"
    ? { reason: result.reason, ...(result.message ? { message: result.message.slice(0, 200) } : {}) }
    : { version: result.version }
