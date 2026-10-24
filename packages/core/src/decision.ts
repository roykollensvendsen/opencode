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
import { Context, Duration, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { Credential } from "./credential.js"
import { requestExecutor } from "./effect/app-node-platform.js"
import { Integration } from "./integration.js"
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
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<Result>
  /** Shared, in-memory state for one Session; created on first use. */
  readonly session: (sessionID: string) => SessionState
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Decision") {}

const DEFAULT_TIMEOUT_MS = 3_000
const DEFAULT_MAX_QUESTIONS = 3
/** Decision Models' System One models take 8,000 to 8,192 tokens (models.dev, 2026-10-24); the smaller is the safe default. */
export const DEFAULT_CONTEXT_TOKENS = 8_000
const CACHE_TTL_MS = 5 * 60_000
const CACHE_LIMIT = 500
const SESSION_LIMIT = 200

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const providers = yield* Provider.Service
    const cache = new Map<string, { readonly expires: number; readonly result: Extract<Result, { status: "ok" }> }>()
    const sessions = new Map<string, SessionState>()
    const session = (sessionID: string) => {
      const found = sessions.get(sessionID)
      if (found) return found
      const oldest = sessions.keys().next()
      if (sessions.size >= SESSION_LIMIT && !oldest.done) sessions.delete(oldest.value)
      const created: SessionState = { flags: [], claimNotes: 0 }
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

    const ask = Effect.fn("Decision.ask")(function* (input: AskInput) {
      const started = Date.now()
      const elapsed = () => Date.now() - started
      const slash = input.model.indexOf("/")
      const base = { purpose: input.purpose, model: input.model }
      if (slash <= 0) return { ...base, status: "unavailable", reason: "not-configured", ms: 0 } satisfies Result
      const providerID = input.model.slice(0, slash)
      const modelID = input.model.slice(slash + 1)

      const key = createHash("sha256")
        .update(canonical({ model: input.model, state: input.state, questions: input.questions }))
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
      const estimated = Math.max(...parts.map((questions) => estimateTokens(input.state, questions)))
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
        (questions) => Evaluation.run({ model, state: input.state, questions }),
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

    return Service.of({ ask, session })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, Provider.node, requestExecutor],
})

/**
 * A conservative token estimate for one request: its JSON size at 3.5 characters a token, which overcounts English and
 * code slightly, plus room for the request envelope.
 */
export const estimateTokens = (state: EvaluationInput, questions: Readonly<Record<string, EvaluationQuestion>>) =>
  Math.ceil(JSON.stringify({ state, questions }).length / 3.5) + 50

/** How hosts word a request over the model's context, so an estimate that was too low is still reported as such. */
const TOO_LARGE = /context (length|window)|too (long|large)|max(imum)?[ _-]?(input|context)|token limit|exceeds .*tokens/i

/** Probability of a boolean answer, or undefined when the answer is missing or of another type. */
export const probability = (result: Result, id: string) => {
  if (result.status !== "ok") return undefined
  const answer = result.answers[id]
  return answer?.type === "boolean" ? answer.probability : undefined
}

const apiKeyOf = (credential: Credential.Value) =>
  credential.type === "key" ? credential.key : credential.type === "oauth" ? credential.access : undefined

const expandEnv = (value: string) => value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "")

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : JSON.stringify(value) ?? "null"
