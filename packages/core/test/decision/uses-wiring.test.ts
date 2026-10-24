import { describe, expect } from "bun:test"
import { type Message, SystemPart } from "@opencode/ai"
import { DecisionUses } from "@opencode/core/decision/uses"
import { ApprovalUse } from "@opencode/core/decision/uses/approval"
import { ClaimsUse } from "@opencode/core/decision/uses/claims"
import { CommitsUse } from "@opencode/core/decision/uses/commits"
import { CompactionUse } from "@opencode/core/decision/uses/compaction"
import { CompletionUse } from "@opencode/core/decision/uses/completion"
import { DecideUse } from "@opencode/core/decision/uses/decide"
import { EffortUse } from "@opencode/core/decision/uses/effort"
import { FallbackUse } from "@opencode/core/decision/uses/fallback"
import { FlakyUse } from "@opencode/core/decision/uses/flaky"
import { FrustrationUse } from "@opencode/core/decision/uses/frustration"
import { GuardUse } from "@opencode/core/decision/uses/guard"
import { HistoryUse } from "@opencode/core/decision/uses/history"
import { ModelsUse } from "@opencode/core/decision/uses/models"
import { OutputUse } from "@opencode/core/decision/uses/output"
import { QuestionsUse } from "@opencode/core/decision/uses/questions"
import { ReadingUse } from "@opencode/core/decision/uses/reading"
import { RetriesUse } from "@opencode/core/decision/uses/retries"
import { RoutingUse } from "@opencode/core/decision/uses/routing"
import { ScopeUse } from "@opencode/core/decision/uses/scope"
import { ScreeningUse } from "@opencode/core/decision/uses/screening"
import { ScreensUse } from "@opencode/core/decision/uses/screens"
import { SearchUse } from "@opencode/core/decision/uses/search"
import { SkillsUse } from "@opencode/core/decision/uses/skills"
import { StuckUse } from "@opencode/core/decision/uses/stuck"
import { TestingUse } from "@opencode/core/decision/uses/testing"
import { TodosUse } from "@opencode/core/decision/uses/todos"
import { ToolsUse } from "@opencode/core/decision/uses/tools"
import { TopicsUse } from "@opencode/core/decision/uses/topics"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { assistant, git, rig, services, setup, text, toolPart, user } from "./rig"

const it = testEffect(services)
const sessionID = "ses_test"
const yes =
  (when: RegExp, p = 0.95, otherwise = 0.05) =>
  (question: string) =>
    when.test(question) ? p : otherwise

const afterTool = (tool: string, input: Record<string, unknown>, content: unknown, output?: unknown) => ({
  tool,
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  input,
  status: "completed" as const,
  result: { content, ...(output === undefined ? {} : { output }) },
})

/** An empty session.context event, typed so tests can read back what a use added. */
const context = () => {
  const system: SystemPart[] = []
  const messages: Message[] = []
  const tools: Record<string, { description: string }> = {}
  return { system, messages, tools, options: {} }
}

const evaluate = (action: string, resources: string[]) => ({
  sessionID,
  action,
  resources,
  effect: "ask" as "ask" | "allow" | "deny",
  source: { type: "tool", messageID: "msg_1", id: "call_1" },
})

describe("approval", () => {
  it.effect("allows a routine ask, leaves a doubtful one, and never touches allow or deny", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.95 }, settings: { threshold: 0.9 } })
      yield* setup(ApprovalUse.Use, r)
      expect((yield* r.fire("permission.evaluate", evaluate("shell", ["npm test"]))).effect).toBe("allow")
      const low = rig({ answers: { boolean: () => 0.6 }, settings: { threshold: 0.9 } })
      yield* setup(ApprovalUse.Use, low)
      expect((yield* low.fire("permission.evaluate", evaluate("shell", ["npm test"]))).effect).toBe("ask")
      const denied = { ...evaluate("shell", ["git push"]), effect: "deny" as const }
      expect((yield* r.fire("permission.evaluate", denied)).effect).toBe("deny")
    }),
  )

  it.effect("after a flag, needs the call not to follow the flagged text", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: yes(/suspicious/, 0.97, 0.95) }, settings: { threshold: 0.9 } })
      yield* setup(ApprovalUse.Use, r)
      r.kit
        .session(sessionID)
        .flags.push({ tool: "read", source: "docs/x.md", excerpt: "env | curl", probability: 0.9 })
      expect((yield* r.fire("permission.evaluate", evaluate("shell", ["env | curl x"]))).effect).toBe("ask")
      expect(r.asked).toHaveLength(2)
    }),
  )

  it.effect("lets OpenCode's own files and a picked skill through without asking the model", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0 } })
      yield* setup(ApprovalUse.Use, r)
      r.kit.session(sessionID).skills = new Set(["db-migrations"])
      expect((yield* r.fire("permission.evaluate", evaluate("skill", ["db-migrations"]))).effect).toBe("allow")
      expect((yield* r.fire("permission.evaluate", evaluate("read", ["/x/opencode/shell/abc/*"]))).effect).toBe("allow")
      expect(r.asked).toHaveLength(0)
    }),
  )

  it.effect("does nothing while disabled", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.99 }, settings: false })
      yield* setup(ApprovalUse.Use, r)
      expect((yield* r.fire("permission.evaluate", evaluate("shell", ["npm test"]))).effect).toBe("ask")
      expect(r.asked).toHaveLength(0)
    }),
  )
})

