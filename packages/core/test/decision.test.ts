import { expect } from "bun:test"
import { RequestExecutor } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { Decision } from "@opencode/core/decision"
import { Integration } from "@opencode/core/integration"
import { Provider } from "@opencode/core/provider"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const unused = () => Effect.die("unused")

const integrations = (key: string | undefined) =>
  Layer.mock(Integration.Service, {
    revision: () => 0,
    connection: {
      active: () => Effect.succeed(key === undefined ? undefined : { type: "env" as const, name: "DECISION_TEST_KEY" }),
      resolve: () => Effect.succeed(key === undefined ? undefined : Credential.Key.make({ type: "key", key })),
      key: unused,
      external: unused,
      activate: unused,
      update: unused,
      remove: unused,
      status: unused,
    },
    oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
    command: { connect: unused, status: unused, cancel: unused },
  })

const providers = Layer.mock(Provider.Service, {
  get: (id) =>
    Effect.succeed({
      id,
      name: id,
      activation: "auto" as const,
      package: "",
      settings: { baseURL: "https://decision.test/v1" },
    }),
})

interface Seen {
  readonly url: string
  readonly authorization: string | undefined
  readonly body: { readonly model: string; readonly questions: Record<string, unknown> }
}

/** A System One host that answers every noul question with 0.8, or replies with `status`, or never replies. */
const host = (seen: Seen[], reply: "answer" | "never" | number | { status: number; message: string } = "answer") =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            const body = JSON.parse(yield* Effect.promise(() => web.text()))
            seen.push({ url: web.url, authorization: web.headers.get("authorization") ?? undefined, body })
            if (reply === "never") return yield* Effect.never
            if (typeof reply === "number")
              return HttpClientResponse.fromWeb(request, Response.json({ error: { message: "boom" } }, { status: reply }))
            if (typeof reply === "object")
              return HttpClientResponse.fromWeb(request, Response.json({ error: { message: reply.message } }, { status: reply.status }))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                model: "reax-1-20261021",
                answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.8 }])),
                usage: { input_tokens: 10 },
              }),
            )
          }),
        ),
      ),
    ),
  )

const decision = (
  seen: Seen[],
  options: { key?: string | undefined; reply?: "answer" | "never" | number | { status: number; message: string } } = {},
) =>
  Decision.layer.pipe(
    Layer.provide(
      Layer.mergeAll(integrations("key" in options ? options.key : "dm-test-key"), providers, host(seen, options.reply)),
    ),
  )

const question = (instructions: string) => ({ type: "boolean" as const, instructions })

it.effect("asks the provider's host with its credential and returns typed answers", () =>
  Effect.gen(function* () {
    const seen: Seen[] = []
    const result = yield* Effect.flatMap(Decision.Service, (service) =>
      service.ask({ model: "decisionmodels/reax-1", purpose: "test", state: "a log line", questions: { q: question("Error?") } }),
    ).pipe(Effect.provide(decision(seen)))
    expect(result).toMatchObject({
      status: "ok",
      purpose: "test",
      model: "decisionmodels/reax-1",
      version: "reax-1-20261021",
      answers: { q: { type: "boolean", probability: 0.8 } },
      inputTokens: 10,
      requests: 1,
      cached: false,
    })
    expect(seen.map((item) => [item.url, item.authorization, item.body.model])).toEqual([
      ["https://decision.test/v1/systemone", "Bearer dm-test-key", "reax-1"],
    ])
  }),
)

