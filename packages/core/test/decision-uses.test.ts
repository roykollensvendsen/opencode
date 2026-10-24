import { describe, expect, test } from "bun:test"
import { SystemPart } from "@opencode/ai"
import { DecisionText } from "@opencode/core/decision/text"
import { ApprovalUse } from "@opencode/core/decision/uses/approval"
import { EffortUse } from "@opencode/core/decision/uses/effort"
import { GuardUse } from "@opencode/core/decision/uses/guard"
import { RetriesUse } from "@opencode/core/decision/uses/retries"
import { RoutingUse } from "@opencode/core/decision/uses/routing"
import { SkillsUse } from "@opencode/core/decision/uses/skills"
import { StuckUse } from "@opencode/core/decision/uses/stuck"
import { FlakyUse } from "@opencode/core/decision/uses/flaky"
import { OutputUse } from "@opencode/core/decision/uses/output"
import { SearchUse } from "@opencode/core/decision/uses/search"
import { TodosUse } from "@opencode/core/decision/uses/todos"
import { ToolsUse } from "@opencode/core/decision/uses/tools"
import { ScreensUse } from "@opencode/core/decision/uses/screens"
import { DecisionFiles } from "@opencode/core/decision/files"
import { CommitsUse } from "@opencode/core/decision/uses/commits"
import { DecisionUses } from "@opencode/core/decision/uses"

