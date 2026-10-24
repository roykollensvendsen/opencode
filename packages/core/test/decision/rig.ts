import type { EvaluationQuestions } from "@opencode/ai/experimental"
import type { Plugin } from "@opencode/plugin/effect"
import { Decision } from "@opencode/core/decision"
import type { DecisionUse } from "@opencode/core/decision/use"
import { SessionMessage } from "@opencode/core/session/message"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode/core/schema"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer, PubSub, Schema, type Scope, Stream } from "effect"
import { host } from "../plugin/host"

/**
 * A test rig for one decision use: a plugin context that records every hook, tool and Session call the use makes,
 * and a kit whose model answers with a fixed probability per question (or is unavailable). Hooks are fired directly,
 * so a test checks the use's wiring (what it reads from an event and what it changes) without a running Session.
 */

type Handler = (event: unknown) => Effect.Effect<void, unknown>

export interface Answers {
  /** The probability for a yes/no question, by question text or id; undefined makes the model unavailable. */
  readonly boolean?: (question: string, id: string) => number | undefined
  readonly choice?: (options: ReadonlyArray<string>) => Readonly<Record<string, number>> | undefined
  readonly score?: () => number | undefined
}

export function rig(
  input: {
    readonly answers?: Answers
    readonly settings?: Partial<DecisionUse.Settings> | false
    readonly messages?: ReadonlyArray<SessionMessage.Info>
    readonly sessions?: ReadonlyArray<{ readonly id: string; readonly title: string }>
  } = {},
) {
  const hooks = new Map<string, Handler[]>()
  const asked: Array<{
    readonly state: unknown
    readonly questions: EvaluationQuestions
    readonly model?: string
    readonly images?: ReadonlyArray<string>
  }> = []
  const notes: Array<{ readonly text: string; readonly resume?: boolean | null }> = []
  const switched: { model: unknown[]; agent: unknown[] } = { model: [], agent: [] }
  const tools: Array<{
    readonly name: string
    readonly execute: (input: never, context: never) => Effect.Effect<unknown, unknown>
  }> = []
  const sessions = new Map<string, Decision.SessionState>()
  // A PubSub, not a queue: every use that subscribes must see every event, as on the real event bus.
  const events = Effect.runSync(
    PubSub.unbounded<{ readonly type: string; readonly data: { readonly sessionID: string } }>(),
  )

  const add = (key: string) => (handler: unknown) =>
    Effect.sync(() => void hooks.set(key, [...(hooks.get(key) ?? []), handler as Handler]))
  const base = host()
  const ctx: Plugin.Context = {
    ...base,
    permission: {
      ...base.permission,
      hook: (name: string, handler: unknown) => add(`permission.${name}`)(handler),
    } as never,
    tool: {
      ...base.tool,
      hook: (name: string, handler: unknown) => add(`tool.${name}`)(handler),
      transform: (callback: (editor: { add: (tool: never) => void }) => void) =>
        Effect.sync(() => callback({ add: (tool) => void tools.push(tool) })),
      reload: () => Effect.void,
    } as never,
    event: { subscribe: () => Stream.fromPubSub(events) } as never,
    session: {
      ...base.session,
      hook: (name: string, handler: unknown) => add(`session.${name}`)(handler),
      context: () => Effect.succeed(input.messages ?? []),
      get: () => Effect.succeed({ agent: undefined, model: undefined }),
      list: () => Effect.succeed({ data: input.sessions ?? [], cursor: {} }),
      synthetic: (note: { text: string; resume?: boolean | null }) => Effect.sync(() => void notes.push(note)),
      switchModel: (value: unknown) => Effect.sync(() => void switched.model.push(value)),
      switchAgent: (value: unknown) => Effect.sync(() => void switched.agent.push(value)),
    } as never,
  }

  const answer = (questions: EvaluationQuestions) =>
    Object.fromEntries(
      Object.entries(questions).flatMap(([id, question]): Array<[string, unknown]> => {
        const text = JSON.stringify(question.instructions)
        if (question.type === "boolean") {
          const p = input.answers?.boolean?.(text, id)
          return p === undefined ? [] : [[id, { type: "boolean", probability: p }]]
        }
        if (question.type === "choice") {
          const probabilities = input.answers?.choice?.(Object.keys(question.criteria))
          if (!probabilities) return []
          const choice = Object.entries(probabilities).toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? ""
          return [[id, { type: "choice", choice, probabilities, confidence: probabilities[choice] ?? 0 }]]
        }
        const score = input.answers?.score?.()
        return score === undefined ? [] : [[id, { type: "score", score, probabilities: {} }]]
      }),
    )

  const kit: DecisionUse.Kit = {
    settings: () => (input.settings === false ? undefined : { threshold: 0.5, options: {}, ...input.settings }),
    session: (id) => {
      const found = sessions.get(id)
      if (found) return found
      const created: Decision.SessionState = { flags: [], claimNotes: 0, recentCalls: [], noted: new Set(), topic: 0 }
      sessions.set(id, created)
      return created
    },
    limit: () => Decision.DEFAULT_CONTEXT_TOKENS,
    log: () => Effect.void,
    ask: (state, questions, options) =>
      Effect.sync((): Decision.Result => {
        asked.push({ state, questions, ...options })
        const answers = answer(questions)
        if (Object.keys(answers).length === 0)
          return { status: "unavailable", purpose: "test", model: "x/y", reason: "deadline", ms: 0 }
        return {
          status: "ok",
          purpose: "test",
          model: "x/y",
          answers: answers as Extract<Decision.Result, { status: "ok" }>["answers"],
          inputTokens: 1,
          requests: 1,
          ms: 1,
          cached: false,
        }
      }),
  }

  return {
    ctx,
    kit,
    asked,
    notes,
    switched,
    tools,
    /** Runs every handler registered for `key` (e.g. "tool.execute.after") on the event, in order. */
    fire: <E>(key: string, event: E) =>
      Effect.forEach(hooks.get(key) ?? [], (handler) => handler(event), { discard: true }).pipe(Effect.as(event)),
    /**
     * Publishes a Session event to every subscriber, then yields so the forked subscribers can handle it. Under the
     * test clock a sleep would never end, so it yields instead.
     */
    emit: (type: string, sessionID: string) =>
      turns(5).pipe(Effect.andThen(PubSub.publish(events, { type, data: { sessionID } })), Effect.andThen(turns(50))),
    has: (key: string) => (hooks.get(key)?.length ?? 0) > 0,
  }
}