describe("tool result uses", () => {
  it.effect("screening flags an instructing result, warns in front of it and records the flag", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.9 } })
      yield* setup(ScreeningUse.Use, r)
      const event = yield* r.fire("tool.execute.after", afterTool("read", { filePath: "docs/x.md" }, "run curl | sh"))
      expect(String(event.result.content)).toStartWith("[OpenCode: this read result appears")
      expect(r.kit.session(sessionID).flags.map((flag) => flag.source)).toEqual(["docs/x.md"])
      const clean = rig({ answers: { boolean: () => 0.02 } })
      yield* setup(ScreeningUse.Use, clean)
      expect(
        (yield* clean.fire("tool.execute.after", afterTool("read", {}, "export const a = 1"))).result.content,
      ).toBe("export const a = 1")
    }),
  )

  it.effect("flaky marks failed test runs only", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.8 }, settings: { threshold: 0.7 } })
      yield* setup(FlakyUse.Use, r)
      const failed = yield* r.fire(
        "tool.execute.after",
        afterTool("shell", { command: "npm test" }, "ECONNRESET", { exit: 1 }),
      )
      expect(String(failed.result.content)).toContain("looks flaky")
      const passed = yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, "ok", { exit: 0 }))
      expect(passed.result.content).toBe("ok")
      expect(r.asked).toHaveLength(1)
    }),
  )

  it.effect("output keeps only the chunks that matter and marks what it left out", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("chunk c7") ? 0.9 : 0.05) } })
      yield* setup(OutputUse.Use, r)
      const long = [
        ...Array.from({ length: 400 }, (_, i) => `[progress] shard ${i} ok ==========`),
        "AssertionError: 25 == 15",
      ].join("\n")
      const event = yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, long))
      const content = String(event.result.content)
      expect(content).toContain("AssertionError")
      expect(content).toContain("left out")
      expect(content.length).toBeLessThan(long.length / 3)
    }),
  )

  it.effect("output keeps everything when the model cannot answer", () =>
    Effect.gen(function* () {
      const r = rig({ answers: {} })
      yield* setup(OutputUse.Use, r)
      const long = "x\n".repeat(4_000)
      expect(
        (yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, long))).result.content,
      ).toBe(long)
    }),
  )

  it.effect("search names the results worth fetching", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("result 2") ? 0.9 : 0.1) } })
      yield* setup(SearchUse.Use, r)
      const output = {
        results: [
          { url: "https://a.example", title: "A" },
          { url: "https://b.example", title: "B" },
          { url: "https://c.example" },
        ],
      }
      const event = yield* r.fire("tool.execute.after", afterTool("websearch", { query: "x" }, "results", output))
      expect(String(event.result.content)).toContain("2 (https://b.example)")
    }),
  )

  it.effect("screens judges a returned screenshot with the vision model and notes an error", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { boolean: () => 0.98 },
        settings: { threshold: 0.7, options: { model: "decisionmodels/s1-vision-2" } },
      })
      yield* setup(ScreensUse.Use, r)
      const shot = "data:image/png;base64,AAAA"
      const event = yield* r.fire(
        "tool.execute.after",
        afterTool("read", { filePath: "a.png" }, [{ type: "file", mime: "image/png", uri: shot }]),
      )
      expect(JSON.stringify(event.result.content)).toContain("appears to show an error")
      expect(r.asked[0]).toMatchObject({ model: "decisionmodels/s1-vision-2", images: [shot] })
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "is this ok?", files: [{ uri: shot }] } })
      expect(r.notes.map((note) => note.text).join()).toContain("screenshot the user attached")
    }),
  )

  it.effect("stuck notes a loop once, after repeated calls", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.9 }, settings: { threshold: 0.7 } })
      yield* setup(StuckUse.Use, r)
      const state = r.kit.session(sessionID)
      for (let i = 0; i < 4; i++)
        state.recentCalls.push({ name: "shell", target: "npm test", status: "completed", output: "fail" })
      yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, "fail"))
      yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, "fail"))
      expect(r.notes).toHaveLength(1)
    }),
  )

  it.effect("todos notes an in-progress item the recent calls show done", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.9 }, settings: { threshold: 0.8 } })
      yield* setup(TodosUse.Use, r)
      yield* r.fire(
        "tool.execute.after",
        afterTool("todowrite", { todos: [{ content: "fix cart", status: "in_progress" }] }, "ok"),
      )
      yield* r.fire("tool.execute.after", afterTool("edit", { filePath: "cart.ts" }, "edited"))
      expect(r.notes.map((note) => note.text).join()).toContain('"fix cart"')
    }),
  )

  it.effect("testing names the tests for an edited source file, once per file", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("cart.test") ? 0.9 : 0.1) } })
      yield* setup(TestingUse.Use, r)
      const event = yield* r.fire("tool.execute.after", afterTool("edit", { filePath: "src/cart.ts" }, "edited"))
      expect(String(event.result.content)).toContain("test/cart.test.ts")
      expect(String(event.result.content)).not.toContain("auth.test")
      yield* r.fire("tool.execute.after", afterTool("edit", { filePath: "src/cart.ts" }, "edited"))
      expect(r.asked).toHaveLength(1)
    }),
  )
})

