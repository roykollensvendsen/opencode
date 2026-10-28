export * as Decision from "./decision.js"

import {
  Evaluation,
  EvaluationClient,
  type EvaluationAnswer,
  type EvaluationInput,
  type EvaluationQuestion,
} from "@opencode/ai/experimental"
import { TypeSafeAI } from "@opencode/ai/providers/typesafe-ai"
import { RequestExecutor } from "@opencode/ai/route"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Context, Duration, Effect, Layer, Option, PubSub, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { createHash } from "node:crypto"
import { Credential } from "./credential.js"
import { requestExecutor } from "./effect/app-node-platform.js"
import { Integration } from "./integration.js"
import { KV } from "./kv.js"
import type { DecisionTurn } from "./decision/turn.js"
import type { Model } from "./model.js"
import { Provider } from "./provider.js"

/**
 * One way for OpenCode, plugins and users to ask a decision model typed questions. `ask` never fails: a call that
 * cannot be answered returns `unavailable` with a reason, and callers decide what that means for them. A failure is
 * never a "no".
 */
export interface AskInput {
  /** `providerID/modelID`; the provider's configured baseURL and credentials are used. */
  readonly model: string
  /** What the answer is for, recorded with the result. */
  readonly purpose: string
  /** Text, a JSON object or a JSON array: what the questions are about. */
  readonly state: EvaluationInput
  readonly questions: Readonly<Record<string, EvaluationQuestion>>
  readonly timeout?: number
  /** Questions the model accepts per request; larger sets are split and sent in parallel. */
  readonly maxQuestions?: number
  /** Tokens the model accepts per request, for the state and its questions together. */
  readonly contextTokens?: number
  /** Images as data URLs, sent with every request for vision models (System One's top-level `images`). */
  readonly images?: ReadonlyArray<string>
}

export type Result =
  | {
      readonly status: "ok"
      readonly purpose: string
      readonly model: string
      /** The model version the host reports having answered with, when it reports one. */
      readonly version?: string
      readonly answers: Readonly<Record<string, EvaluationAnswer>>
      readonly inputTokens: number
      readonly requests: number
      readonly ms: number
      readonly cached: boolean
    }
  | {
      readonly status: "unavailable"
      readonly purpose: string
      readonly model: string
      readonly reason: "not-configured" | "no-credential" | "too-large" | "deadline" | "error"
      readonly message?: string
      /** For `too-large`: the estimated size of the largest request and the limit it exceeded. */
      readonly tokens?: { readonly estimated: number; readonly limit: number }
      readonly ms: number
    }

/** A tool result one use of the decision model flagged as trying to instruct the agent. */
export interface Flag {
  readonly tool: string
  /** Path, URL or command the flagged text came from. */
  readonly source: string
  readonly excerpt: string
  readonly probability: number
}

/**
 * What the uses of the decision model know about one Session, shared so that one use can act on what another found:
 * the user's latest request, tool results flagged as instructing the agent, and the skills picked for the request.
 */
export interface SessionState {
  userRequest?: string
  readonly flags: Flag[]
  skills?: ReadonlySet<string> | "all"
  /** Contradicted claims already reported, so the claim check never loops. */
  claimNotes: number
  /** The last shell command the agent ran and the end of its output. */
  lastCommand?: { readonly command: string; readonly output: string }
  /** The model the Session used before a use changed its variant, so it can be restored. */
  baseModel?: Model.Ref
  /** The last tool calls, oldest first, kept by the loader for uses that judge recent activity. */
  readonly recentCalls: DecisionTurn.ToolCall[]
  /** Notes already given for the current request, by use, so none repeats; cleared on a new request. */
  readonly noted: Set<string>
  /** Set by frustration for the current request. */
  frustrated?: boolean
  /** Bumped by topics when the user starts a different task, so per-Session picks (skills, tools, files) are redone. */
  topic: number
}

/**
 * Choices made from the UI, stored per user so they survive restarts. They win over config; clearing one (null) lets
 * config decide again.
 */
export interface Overrides {
  readonly model?: string
  readonly uses: Readonly<Record<string, boolean>>
}

export interface OverridesPatch {
  readonly model?: string | null
  readonly uses?: Readonly<Record<string, boolean | null>>
}

