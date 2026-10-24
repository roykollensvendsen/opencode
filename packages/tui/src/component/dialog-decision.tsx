import { createMemo, createSignal, onMount, Show } from "solid-js"
import type { DecisionStatus, DecisionUseStatus } from "@opencode/client"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

const MODEL = "\u0000model"

function UseStatus(props: { use: DecisionUseStatus; model: boolean }) {
  if (!props.model) return <>No model ○</>
  if (!props.use.enabled) return <>Off ○</>
  if (props.use.last?.status === "unavailable") return <>Unavailable ! {props.use.last.reason}</>
  return <>On ✓</>
}

/**
 * Decision models: pick the model and switch each use on or off. Choices are stored per user and win over config,
 * like toggling an MCP server; the source of each setting is shown so config users see where it comes from.
 */
export function DialogDecision() {
  const client = useClient()
  const location = useLocation()
  const data = useData()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const directory = () => (location.ref ?? data.location.default()).directory
  const [status, setStatus] = createSignal<DecisionStatus>()
  const [picking, setPicking] = createSignal(false)
  const [models, setModels] = createSignal<ReadonlyArray<string>>([])

  const load = () =>
    client.api.decision
      .status({ location: { directory: directory() } })
      .then((result) => setStatus(result.data))
      .catch(toast.error)
  onMount(() => void load())

  const update = (payload: { model?: string | null; uses?: Record<string, boolean | null> }) =>
    client.api.decision
      .update({ location: { directory: directory() }, ...payload })
      .then((result) => setStatus(result.data))
      .catch(toast.error)

  const pickModel = () => {
    setPicking(true)
    void client.api.decision
      .models({ location: { directory: directory() } })
      .then((result) => setModels(result.data))
      .catch(toast.error)
  }

  const options = createMemo(() => {
    const current = status()
    if (!current) return []
    const model = {
      value: MODEL,
      title: "Model",
      description: current.model ?? "none chosen",
      footer: <>{current.modelSource === "override" ? "chosen here" : current.modelSource === "config" ? "from config" : ""}</>,
      footerColor: theme.text.muted,
    }
    return [
      model,
      ...current.uses.map((use) => ({
        value: use.id,
        title: use.title,
        description: use.description,
        footer: <UseStatus use={use} model={current.model !== undefined} />,
        footerColor:
          !current.model || !use.enabled
            ? theme.text.muted
            : use.last?.status === "unavailable"
              ? theme.text.feedback.warning.base
              : theme.text.feedback.success.base,
      })),
    ]
  })

  const toggle = (id: string) => {
    if (id === MODEL) return pickModel()
    const use = status()?.uses.find((entry) => entry.id === id)
    if (!use) return
    void update({ uses: { [id]: !use.enabled } })
  }

  return (
    <Show
      when={picking()}
      fallback={
        <DialogSelect
          title="Decision models"
          searchInTitle
          titlePlaceholder="Search uses"
          options={options()}
          preserveSelection
          onSelect={(option) => toggle(option.value as string)}
          actions={[
            {
              title: "toggle",
              command: "dialog.decision.toggle",
              onTrigger: (option) => toggle(option.value as string),
            },
            {
              title: "use config",
              command: "dialog.decision.reset",
              onTrigger: (option) =>
                void update(option.value === MODEL ? { model: null } : { uses: { [option.value as string]: null } }),
            },
          ]}
        />
      }
    >
      <DialogSelect
        title="Decision model"
        searchInTitle
        titlePlaceholder="Search decision models"
        options={models().map((model) => ({ value: model, title: model }))}
        onSelect={(option) => {
          setPicking(false)
          void update({ model: option.value as string })
        }}
      />
    </Show>
  )
}