describe("before a tool runs", () => {
  it.effect("guard rejects an edit that weakens a check and passes a real fix", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.97 }, settings: { threshold: 0.7 } })
      yield* setup(GuardUse.Use, r)
      const exit = yield* r
        .fire("tool.execute.before", {
          tool: "edit",
          sessionID,
          input: { filePath: "a.test.ts", newString: "assert.ok(true)" },
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const pass = rig({ answers: { boolean: () => 0.03 }, settings: { threshold: 0.7 } })
      yield* setup(GuardUse.Use, pass)
      expect(
        (yield* pass
          .fire("tool.execute.before", { tool: "edit", sessionID, input: { filePath: "a.ts" } })
          .pipe(Effect.exit))._tag,
      ).toBe("Success")
    }),
  )

  it.effect("questions rejects a question the user's messages already answer", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { boolean: () => 0.95 },
        settings: { threshold: 0.8 },
        messages: [user("Use pnpm, never npm.")],
      })
      yield* setup(QuestionsUse.Use, r)
      const exit = yield* r
        .fire("tool.execute.before", {
          tool: "question",
          sessionID,
          input: { questions: [{ question: "npm or pnpm?" }] },
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("commits judges what the commit carries and rejects unrelated files", () =>
    Effect.gen(function* () {
      git.names = ["src/cart.ts", "README.md"]
      git.patch =
        "diff --git a/src/cart.ts b/src/cart.ts\n-  +\n+  -\ndiff --git a/README.md b/README.md\n+newsletter banner\n"
      const r = rig({
        answers: { boolean: (question) => (question.includes("README.md") ? 0.99 : 0.04) },
        settings: { threshold: 0.8 },
      })
      yield* setup(CommitsUse.Use, r)
      r.kit.session(sessionID).userRequest = "fix the cart total"
      const exit = yield* r
        .fire("tool.execute.before", { tool: "shell", sessionID, input: { command: "git commit -m fix" } })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("README.md")
      git.names = ["src/cart.ts"]
      expect(
        (yield* r
          .fire("tool.execute.before", {
            tool: "shell",
            sessionID,
            input: { command: "git commit src/cart.ts -m fix" },
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Success")
    }),
  )
})

describe("prompt and context uses", () => {
  it.effect("skills cuts the skill list to the picked skills, once per topic", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("db-migrations") ? 0.9 : 0.1) } })
      yield* setup(SkillsUse.Use, r)
      r.kit.session(sessionID).userRequest = "add an index"
      const skill = (id: string) =>
        `  <skill>\n    <id>${id}</id>\n    <name>${id}</name>\n    <description>${id} things</description>\n  </skill>`
      const block = ["<available_skills>", skill("pdf"), skill("db-migrations"), "</available_skills>"].join("\n")
      const event = yield* r.fire("session.context", {
        sessionID,
        system: [SystemPart.make(block)],
        messages: [],
        tools: {},
        options: {},
      })
      expect(event.system[0]?.text).toContain("<id>db-migrations</id>")
      expect(event.system[0]?.text).not.toContain("<id>pdf</id>")
    }),
  )

  it.effect("frustration adds a system note while the user is frustrated", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.97 }, settings: { threshold: 0.7 } })
      yield* setup(FrustrationUse.Use, r)
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "third time, STILL broken" } })
      const event = yield* r.fire("session.context", { sessionID, ...context() })
      expect(event.system.map((part) => part.text).join()).toContain("frustrated")
    }),
  )

  it.effect("effort and models switch the Session's model from the request", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { score: () => 1.9, choice: () => ({ large: 0.9, small: 0.1 }) },
        settings: { threshold: 0.35, options: { small: "engy/small", large: "engy/large" } },
      })
      yield* setup(EffortUse.Use, r)
      yield* setup(ModelsUse.Use, r)
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "audit the race condition" } })
      expect(JSON.stringify(r.switched.model)).toContain('"variant":"high"')
      expect(JSON.stringify(r.switched.model)).toContain('"id":"large"')
    }),
  )

  it.effect("routing sends a large first request to plan", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { choice: () => ({ plan: 0.97, build: 0.03 }) }, settings: { threshold: 0.9 } })
      yield* setup(RoutingUse.Use, r)
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "add billing" } })
      expect(JSON.stringify(r.switched.agent)).toContain("plan")
    }),
  )

  it.effect("routing and history act only on a Session's first request", () =>
    Effect.gen(function* () {
      const answers = { choice: () => ({ plan: 0.99, ses_old: 0.99 }) }
      const later = rig({
        answers,
        settings: { threshold: 0.8 },
        messages: [user("earlier")],
        sessions: [{ id: "ses_old", title: "Old" }],
      })
      yield* setup(RoutingUse.Use, later)
      yield* setup(HistoryUse.Use, later)
      yield* later.fire("session.prompt", { sessionID, prompt: { text: "add billing" } })
      const none = rig({ answers, settings: { threshold: 0.8 } })
      yield* setup(HistoryUse.Use, none)
      yield* none.fire("session.prompt", { sessionID, prompt: { text: "add billing" } })
      expect({
        asked: later.asked.length + none.asked.length,
        agent: later.switched.agent,
        notes: later.notes.length + none.notes.length,
      }).toEqual({ asked: 0, agent: [], notes: 0 })
    }),
  )

  it.effect("history points to the earlier session on the same task", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { choice: () => ({ ses_old: 0.95, none: 0.05 }) },
        settings: { threshold: 0.8 },
        sessions: [{ id: "ses_old", title: "Fix cart total" }],
      })
      yield* setup(HistoryUse.Use, r)
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "the cart total is wrong" } })
      expect(r.notes.map((note) => note.text).join()).toContain("ses_old")
    }),
  )

  it.effect("topics bumps the topic and clears picked skills on a new task, reading history after a restart", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { boolean: () => 0.98 },
        settings: { threshold: 0.7 },
        messages: [user("fix the cart bug")],
      })
      yield* setup(TopicsUse.Use, r)
      const state = r.kit.session(sessionID)
      state.skills = new Set(["x"])
      yield* r.fire("session.prompt", { sessionID, prompt: { text: "now write deploy docs" } })
      expect(state.topic).toBe(1)
      expect(state.skills).toBeUndefined()
      expect(JSON.stringify(r.asked[0]?.state)).toContain("fix the cart bug")
    }),
  )

  it.effect("reading names the likely files in a system note", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("src/cart.ts") ? 0.9 : 0.1) } })
      yield* setup(ReadingUse.Use, r)
      r.kit.session(sessionID).userRequest = "fix the cart total"
      const event = yield* r.fire("session.context", { sessionID, ...context() })
      expect(event.system.map((part) => part.text).join()).toContain("src/cart.ts")
    }),
  )

  it.effect("tools drops unpicked MCP tools and keeps built-in ones", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: (question) => (question.includes("tool3") ? 0.9 : 0.1) } })
      yield* setup(ToolsUse.Use, r)
      r.kit.session(sessionID).userRequest = "use tool3"
      const tools = Object.fromEntries([
        ["read", { description: "read" }],
        ...Array.from({ length: 12 }, (_, i) => [`tool${i}`, { description: `tool ${i}` }]),
      ])
      const event = yield* r.fire("session.context", { sessionID, system: [], messages: [], tools, options: {} })
      expect(Object.keys(event.tools).toSorted()).toEqual(["read", "tool3"])
    }),
  )

  it.effect("compaction stubs stale tool results and keeps the recent ones", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { score: () => 0.2 }, settings: { threshold: 0.75 } })
      yield* setup(CompactionUse.Use, r)
      r.kit.session(sessionID).userRequest = "fix the cart"
      const result = (id: string) => ({
        type: "tool-result" as const,
        id,
        name: "read",
        result: { type: "text" as const, value: `output ${id}` },
      })
      const { Message } = yield* Effect.promise(() => import("@opencode/ai"))
      const messages = ["a", "b", "c", "d", "e"].map((id) => new Message({ role: "tool", content: [result(id)] }))
      const event = yield* r.fire("session.compaction", { sessionID, system: [], messages, tools: {}, options: {} })
      const values = event.messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === "tool-result" ? [String(part.result.value)] : [])),
      )
      expect(values.slice(0, 2).every((value) => value.includes("left out"))).toBe(true)
      expect(values.slice(-3)).toEqual(["output c", "output d", "output e"])
    }),
  )
})

