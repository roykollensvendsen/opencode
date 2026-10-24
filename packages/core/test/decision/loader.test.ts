import { describe, expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Decision } from "@opencode/core/decision"
import { DecisionStatus } from "@opencode/core/decision/status"
import { DecisionTurn } from "@opencode/core/decision/turn"
import { DecisionPlugin } from "@opencode/core/plugin/decision"
import { Document } from "@opencode/schema/config"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { assistant, rig, services, text, toolPart, user } from "./rig"

const document = (decision: unknown) => Schema.decodeUnknownSync(Document)({ type: "document", info: { decision } })

/** A Decision service whose model always answers yes, recording the purposes it is asked for. */
const decision = (overrides: Decision.Overrides, asked: string[], listed: ReadonlyArray<string> = []) => {
  const sessions = new Map<string, Decision.SessionState>()
  return Layer.mock(Decision.Service, {
    ask: (input) =>
      Effect.sync((): Decision.Result => {
        asked.push(input.purpose)
        return {
          status: "ok",
          purpose: input.purpose,
          model: input.model,
          answers: Object.fromEntries(
            Object.keys(input.questions).map((id) => [id, { type: "boolean", probability: 0.99 }]),
          ),
          inputTokens: 1,
          requests: 1,
          ms: 1,
          cached: false,
        }
      }),
    session: (id) => {
      const found = sessions.get(id)
      if (found) return found
      const created: Decision.SessionState = { flags: [], claimNotes: 0, recentCalls: [], noted: new Set(), topic: 0 }
      sessions.set(id, created)
      return created
    },
    controls: { current: () => overrides, set: () => Effect.die("unused"), changes: Stream.empty },
    last: (purpose) =>
      purpose === "approval" ? { status: "unavailable", reason: "deadline", ms: 3000, at: 1 } : undefined,
    models: () => Effect.succeed(listed),
  })
}

const config = (value: unknown) =>
  Layer.mock(Config.Service, { entries: () => Effect.succeed([document(value)]), changes: () => Stream.empty })

const it = testEffect(services)

/**
 * Runs the loader. Its type asks for every service an internal plugin may use; the uses only touch the ones the rig's
 * `services` and these tests provide, so the rest are left out on purpose.
 */
const start = (ctx: Parameters<typeof DecisionPlugin.Plugin.effect>[0]) =>
  DecisionPlugin.Plugin.effect(ctx) as Effect.Effect<void, unknown, Config.Service | Decision.Service>

const evaluate = () => ({
  sessionID: "ses_loader",
  action: "shell",
  resources: ["npm test"],
  effect: "ask" as "ask" | "allow",
  source: { type: "tool", messageID: "msg_1", id: "call_1" },
})

describe("loader", () => {
  it.effect("starts enabled uses with config settings and leaves disabled ones idle", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const r = rig()
      yield* start(r.ctx).pipe(
        Effect.provide(
          Layer.merge(
            config({ model: "decisionmodels/reax-1", uses: { approval: { enabled: true } } }),
            decision({ uses: {} }, asked),
          ),
        ),
      )
      expect((yield* r.fire("permission.evaluate", evaluate())).effect).toBe("allow")
      expect(asked).toEqual(["approval"])
    }),
  )

  it.effect("lets a choice made in the UI win over config, both ways", () =>
    Effect.gen(function* () {
      const off: string[] = []
      const r = rig()
      yield* start(r.ctx).pipe(
        Effect.provide(
          Layer.merge(
            config({ model: "decisionmodels/reax-1", uses: { approval: { enabled: true } } }),
            decision({ uses: { approval: false } }, off),
          ),
        ),
      )
      expect((yield* r.fire("permission.evaluate", evaluate())).effect).toBe("ask")
      expect(off).toEqual([])

      const on: string[] = []
      const s = rig()
      yield* start(s.ctx).pipe(
        Effect.provide(
          Layer.merge(config({ uses: {} }), decision({ model: "decisionmodels/reax-1", uses: { approval: true } }, on)),
        ),
      )
      expect((yield* s.fire("permission.evaluate", evaluate())).effect).toBe("allow")
    }),
  )

  it.effect("does nothing without a model, even with uses enabled", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const r = rig()
      yield* start(r.ctx).pipe(
        Effect.provide(Layer.merge(config({ uses: { approval: { enabled: true } } }), decision({ uses: {} }, asked))),
      )
      expect((yield* r.fire("permission.evaluate", evaluate())).effect).toBe("ask")
      expect(asked).toEqual([])
    }),
  )

  it.effect("records the user's latest request for every use", () =>
    Effect.gen(function* () {
      const r = rig()
      yield* start(r.ctx)
      const { Message } = yield* Effect.promise(() => import("@opencode/ai"))
      yield* r.fire("session.context", {
        sessionID: "ses_loader",
        system: [],
        messages: [new Message({ role: "user", content: [{ type: "text", text: "fix the cart" }] })],
        tools: {},
        options: {},
      })
      const service = yield* Decision.Service
      expect(service.session("ses_loader").userRequest).toBe("fix the cart")
    }).pipe(Effect.provide(Layer.merge(config({ model: "x/y" }), decision({ uses: {} }, [])))),
  )
})

