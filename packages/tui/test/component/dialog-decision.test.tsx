import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import { once } from "node:events"
import { DialogDecision } from "../../src/component/dialog-decision"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

type Use = {
  id: string
  title: string
  description: string
  enabled: boolean
  source: string
  threshold: number
  last?: unknown
}

/** A fake decision API: holds the status, applies PATCH bodies to it like the server, and records them. */
function decisionApi() {
  const state = {
    model: "decisionmodels/reax-1" as string | undefined,
    modelSource: "config",
    uses: [
      {
        id: "guard",
        title: "Guard tests and checks",
        description: "Stop edits that weaken checks",
        enabled: true,
        source: "config",
        threshold: 0.7,
      },
      {
        id: "approval",
        title: "Approve routine actions",
        description: "Allow routine tool calls",
        enabled: true,
        source: "override",
        threshold: 0.9,
        last: { status: "unavailable", reason: "deadline", ms: 3000, at: 1 },
      },
    ] as Use[],
  }
  const patches: unknown[] = []
  const handle = async (url: URL, request: Request) => {
    if (url.pathname === "/api/experimental/decision/models")
      return json({ data: ["decisionmodels/reax-1", "decisionmodels/s1-pro"] })
    if (url.pathname !== "/api/experimental/decision") return undefined
    if (request.method === "PATCH") {
      const body: { model?: string | null; uses?: Record<string, boolean | null> } = await request.json()
      patches.push(body)
      if (body.model) Object.assign(state, { model: body.model, modelSource: "override" })
      for (const [id, enabled] of Object.entries(body.uses ?? {}))
        state.uses = state.uses.map((use) =>
          use.id === id ? { ...use, enabled: enabled ?? true, source: enabled === null ? "config" : "override" } : use,
        )
    }
    return json({ data: state })
  }
  return { handle, patches }
}

async function focusSearch(setup: Awaited<ReturnType<typeof renderLocal>>) {
  // The dialog paints before its deferred filter focus is ready for typing.
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
}

test("decision dialog shows each use's state and where it comes from, and toggles a use", async () => {
  const api = decisionApi()
  await using setup = await renderLocal({ fetch: api.handle })
  setup.dialog.replace(() => <DialogDecision />)
  await setup.waitForFrame((frame) => frame.includes("Decision models") && frame.includes("Guard tests and checks"))
  const frame = setup.captureCharFrame()
  expect(frame).toContain("decisionmodels/reax-1")
  expect(frame).toContain("from config")
  expect(frame).toContain("On ✓")
  expect(frame).toContain("Unavailable ! deadline")

  await focusSearch(setup)
  await setup.mockInput.typeText("Guard")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => api.patches.length === 1)
  expect(api.patches).toEqual([{ uses: { guard: false } }])
  await setup.waitForFrame((next) => next.includes("Off ○"))
})

test("decision dialog picks a model from the provider's list", async () => {
  const api = decisionApi()
  await using setup = await renderLocal({ fetch: api.handle })
  setup.dialog.replace(() => <DialogDecision />)
  await setup.waitForFrame((frame) => frame.includes("Decision models") && frame.includes("Model"))
  await focusSearch(setup)
  await setup.mockInput.typeText("Model")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Decision model") && frame.includes("decisionmodels/s1-pro"))
  await focusSearch(setup)
  await setup.mockInput.typeText("s1-pro")
  await setup.renderOnce()
  setup.mockInput.pressEnter()
  await setup.waitFor(() => api.patches.length === 1)
  expect(api.patches).toEqual([{ model: "decisionmodels/s1-pro" }])
  await setup.waitForFrame((frame) => frame.includes("chosen here"))
})