describe("decision uses", () => {
  test("every use has a unique ID and a threshold between 0 and 1", () => {
    const ids = DecisionUses.all.map((use) => use.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(DecisionUses.all.every((use) => use.threshold >= 0 && use.threshold <= 1)).toBe(true)
  })

  test("approve allows routine calls, and after a flag only those that do not follow it", () => {
    expect(ApprovalUse.allows({ routine: 0.95, threshold: 0.9, flagged: false, follows: undefined })).toBe(true)
    expect(ApprovalUse.allows({ routine: 0.85, threshold: 0.9, flagged: false, follows: undefined })).toBe(false)
    expect(ApprovalUse.allows({ routine: undefined, threshold: 0.9, flagged: false, follows: undefined })).toBe(false)
    expect(ApprovalUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: 0.04 })).toBe(true)
    expect(ApprovalUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: 0.93 })).toBe(false)
    // A flag check that could not be answered never approves.
    expect(ApprovalUse.allows({ routine: 0.95, threshold: 0.9, flagged: true, follows: undefined })).toBe(false)
  })

  test("approve lets OpenCode's own files and picked skills through without asking", () => {
    expect(ApprovalUse.isOwnPath(["/home/u/.local/share/opencode/shell/abc/*"])).toBe(true)
    expect(ApprovalUse.isOwnPath(["/home/u/.local/share/opencode/shell/abc/*", "/etc/passwd"])).toBe(false)
    expect(ApprovalUse.isOwnPath([])).toBe(false)
    expect(ApprovalUse.isPickedSkill("skill", ["db-migrations"], new Set(["db-migrations"]))).toBe(true)
    expect(ApprovalUse.isPickedSkill("skill", ["pdf"], new Set(["db-migrations"]))).toBe(false)
    expect(ApprovalUse.isPickedSkill("skill", ["pdf"], "all")).toBe(false)
    expect(ApprovalUse.isPickedSkill("edit", ["db-migrations"], new Set(["db-migrations"]))).toBe(false)
  })

  test("retry stops only when a retry is very unlikely to succeed", () => {
    expect(RetriesUse.stops(0.05, 0.9)).toBe(true)
    expect(RetriesUse.stops(0.3, 0.9)).toBe(false)
    expect(RetriesUse.stops(undefined, 0.9)).toBe(false)
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
    expect(RoutingUse.routes({ plan: 0.97, build: 0.03 }, 0.9)).toBe(true)
    expect(RoutingUse.routes({ plan: 0.6, build: 0.4 }, 0.9)).toBe(false)
    expect(RoutingUse.routes(undefined, 0.9)).toBe(false)
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

describe("second batch of uses", () => {
  const call = (name: string, target: string) => ({ name, target, status: "completed" as const, output: "" })

  test("stuck only asks when recent calls repeat the same target", () => {
    expect(StuckUse.repeats([call("shell", "npm test"), call("edit", "a.ts"), call("shell", "npm test"), call("shell", "npm test")])).toBe(true)
    expect(StuckUse.repeats([call("read", "a.ts"), call("read", "b.ts"), call("edit", "a.ts"), call("shell", "npm test")])).toBe(false)
    expect(StuckUse.repeats([call("shell", "npm test"), call("shell", "npm test")])).toBe(false)
  })

  test("flaky only judges failed test runs", () => {
    expect(FlakyUse.isFailedTestRun("npm test", 1)).toBe(true)
    expect(FlakyUse.isFailedTestRun("bun test src/a.test.ts", 1)).toBe(true)
    expect(FlakyUse.isFailedTestRun("npm test", 0)).toBe(false)
    expect(FlakyUse.isFailedTestRun("npm run build", 1)).toBe(false)
    expect(FlakyUse.isFailedTestRun("npm test", undefined)).toBe(false)
  })

  test("output splits on lines and joins kept chunks with one marker per gap", () => {
    const text = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n")
    const chunks = OutputUse.split(text, 8)
    expect(chunks).toHaveLength(8)
    expect(chunks.join("\n")).toBe(text)
    const joined = OutputUse.join(chunks, new Set([0, 5]))
    expect(joined.split("left out").length - 1).toBe(2)
    expect(joined).toContain("line 0")
    expect(joined).toContain("line 10")
    expect(joined).not.toContain("line 4")
  })
})

describe("third batch of uses", () => {
  test("search reads results from the websearch output", () => {
    const found = SearchUse.results({
      provider: "x",
      results: [
        { url: "https://a.example", title: "A", content: "about a" },
        { url: "https://b.example", time: {} },
        { title: "no url" },
      ],
    })
    expect(found).toEqual([
      { index: 0, url: "https://a.example", title: "A", snippet: "about a" },
      { index: 1, url: "https://b.example", title: "https://b.example", snippet: "" },
    ])
    expect(SearchUse.results("nope")).toEqual([])
  })

  test("todos takes only in-progress items from a todowrite input", () => {
    expect(
      TodosUse.inProgress({
        todos: [
          { content: "fix cart", status: "in_progress" },
          { content: "write docs", status: "pending" },
          { content: "run tests", status: "in_progress" },
        ],
      }),
    ).toEqual([{ content: "fix cart" }, { content: "run tests" }])
    expect(TodosUse.inProgress({})).toEqual([])
  })

  test("tools drops only unpicked MCP tools, never built-in ones", () => {
    expect(ToolsUse.dropped(["read", "github_list_prs", "slack_post", "shell"], new Set(["github_list_prs", "slack_post"]), new Set(["slack_post"]))).toEqual(["github_list_prs"])
  })
})

describe("fourth batch of uses", () => {
  test("test files are recognised across common layouts", () => {
    for (const path of ["src/cart.test.ts", "test/cart.js", "pkg/__tests__/a.tsx", "app/spec/user_spec.rb", "svc/handler_test.go", "test_api.py"])
      expect(DecisionFiles.isTest(path)).toBe(true)
    for (const path of ["src/cart.ts", "README.md", "src/testing-utils.ts"]) expect(DecisionFiles.isTest(path)).toBe(false)
    expect(DecisionFiles.top("src/a/b.ts")).toBe("src")
    expect(DecisionFiles.top("README.md")).toBe(".")
  })

  test("screens takes image data URLs from tool content and skips anything else", () => {
    const png = "data:image/png;base64,AAAA"
    expect(
      ScreensUse.images([
        { type: "text", text: "x" },
        { type: "file", mime: "image/png", uri: png },
        { type: "file", mime: "image/png", uri: "file:///tmp/a.png" },
        { type: "file", mime: "application/pdf", uri: "data:application/pdf;base64,AAAA" },
      ]),
    ).toEqual([png])
    expect(ScreensUse.images("no content")).toEqual([])
  })
})

describe("last batch of uses", () => {
  test("commits recognises git commit, also with options before the subcommand", () => {
    expect(CommitsUse.isCommit("git commit -m 'fix'")).toBe(true)
    expect(CommitsUse.isCommit("git -C repo commit -am x")).toBe(true)
    expect(CommitsUse.isCommit("git add . && git commit -m x")).toBe(true)
    expect(CommitsUse.isCommit("git log --oneline")).toBe(false)
    expect(CommitsUse.isCommit("echo commit")).toBe(false)
  })

  test("commits takes the paths a git add in the same command stages", () => {
    expect(CommitsUse.addedPaths("git add cart.js cart.test.js && git commit -m fix")).toEqual(["cart.js", "cart.test.js"])
    expect(CommitsUse.addedPaths("git add -A && git commit -m x")).toEqual([])
    expect(CommitsUse.addedPaths("git commit -m x")).toEqual([])
  })

  test("commits reads the paths of a path-limited commit and splits a patch per file", () => {
    expect(CommitsUse.commitPaths("git commit cart.js -m \"fix the sign\"")).toEqual(["cart.js"])
    expect(CommitsUse.commitPaths("git commit -m 'fix' -- src/a.ts src/b.ts")).toEqual(["src/a.ts", "src/b.ts"])
    expect(CommitsUse.commitPaths("git commit -am 'fix'")).toEqual([])
    const patch = "diff --git a/a.js b/a.js\n+one\ndiff --git a/b.js b/b.js\n+two\n"
    expect(CommitsUse.patchOf(patch, "b.js")).toBe("diff --git a/b.js b/b.js\n+two\n")
    expect(CommitsUse.patchOf(patch, "c.js")).toBe("")
  })

  test("commits tells -a and --all commits from staged-only ones", () => {
    expect(CommitsUse.commitsAll("git commit -am 'fix'")).toBe(true)
    expect(CommitsUse.commitsAll("git commit --all -m x")).toBe(true)
    expect(CommitsUse.commitsAll("git commit -m 'add a thing'")).toBe(false)
    expect(CommitsUse.commitsAll("git add cart.js && git commit -m fix")).toBe(false)
  })

  test("screens takes only image data URLs from prompt attachments", () => {
    expect(ScreensUse.attached([{ uri: "data:image/png;base64,AAAA" }, { uri: "file:///a.png" }])).toEqual(["data:image/png;base64,AAAA"])
    expect(ScreensUse.attached(undefined)).toEqual([])
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

  test("clip keeps the start and end of long text and says how much it left out", () => {
    expect(DecisionText.clip("short", 100)).toBe("short")
    const text = `${"a".repeat(500)}MIDDLE${"z".repeat(500)}`
    const clipped = DecisionText.clip(text, 200)
    expect(clipped.length).toBeLessThanOrEqual(240)
    expect(clipped.startsWith("aaa")).toBe(true)
    expect(clipped.endsWith("zzz")).toBe(true)
    expect(clipped).not.toContain("MIDDLE")
    expect(clipped).toContain("characters left out")
    expect(DecisionText.budget(8_000, 0.5)).toBe(14_000)
  })

  test("resultText and sourceOf read the usual tool shapes", () => {
    expect(DecisionText.resultText({ content: [{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "b" }] })).toBe("a\nb")
    expect(DecisionText.resultText({ output: { ok: true } })).toBe('{"ok":true}')
    expect(DecisionText.sourceOf("read", { filePath: "docs/x.md" })).toBe("docs/x.md")
    expect(DecisionText.sourceOf("shell", { command: "npm test" })).toBe("npm test")
    expect(DecisionText.sourceOf("todo", { items: [] })).toBe("todo")
  })
})