describe("status", () => {
  it.effect("reports each use's setting and where it comes from, plus its last outcome", () =>
    Effect.gen(function* () {
      const status = yield* DecisionStatus.current()
      expect(status.model).toBe("decisionmodels/s1-pro")
      expect(status.modelSource).toBe("override")
      const byId = Object.fromEntries(status.uses.map((use) => [use.id, use]))
      expect(byId.approval).toMatchObject({ enabled: false, source: "override", last: { reason: "deadline" } })
      expect(byId.guard).toMatchObject({ enabled: true, source: "config", threshold: 0.8 })
      expect(byId.routing).toMatchObject({ enabled: false, source: "default", threshold: 0.9 })
      expect(byId.guard?.title).toBe("Guard tests and checks")
    }).pipe(
      Effect.provide(
        Layer.merge(
          config({
            model: "decisionmodels/reax-1",
            uses: { approval: { enabled: true }, guard: { enabled: true, threshold: 0.8 } },
          }),
          decision({ model: "decisionmodels/s1-pro", uses: { approval: false } }, []),
        ),
      ),
    ),
  )
})

describe("status models", () => {
  it.effect("lists the chosen model's provider's decision models, and none without a model", () =>
    Effect.gen(function* () {
      expect(yield* DecisionStatus.models()).toEqual(["decisionmodels/reax-1", "decisionmodels/s1-pro"])
      expect(yield* DecisionStatus.models("verathos")).toEqual(["verathos/reax-1", "verathos/s1-pro"])
    }).pipe(
      Effect.provide(
        Layer.merge(config({ model: "decisionmodels/reax-1" }), decision({ uses: {} }, [], ["reax-1", "s1-pro"])),
      ),
    ),
  )

  it.effect("is empty when nothing picks a provider", () =>
    Effect.gen(function* () {
      const status = yield* DecisionStatus.current()
      expect({ source: status.modelSource, models: yield* DecisionStatus.models() }).toEqual({
        source: "none",
        models: [],
      })
    }).pipe(Effect.provide(Layer.merge(config({}), decision({ uses: {} }, [], ["x"])))),
  )
})

describe("turn summary", () => {
  const messages = [
    user("an earlier request"),
    assistant([toolPart("edit", { filePath: "/w/old.ts", oldString: "a", newString: "b" }, "ok")]),
    user("fix the cart total"),
    assistant([
      text("Looking at it."),
      toolPart("read", { filePath: "/w/src/cart.ts" }, "export const total = …"),
      toolPart("edit", { filePath: "/w/src/cart.ts", oldString: "sum + d", newString: "sum - d" }, "ok"),
      toolPart("write", { filePath: "/w/notes.md", content: "notes" }, "ok"),
      toolPart("shell", { command: "npm test" }, "1 pass"),
      toolPart("shell", { command: "npm run lint" }, "lint failed", "error"),
      text("Fixed; tests pass."),
    ]),
  ]

  it.effect("reads the latest request, final text, calls, last shell call and edits", () =>
    Effect.sync(() => {
      const turn = DecisionTurn.summary(messages)
      expect(turn.request).toBe("fix the cart total")
      expect(turn.final).toBe("Fixed; tests pass.")
      expect(turn.calls.map((call) => `${call.name}:${call.status}`)).toEqual([
        "read:completed",
        "edit:completed",
        "write:completed",
        "shell:completed",
        "shell:error",
      ])
      expect(turn.lastShell?.target).toBe("npm test")
      expect(turn.edited).toEqual(["/w/src/cart.ts", "/w/notes.md"])
      expect(turn.changes.map((change) => change.change)).toEqual(["- sum + d\n+ sum - d", "+ notes"])
    }),
  )

  it.effect("reads changes for the whole Session or only the current turn", () =>
    Effect.sync(() => {
      expect(DecisionTurn.changes(messages, "turn").map((change) => change.path)).toEqual([
        "/w/src/cart.ts",
        "/w/notes.md",
      ])
      expect(DecisionTurn.changes(messages, "session").map((change) => change.path)).toEqual([
        "/w/old.ts",
        "/w/src/cart.ts",
        "/w/notes.md",
      ])
      expect(DecisionTurn.summary([]).request).toBeUndefined()
    }),
  )
})