describe("idle and retry uses", () => {
  const messages = [
    user("fix the cart total"),
    assistant([
      toolPart("edit", { filePath: "src/cart.ts", oldString: "+", newString: "-" }, "ok"),
      toolPart("edit", { filePath: "README.md", newString: "ads" }, "ok"),
      toolPart("shell", { command: "npm test" }, "1 fail"),
      text("All tests pass now."),
    ]),
  ]

  it.effect("claims, completion and scope each leave a note when the Session goes idle", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: {
          boolean: (question) => (question.includes("README.md") || question.includes("final message") ? 0.95 : 0.05),
          choice: () => ({ partial: 0.9, done: 0.05, blocked: 0.05 }),
        },
        settings: { threshold: 0.7 },
        messages,
      })
      yield* setup(ClaimsUse.Use, r)
      yield* setup(CompletionUse.Use, r)
      yield* setup(ScopeUse.Use, r)
      yield* r.emit("session.execution.succeeded", sessionID)
      const notes = r.notes.map((note) => note.text).join("\n")
      expect(notes).toContain("npm test")
      expect(notes).toContain("unfinished")
      expect(notes).toContain("README.md")
      expect(notes).not.toContain("src/cart.ts")
    }),
  )

  it.effect("retries stops a permanent error and fallback switches to an allowed model", () =>
    Effect.gen(function* () {
      const r = rig({
        answers: { boolean: () => 0.02, choice: () => ({ "engy/large": 0.9 }) },
        settings: { threshold: 0.6, options: { models: ["engy/large"] } },
      })
      yield* setup(RetriesUse.Use, { ...r, kit: { ...r.kit, settings: () => ({ threshold: 0.9, options: {} }) } })
      yield* setup(FallbackUse.Use, r)
      const event = {
        sessionID,
        model: { providerID: "engy", id: "small" },
        error: { type: "api", message: "invalid key", status: 401 },
        attempt: 1,
        decision: { retry: true, delay: 1000 } as { retry: true; delay: number } | { retry: false },
      }
      yield* r.fire("session.retry", event)
      expect(event.decision).toEqual({ retry: true, delay: 0 })
      expect(JSON.stringify(r.switched.model)).toContain('"id":"large"')
    }),
  )
})