/** How the last request for a purpose went, for status displays. */
export interface Outcome {
  readonly status: Result["status"]
  readonly reason?: Extract<Result, { status: "unavailable" }>["reason"]
  readonly ms: number
  readonly at: number
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<Result>
  readonly controls: {
    readonly current: () => Overrides
    readonly set: (patch: OverridesPatch) => Effect.Effect<Overrides>
    /** Emits after every change, so consumers that registered something (a tool) can re-register. */
    readonly changes: Stream.Stream<Overrides>
  }
  readonly last: (purpose: string) => Outcome | undefined
  /** Model IDs the provider's host lists at `{baseURL}/models`, or undefined when it cannot be reached. */
  readonly models: (providerID: string) => Effect.Effect<ReadonlyArray<string> | undefined>
  /** Shared, in-memory state for one Session; created on first use. */
  readonly session: (sessionID: string) => SessionState
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Decision") {}

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MAX_QUESTIONS = 3
/** Decision Models' System One models take 8,000 to 8,192 tokens (models.dev, 2026-10-24); the smaller is the safe default. */
export const DEFAULT_CONTEXT_TOKENS = 8_000
/** Measured on Decision Models' s1-vision-2: about 370-420 tokens per image at 640x420 to 1280x840 (2026-10-24). */
const IMAGE_TOKENS = 450
const CACHE_TTL_MS = 5 * 60_000
const CACHE_LIMIT = 500
const SESSION_LIMIT = 200
const OVERRIDES_KEY = "decision/overrides"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const providers = yield* Provider.Service
    const kv = yield* KV.Service
    const http = yield* HttpClient.HttpClient
    const outcomes = new Map<string, Outcome>()
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(StoredOverrides)(yield* kv.get(OVERRIDES_KEY)))
    const overrides = { current: stored ?? { uses: {} } }
    const changed = yield* PubSub.unbounded<Overrides>()
    const cache = new Map<string, { readonly expires: number; readonly result: Extract<Result, { status: "ok" }> }>()
    const sessions = new Map<string, SessionState>()
    const session = (sessionID: string) => {
      const found = sessions.get(sessionID)
      if (found) return found
      const oldest = sessions.keys().next()
      if (sessions.size >= SESSION_LIMIT && !oldest.done) sessions.delete(oldest.value)
      const created: SessionState = { flags: [], claimNotes: 0, recentCalls: [], noted: new Set(), topic: 0 }
      sessions.set(sessionID, created)
      return created
    }

    const access = Effect.fnUntraced(function* (providerID: string) {
      const provider = yield* providers.get(Provider.ID.make(providerID))
      const connection = yield* integrations.connection.active(
        provider?.integrationID ?? Integration.ID.make(providerID),
      )
      const credential = connection
        ? yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const apiKey = credential && apiKeyOf(credential)
      const baseURL = provider?.settings?.baseURL
      return { apiKey, baseURL: typeof baseURL === "string" ? expandEnv(baseURL) : undefined, headers: provider?.headers }
    })

    const ask = (input: AskInput) =>
      answer(input).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            outcomes.set(input.purpose, {
              status: result.status,
              ...(result.status === "unavailable" ? { reason: result.reason } : {}),
              ms: result.ms,
              at: Date.now(),
            }),
          ),
        ),
      )

    const controls = {
      current: () => overrides.current,
      set: Effect.fn("Decision.controls.set")(function* (patch: OverridesPatch) {
        const uses = Object.fromEntries(
          Object.entries({ ...overrides.current.uses, ...patch.uses }).flatMap(([id, value]) =>
            typeof value === "boolean" ? [[id, value]] : [],
          ),
        )
        const model = patch.model === undefined ? overrides.current.model : (patch.model ?? undefined)
        overrides.current = { ...(model ? { model } : {}), uses }
        yield* kv.set(OVERRIDES_KEY, overrides.current)
        yield* PubSub.publish(changed, overrides.current)
        return overrides.current
      }),
      changes: Stream.fromPubSub(changed),
    }

    const models = Effect.fn("Decision.models")(function* (providerID: string) {
      const { apiKey, baseURL } = yield* access(providerID)
      if (!apiKey || !baseURL) return undefined
      const response = yield* http
        .execute(HttpClientRequest.get(`${baseURL.replace(/\/$/, "")}/models`).pipe(HttpClientRequest.bearerToken(apiKey)))
        .pipe(
          Effect.flatMap((res) => res.json),
          Effect.timeout(Duration.seconds(10)),
          Effect.orElseSucceed(() => undefined),
        )
      return Option.getOrUndefined(Schema.decodeUnknownOption(ModelList)(response))?.data.map((model) => model.id)
    })

    const answer = Effect.fn("Decision.ask")(function* (input: AskInput) {
      const started = Date.now()
      const elapsed = () => Date.now() - started
      const slash = input.model.indexOf("/")
      const base = { purpose: input.purpose, model: input.model }
      if (slash <= 0) return { ...base, status: "unavailable", reason: "not-configured", ms: 0 } satisfies Result
      const providerID = input.model.slice(0, slash)
      const modelID = input.model.slice(slash + 1)

      const key = createHash("sha256")
        .update(canonical({ model: input.model, state: input.state, questions: input.questions, images: input.images ?? [] }))
        .digest("hex")
      const hit = cache.get(key)
      if (hit && hit.expires > Date.now()) return { ...hit.result, cached: true, ms: 0 }

      const size = Math.max(1, input.maxQuestions ?? DEFAULT_MAX_QUESTIONS)
      const entries = Object.entries(input.questions)
      const parts = Array.from({ length: Math.ceil(entries.length / size) }, (_, i) =>
        Object.fromEntries(entries.slice(i * size, (i + 1) * size)),
      )
      // Checked before anything is sent: a request the model cannot take is reported, never silently cut or sent.
      const limit = input.contextTokens ?? DEFAULT_CONTEXT_TOKENS
      // An image costs about 400 tokens however large it is (the host downscales); its base64 length does not count.
      const estimated =
        Math.max(...parts.map((questions) => estimateTokens(input.state, questions))) + (input.images?.length ?? 0) * IMAGE_TOKENS
      if (estimated > limit) {
        yield* Effect.logWarning("decision request too large").pipe(
          Effect.annotateLogs({ purpose: input.purpose, model: input.model, estimated, limit }),
        )
        return {
          ...base,
          status: "unavailable",
          reason: "too-large",
          message: `about ${estimated} tokens, over the model's ${limit}`,
          tokens: { estimated, limit },
          ms: elapsed(),
        } satisfies Result
      }

      const { apiKey, baseURL, headers } = yield* access(providerID)
      if (!apiKey) return { ...base, status: "unavailable", reason: "no-credential", ms: elapsed() } satisfies Result
      const model = TypeSafeAI.configure({ apiKey, baseURL, headers }).experimental.evaluation(modelID)
      const responses = yield* Effect.forEach(
        parts,
        (questions) =>
          Evaluation.run({
            model,
            state: input.state,
            questions,
            ...(input.images?.length ? { http: { body: { images: [...input.images] } } } : {}),
          }).pipe(
            // A busy or rate-limited host often has room a moment later; the overall timeout still bounds the wait.
            Effect.retry({
              while: (error) => BUSY.test(error.message),
              schedule: Schedule.exponential(Duration.millis(200)),
              times: 3,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provide(EvaluationClient.layer),
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.timeout(Duration.millis(input.timeout ?? DEFAULT_TIMEOUT_MS)),
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            deadline: error._tag === "TimeoutError",
            message: error.message,
          }),
        ),
      )
      if (!responses.ok)
        return {
          ...base,
          status: "unavailable",
          reason: responses.deadline ? "deadline" : TOO_LARGE.test(responses.message) ? "too-large" : "error",
          message: responses.message,
          ms: elapsed(),
        } satisfies Result

      const result = {
        ...base,
        status: "ok",
        version: responses.value[0]?.model,
        answers: Object.assign({}, ...responses.value.map((response) => response.answers)),
        inputTokens: responses.value.reduce((sum, response) => sum + (response.usage?.inputTokens ?? 0), 0),
        requests: responses.value.length,
        ms: elapsed(),
        cached: false,
      } satisfies Result
      const oldest = cache.keys().next()
      if (cache.size >= CACHE_LIMIT && !oldest.done) cache.delete(oldest.value)
      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, result })
      return result
    })

    return Service.of({ ask, session, controls, last: (purpose) => outcomes.get(purpose), models })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, Provider.node, KV.node, httpClient, requestExecutor],
})

