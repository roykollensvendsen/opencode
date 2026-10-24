import { describe, expect, test } from "bun:test"
import { SystemPart } from "@opencode/ai"
import { DecisionText } from "@opencode/core/decision/text"
import { ApproveUse } from "@opencode/core/decision/uses/approve"
import { EffortUse } from "@opencode/core/decision/uses/effort"
import { GuardUse } from "@opencode/core/decision/uses/guard"
import { RetryUse } from "@opencode/core/decision/uses/retry"
import { RouteUse } from "@opencode/core/decision/uses/route"
import { SkillsUse } from "@opencode/core/decision/uses/skills"
import { DecisionUses } from "@opencode/core/decision/uses"

describe("decision uses", () => {
  test("every use has a unique ID and a threshold between 0 and 1", () => {
    const ids = DecisionUses.all.map((use) => use.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DecisionUses.all.every((use) => use.threshold >= 0 && use.threshold <= 1)).toBe(true)
  })

  test("approve allows routine calls, and after a flag only those that do not follow it", () => {
    expect(ApproveUse.allows({ routine: 0.95, threshold: 0.9, flagged: false, follows: undefined })).toBe(true)
    expect(ApproveUse.allows({ routine: 0.85, threshold: 0.9, flagged: false, follows: undefined })).toBe(false)
    expect(ApproveUse.allows({ routine: undefined, threshold: 0.9, flagged: false, follows: undefined })).toBe(false)
    expect(ApproveUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: 0.04 })).toBe(true)
    expect(ApproveUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: 0.93 })).toBe(false)
    // A flag check that could not be answered never approves.
    expect(ApproveUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: undefined })).toBe(false)
  })

  test("approve lets OpenCode's own files and picked skills through without asking", () => {
    expect(ApproveUse.isOwnPath(["/home/u/.local/share/opencode/shell/abc/*"])).toBe(true)
    expect(ApproveUse.isOwnPath(["/home/u/.local/share/opencode/shell/abc/*", "/etc/passwd"])).toBe(false)
    expect(ApproveUse.isOwnPath([])).toBe(false)
    expect(ApproveUse.isPickedSkill("skill", ["db-migrations"], new Set(["db-migrations"]))).toBe(true)
    expect(ApproveUse.isPickedSkill("skill", ["pdf"], new Set(["db-migrations"]))).toBe(false)
    expect(ApproveUse.isPickedSkill("skill", ["pdf"], "all")).toBe(false)
    expect(ApproveUse.isPickedSkill("edit", ["db-migrations"], new Set(["db-migrations"]))).toBe(false)
  })

  test("retry stops only when a retry is very unlikely to succeed", () => {
    expect(RetryUse.stops(0.05, 0.9)).toBe(true)
    expect(RetryUse.stops(0.3, 0.9)).toBe(false)
    expect(RetryUse.stops(undefined, 0.9)).toBe(false)
  })

  test("effort picks the lowest or highest graded variant and otherwise keeps the base", () => {
    const variants = ["none", "low", "high", "max"]
    expect(EffortUse.pick(variants, undefined, 0.1)).toBe("low")
    expect(EffortUse.pick(variants, undefined, 1.9)).toBe("max")
    expect(EffortUse.pick(variants, "high", 1.0)).toBe("high")
    // Halfway between levels is not acted on.
    expect(EffortUse.pick(variants, "high", 0.5)).toBe("high")
    // Reasoning is never turned off, and a model with one graded variant is left alone.
    expect(EffortUse.pick(["none", "high"], undefined, 0)).toBeUndefined()
  })

  test("route sends a request to plan only above the threshold", () => {
    expect(RouteUse.routes({ plan: 0.97, build: 0.03 }, 0.9)).toBe(true)
    expect(RouteUse.routes({ plan: 0.6, build: 0.4 }, 0.9)).toBe(false)
    expect(RouteUse.routes(undefined, 0.9)).toBe(false)
  })

  test("guard judges edits and file-writing shell commands, not test runs", () => {
    expect(GuardUse.judged("edit", { filePath: "a.ts" })).toBe(true)
    expect(GuardUse.judged("write", { filePath: "a.ts" })).toBe(true)
    expect(GuardUse.judged("shell", { command: "sed -i 's/a/b/' a.test.ts" })).toBe(true)
    expect(GuardUse.judged("shell", { command: "echo x > a.test.ts" })).toBe(true)
    expect(GuardUse.judged("shell", { command: "npm test 2>&1 | tail -20" })).toBe(false)
    expect(GuardUse.judged("read", { filePath: "a.ts" })).toBe(false)
  })

  test("skills lists and filters the skill guidance block", () => {
    const block = [
      "<available_skills>",
      "  <skill>",
      "    <id>pdf</id>",
      "    <name>pdf</name>",
      "    <description>Read PDF files</description>",
      "  </skill>",
      "  <skill>",
      "    <id>db-migrations</id>",
      "    <name>db-migrations</name>",
      "    <description>Write SQL migrations</description>",
      "  </skill>",
      "</available_skills>",
    ].join("\n")
    expect(SkillsUse.listed([SystemPart.make(block)], [])).toEqual([
      { id: "pdf", description: "Read PDF files" },
      { id: "db-migrations", description: "Write SQL migrations" },
    ])
    const kept = SkillsUse.filter(block, new Set(["db-migrations"]))
    expect(kept).toContain("<id>db-migrations</id>")
    expect(kept).not.toContain("<id>pdf</id>")
    expect(SkillsUse.filter("no skills here", new Set())).toBe("no skills here")
  })
})

describe("decision text helpers", () => {
  test("prepend puts a note before string, part and missing content", () => {
    expect(DecisionText.prepend({ content: "body" }, "note").content).toBe("note\n\nbody")
    expect(DecisionText.prepend({ content: [{ type: "text", text: "body" }] }, "note").content).toEqual([
      { type: "text", text: "note" },
      { type: "text", text: "body" },
    ])
    const empty: { readonly content?: string } = {}
    expect(DecisionText.prepend(empty, "note").content).toBe("note")
  })

  test("resultText and sourceOf read the usual tool shapes", () => {
    expect(DecisionText.resultText({ content: [{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }] })).toBe("a\nb")
    expect(DecisionText.resultText({ output: { ok: true } })).toBe('{"ok":true}')
    expect(DecisionText.sourceOf("read", { filePath: "docs/x.md" })).toBe("docs/x.md")
    expect(DecisionText.sourceOf("shell", { command: "npm test" })).toBe("npm test")
    expect(DecisionText.sourceOf("todo", { items: [] })).toBe("todo")
  })
})