describe("decide tool", () => {
  it.effect("registers decide and returns the model's answers as JSON", () =>
    Effect.gen(function* () {
      const r = rig({ answers: { boolean: () => 0.7 } })
      yield* setup(DecideUse.Use, r)
      expect(r.tools.map((tool) => tool.name)).toEqual(["decide"])
      const result = yield* r.tools[0]!.execute(
        { about: "x", questions: { q: { type: "boolean", instructions: "?" } } } as never,
        {} as never,
      )
      expect(JSON.stringify(result)).toContain("0.7")
    }),
  )
})

describe("every use", () => {
  it.effect("registers nothing that runs while disabled", () =>
    Effect.gen(function* () {
      for (const use of DecisionUses.all) {
        const r = rig({
          answers: { boolean: () => 0.99, score: () => 2, choice: () => ({ plan: 1 }) },
          settings: false,
        })
        yield* setup(use, r)
        yield* r.fire("permission.evaluate", evaluate("shell", ["npm test"]))
        yield* r.fire("tool.execute.after", afterTool("shell", { command: "npm test" }, "x".repeat(8_000), { exit: 1 }))
        yield* r.fire("session.prompt", { sessionID, prompt: { text: "hello" } })
        expect({ use: use.id, asked: r.asked.length, notes: r.notes.length, tools: r.tools.length }).toEqual({
          use: use.id,
          asked: 0,
          notes: 0,
          tools: 0,
        })
      }
    }),
  )
})