/**
 * Characters of request JSON per token, chosen below the worst case measured. Tool output (code, JSON, logs) sent to
 * quyet-1-large came to 1.59 to 3.29 characters per counted token, median 2.28, prompt template included.
 */
export const CHARS_PER_TOKEN = 1.5

/** A conservative token estimate for one request: its JSON size at `CHARS_PER_TOKEN`, plus room for the envelope. */
export const estimateTokens = (state: EvaluationInput, questions: Readonly<Record<string, EvaluationQuestion>>) =>
  Math.ceil(JSON.stringify({ state, questions }).length / CHARS_PER_TOKEN) + 50

/** How hosts word a temporary refusal: busy, overloaded or rate limited. */
const BUSY = /busy|overload|capacity|rate.?limit|too many requests|429|503|retry shortly|try again/i

/** How hosts word a request over the model's context, so an estimate that was too low is still reported as such. */
const TOO_LARGE = /context (length|window)|too (long|large)|max(imum)?[ _-]?(input|context)|token limit|(exceeds|longer than) .*tokens/i

/** Probability of a boolean answer, or undefined when the answer is missing or of another type. */
export const probability = (result: Result, id: string) => {
  if (result.status !== "ok") return undefined
  const answer = result.answers[id]
  return answer?.type === "boolean" ? answer.probability : undefined
}

const apiKeyOf = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.type === "oauth" ? credential.access : undefined

const expandEnv = (value: string) => value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "")

const StoredOverrides = Schema.Struct({
  model: Schema.optional(Schema.String),
  uses: Schema.Record(Schema.String, Schema.Boolean),
})

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value) ?? "null"