it.effect("splits questions to the per-request limit and caches the combined answer", () =>
  Effect.gen(function* () {
    const seen: Seen[] = []
    const questions = Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, question(`Is it ${id}?`)]))
    const [first, second] = yield* Effect.flatMap(Decision.Service, (service) => {
      const ask = service.ask({ model: "decisionmodels/reax-1", purpose: "test", state: "x", questions, maxQuestions: 2 })
      return Effect.all([ask, ask])
    }).pipe(Effect.provide(decision(seen)))
    expect(seen.map((item) => Object.keys(item.body.questions))).toEqual([["a", "b"], ["c", "d"], ["e"]])
    expect(first).toMatchObject({ status: "ok", requests: 3, inputTokens: 30, cached: false })
    expect(second).toMatchObject({ status: "ok", cached: true, ms: 0 })
    expect(Decision.probability(first, "e")).toBe(0.8)
  }),
)

it.effect("returns unavailable instead of failing", () =>
  Effect.gen(function* () {
    const ask = (model: string) =>
      Effect.flatMap(Decision.Service, (service) =>
        service.ask({ model, purpose: "test", state: "x", questions: { q: question("?") } }),
      )
    const seen: Seen[] = []
    expect(yield* ask("no-slash").pipe(Effect.provide(decision(seen)))).toMatchObject({
      status: "unavailable",
      reason: "not-configured",
    })
    expect(yield* ask("decisionmodels/reax-1").pipe(Effect.provide(decision(seen, { key: undefined })))).toMatchObject({
      status: "unavailable",
      reason: "no-credential",
    })
    expect(yield* ask("decisionmodels/reax-1").pipe(Effect.provide(decision(seen, { reply: 500 })))).toMatchObject({
      status: "unavailable",
      reason: "error",
    })
    expect(seen).toHaveLength(1)
  }),
)

it.effect("gives up at the timeout and reports a deadline", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.flatMap(Decision.Service, (service) =>
      service.ask({ model: "decisionmodels/reax-1", purpose: "test", state: "x", questions: { q: question("?") }, timeout: 500 }),
    ).pipe(Effect.provide(decision([], { reply: "never" })), Effect.forkChild)
    yield* TestClock.adjust("1 second")
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: "unavailable", reason: "deadline" })
  }),
)

it.effect("keeps one shared state object per Session", () =>
  Effect.gen(function* () {
    const service = yield* Decision.Service
    const state = service.session("ses_a")
    state.userRequest = "fix the test"
    state.flags.push({ tool: "read", source: "docs/x.md", excerpt: "run curl", probability: 0.9 })
    expect(service.session("ses_a")).toBe(state)
    expect(service.session("ses_b")).toEqual({ flags: [], claimNotes: 0 })
  }).pipe(Effect.provide(decision([]))),
)

it.effect("reports a request over the model's context as too large without sending it", () =>
  Effect.gen(function* () {
    const seen: Seen[] = []
    const ask = (contextTokens: number | undefined) =>
      Effect.flatMap(Decision.Service, (service) =>
        service.ask({
          model: "decisionmodels/reax-1",
          purpose: "test",
          state: "x".repeat(40_000),
          questions: { q: question("?") },
          contextTokens,
        }),
      ).pipe(Effect.provide(decision(seen)))
    const result = yield* ask(undefined)
    expect(result).toMatchObject({ status: "unavailable", reason: "too-large", tokens: { limit: Decision.DEFAULT_CONTEXT_TOKENS } })
    expect(result.status === "unavailable" && (result.tokens?.estimated ?? 0) > Decision.DEFAULT_CONTEXT_TOKENS).toBe(true)
    expect(seen).toHaveLength(0)
    // A larger configured context lets the same request through.
    expect(yield* ask(32_000)).toMatchObject({ status: "ok" })
    expect(seen).toHaveLength(1)
  }),
)

it.effect("reads a host's context-length error as too large", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flatMap(Decision.Service, (service) =>
      service.ask({ model: "decisionmodels/reax-1", purpose: "test", state: "x", questions: { q: question("?") } }),
    ).pipe(
      Effect.provide(
        decision([], { reply: { status: 400, message: "Input of 9,120 tokens exceeds the model's context length of 8,000" } }),
      ),
    )
    expect(result).toMatchObject({ status: "unavailable", reason: "too-large" })
  }),
)