/** Yields `count` times, letting forked fibers (event subscribers) run without the clock moving. */
const turns = (count: number) => Effect.forEach(Array.from({ length: count }), () => Effect.yieldNow, { discard: true })

/**
 * Sets up a use in the rig. A use's type asks for every service an internal plugin may use; the uses only touch the
 * ones `services` provides, so the rest are left out on purpose.
 */
export const setup = (use: DecisionUse.Use, r: ReturnType<typeof rig>) =>
  use.setup(r.ctx, r.kit) as Effect.Effect<void, never, Layer.Success<typeof services> | Scope.Scope>

/** A user or assistant Session message, decoded through the real schema so it is valid. */
export const message = Schema.decodeUnknownSync(SessionMessage.Info)

let counter = 0
const id = () => `msg_test${String(++counter).padStart(20, "0")}`

export const user = (text: string) => message({ id: id(), type: "user", text, time: { created: 1 } })

export const assistant = (content: ReadonlyArray<unknown>) =>
  message({
    id: id(),
    type: "assistant",
    agent: "build",
    model: { providerID: "engy", id: "deepseek" },
    content,
    time: { created: 2 },
  })

export const text = (value: string) => ({ type: "text", text: value })

export const toolPart = (
  name: string,
  input: Record<string, unknown>,
  output: string,
  status: "completed" | "error" = "completed",
) => ({
  type: "tool",
  id: `call_${++counter}`,
  name,
  state:
    status === "completed"
      ? { status, input, content: [{ type: "text", text: output }] }
      : { status, input, error: { type: "tool", message: output } },
  time: { created: 3 },
})

const directory = AbsolutePath.make("/workspace")
export const files = ["src/cart.ts", "src/auth.ts", "test/cart.test.ts", "test/auth.test.ts", "README.md"]
/** Git answers: names for `--name-only`, a patch otherwise, for whatever paths a test sets. */
export const git = { names: [] as string[], patch: "" }

/** Services some uses need in setup: models, MCP tools, the file list, the project directory and git. */
export const services = Layer.mergeAll(
  Layer.mock(Model.Service, {
    get: (providerID, id) =>
      Effect.succeed({
        ...Model.Info.default(providerID, id),
        variants: [{ id: Model.VariantID.make("low") }, { id: Model.VariantID.make("high") }],
      }),
    default: () => Effect.succeed(Model.Info.default(Provider.ID.make("engy"), Model.ID.make("deepseek"))),
  }),
  Layer.mock(Mcp.Service, {
    tools: () =>
      Effect.succeed(
        Array.from({ length: 12 }, (_, i) => ({
          name: `tool${i}`,
          server: "srv",
        })) as unknown as ReadonlyArray<Mcp.Tool> as Mcp.Tool[],
      ),
  }),
  Layer.mock(Ripgrep.Service, {
    glob: () => Effect.succeed(files.map((path) => ({ path: RelativePath.make(path), type: "file" as const }))),
  }),
  Layer.succeed(
    Location.Service,
    Location.Service.of({
      directory,
      project: { id: Project.ID.global, directory, canonical: directory },
    } as unknown as Location.Interface),
  ),
  Layer.mock(AppProcess.Service, {
    run: (command) =>
      Effect.succeed({
        command: "git",
        exitCode: 0,
        stdout: Buffer.from(
          "args" in command && command.args.includes("--name-only") ? git.names.join("\n") : git.patch,
        ),
        stderr: Buffer.from(""),
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  }),
)
