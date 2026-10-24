import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// The server's database is in memory, so a choice made here never reaches the user's stored settings.
it.live("reports decision settings from config, stores a choice that wins over it, and clears it again", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-decision-endpoint-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          decision: { model: "decisionmodels/reax-1", uses: { guard: { enabled: true, threshold: 0.8 } } },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const call = (method: string, route: string, body?: unknown) => {
      const url = new URL(route, server.base)
      url.searchParams.set("location[directory]", tmp.path)
      return Effect.promise(async () => {
        const response = await fetch(url, {
          method,
          headers: { ...server.headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const json: unknown = await response.json()
        return { status: response.status, body: isRecord(json) ? json["data"] : undefined }
      })
    }
    const use = (body: unknown, id: string) =>
      isRecord(body) && Array.isArray(body["uses"])
        ? body["uses"].find((item) => isRecord(item) && item["id"] === id)
        : undefined

    const initial = yield* call("GET", "/api/experimental/decision")
    expect(initial.status).toBe(200)
    expect(initial.body).toMatchObject({ model: "decisionmodels/reax-1", modelSource: "config" })
    expect(use(initial.body, "guard")).toMatchObject({ enabled: true, source: "config", threshold: 0.8 })
    expect(use(initial.body, "approval")).toMatchObject({ enabled: false, source: "default" })

    const changed = yield* call("PATCH", "/api/experimental/decision", {
      model: "decisionmodels/s1-pro",
      uses: { guard: false, approval: true },
    })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({ model: "decisionmodels/s1-pro", modelSource: "override" })
    expect(use(changed.body, "guard")).toMatchObject({ enabled: false, source: "override" })
    expect(use(changed.body, "approval")).toMatchObject({ enabled: true, source: "override" })

    const cleared = yield* call("PATCH", "/api/experimental/decision", {
      model: null,
      uses: { guard: null, approval: null },
    })
    expect(cleared.body).toMatchObject({ model: "decisionmodels/reax-1", modelSource: "config" })
    expect(use(cleared.body, "guard")).toMatchObject({ enabled: true, source: "config" })

    const rejected = yield* call("PATCH", "/api/experimental/decision", { uses: { guard: "yes" } })
    expect(rejected.status).toBe(400)
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
