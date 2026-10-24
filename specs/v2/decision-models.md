# Decision Models in Core

Status: **Prototype record, 2026-10-24.** These notes cover a local prototype on the `decision-models` branch. It is not a proposal and has not been reviewed upstream. The notes record what was tried, what was measured and what was dropped, as input for the real design. The labelled test sets, the run logs and the eval scripts are in a separate repo (`opencode-decision-proto`).

A decision model answers typed questions about a state: a boolean probability, a choice or a score. It does not write text. Decision Models, Verathos and TypeSafe serve them through System One (`POST {baseURL}/systemone`). Today `@opencode/ai` can call them (`Evaluation.run`), but Core never does, and models.dev's default `api.json` drops `type = "decision"`.

## Shape that survived

- **`Decision` service** (`core/src/decision.ts`). `ask({ model, purpose, state, questions, timeout, maxQuestions, contextTokens })`:
  - It never fails. It returns `ok`, with answers, the model version, tokens, request count, ms and whether it was cached, or `unavailable`, with `not-configured`, `no-credential`, `too-large`, `deadline` or `error`. A failure is never a "no".
  - It uses the provider's normal credential and `settings.baseURL`, resolved the way `ModelResolver` resolves them.
  - It splits the questions to the per-request limit, caches answers for 5 minutes, and checks size before sending.
- **Shared Session state** (`session(id)`): the user's request, flagged tool results, picked skills, the last shell command, the base model and claim notes. Uses never call each other; they read and write this.
- **One module per use** (`core/src/decision/uses/<id>.ts`): its question, pure decision functions and hook wiring. Each use reaches the model, the state and its own settings only through a kit. `plugin/decision.ts` is a loader.
- **Config:** `decision: { model, timeout, max_questions, context, uses: { <id>: { enabled, threshold, options } } }`. Every use is off unless enabled. A new use needs no schema change, but a new top-level key does need a line in `config/normalize.ts`.

## Uses

All numbers are for `decisionmodels/reax-1` on hand-written labelled sets. Each use was compared with a simple baseline.

| Use | Hook | Result | Baseline |
|---|---|---|---|
| approve: allow an `ask` that is routine work on the request | `permission.evaluate` | Routine 22/25, risky wrongly approved 0/25 (threshold 0.9). Live: about 100–290 ms per call. Over-cautious when the request says "follow the steps in a file" (0.55). | not run |
| approve after a flag: "does this call carry out the flagged instructions?" | same, separate request | Bad steps 0.92–0.98, ordinary work 0.03–0.05 | — |
| screen: flag tool results that instruct the agent | `tool.execute.after` | Plain 15/15, hard (no AI wording) 9/10 at 0.5, 0 false | regex: 15/15 plain, 0/10 hard |
| skills: cut the skill list to the request | `session.context` | 20/20 relevant, 3 extra, 316 ms | keywords 10/20 |
| tool: `decide` for the agent | tool transform | Works, including through code mode | — |
| claims: success claimed while the last command failed | `session.execution.succeeded` + `synthetic` | 10/10 | — |
| retry: stop retries that cannot succeed | `session.retry` | 12/12, never stops a transient error | status codes miss 2 |
| effort: reasoning variant by difficulty | `session.prompt` + `switchModel` | 12/12; live it switched to `low` and `max` | length 9/12 |
| guard: reject edits that weaken tests or checks | `tool.execute.before` | Hard 8/10 alone, **6/6 with the request and the last test output** | regex 4/10 hard |
| route: send large or ambiguous first requests to `plan` | `session.prompt` + `switchAgent` | Hard 8/8; live it routed to plan | keywords 0/8 hard |

## Rejected along the way

- **A. Plugin only.** A V2 plugin can't use OpenCode's provider credentials, so its keys came from environment variables. It also can't see where an instruction came from. In both live injection scenarios it was the chat model that stopped the attack, not the plugin gate. That moved the work into Core.
- **B. One flag stops approval for the whole Session.** It was safe, but `opencode run` then rejected even the obvious fix. Replaced by the second, scoped question.
- **C. Flagged text in the main approve question.** It pulled routine calls down to 0.12–0.72. That check is now a separate request.
- **D. "Follows the flagged instructions" without naming the suspicious part.** `node --test` scored 0.88 because the flagged doc also said "run the tests".
- **E. All uses in one plugin file with fixed config keys.** Adding a use meant editing the shared closure and the schema. Replaced by modules and `decision.uses`.
- **F. Easy test sets.** For screen, guard and route, the easy sets scored 100% for both the model and a regex or keyword match. Only the hard sets showed what the model adds.
- **G. Skills filtering on by default.** The agent model usually picks skills as well. It only pays when there are many skills, and changing the list costs a prompt-cache miss.

## Open

- approve is over-cautious when the request names a file to follow.
- Work started when a Session goes idle (claims) may not finish before `opencode run` exits.
- It is not verified that `switchModel` to a variant reached the host as `reasoning_effort`.
- No live agent tried a flagged dangerous step or a test-gutting edit. Only the offline sets cover those.
- The notes OpenCode adds (screen warnings, claim notes, guard rejections) grow the agent's context. This has not been measured.
- Decision models never reach the catalogue, so model limits (questions per request, context) come from config. models.dev has no `limit.questions`.
- Unit tests cover the service and the pure decision functions (18 tests). They do not cover each use's hook wiring or the loader.
- There is no API for external plugins (`ctx.decision.ask`) and no `opencode decide` command.
