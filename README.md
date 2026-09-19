# JEV General Agent

JEV is a local task runner and Cline-compatible proxy for general development work. The decision/control plane remains local and Typesafe JEV supplies structured decisions; no external code-synthesis model is enabled by default.

## Start and stop

From PowerShell:

```powershell
.\start-jev.ps1 -Workspace "C:\path\to\project"
.\status.ps1
.\stop-jev.ps1
```

To change the project used by Cline without changing JEV source code:

```powershell
.\set-workspace.ps1 "C:\path\to\project"
```

`4012` is the local agent service and `4014` is the Cline-compatible proxy. The workspace is selected per start/task; no project-specific file, framework, or exchange signature is required.

## Provider setup

The repository never contains a provider key. Each installation uses its own JEV Typesafe key:

```powershell
.\configure-jev.ps1
```

The key is stored only in the current Windows user's environment as `TYPESAFE_API_KEY`. Do not put it in `.env`, source files, task prompts, logs, or GitHub.

## Learning and controlled self-improvement

Each task can record a redacted result in `memory/task-experiences.jsonl`. Related prior results are supplied as evidence to future planning; they do not override current files or tests. This is persistent experience retrieval, not unattended model-weight training.

JEV reasoning is implemented as a fast structured fan-out: the controller asks for the next action, task intent, scope risk, and verification requirement in one Typesafe request. The local agent then combines those decisions with tool evidence, child workers, tests, and rollback gates. On Windows, the native agent includes a PowerShell transport fallback for environments where Node's direct HTTPS path cannot reach the configured proxy.

The code self-improvement path is bounded: candidate -> syntax/security/evaluation -> promote, reject, or rollback. Run `node self-improvement/manager.mjs test-cycle` to verify the rejection and rollback path. A trusted source change should be followed by `node self-improvement/manager.mjs rebaseline`.

For code synthesis, the supervised browser worker can use a user-approved, already signed-in ChatGPT browser profile through Chrome DevTools Protocol. Start Chrome with a separate profile and `--remote-debugging-port=9222`, complete login manually, then set `JEV_BROWSER_ALLOW_TRANSMIT=1`. The worker never reads passwords or one-time codes. Login, form submission, uploads, financial actions, public messages, and other external writes require an explicit approval gate before execution. Browser output is treated as an untrusted candidate and still passes the normal patch, sandbox, validation, and reviewer gates.

The supervisor runs isolated `scout`, `planner`, `builder`, `validator`, `reviewer`, and `reporter` roles as child processes. With external synthesis disabled, the planner can use the local deterministic synthesis engine for verified named-function return changes and JSON primitive updates; unsupported free-form code generation is rejected rather than invented.

This does not train JEV into Codex/Astra or create new model weights. It provides an Astra-like development workflow around JEV: inspect the selected workspace, decompose the request, edit through an isolated candidate, execute explicit validation commands, preserve evidence, and apply only a passing result. JEV remains the configured structured-decision provider; it is not a general-purpose local text-generation model.

## GitHub publishing

To prepare a local commit and optionally push it to a repository created by the operator:

```powershell
.\publish-github.ps1 -RepositoryUrl "https://github.com/<user>/<repo>.git" -Push
```

Authentication is handled by the user's Git credential manager or GitHub CLI. No token is stored in this project.

## Run a task

```powershell
.\run-task.ps1 `
  -Workspace "C:\path\to\project" `
  -Task "Türkçe görevi burada yaz" `
  -Acceptance "python -m pytest -q -p no:cacheprovider"
```

Live changes require semantic verification (project tests or an explicitly safe acceptance command). Syntax-only mode is available explicitly with `-AllowSyntaxOnly`.

When a project has no test suite, the verifier now looks for deterministic project checks such as `build`, `typecheck`, `lint`, or `check`. For source-only Python projects it uses `python -m compileall -q .`; for source-only JavaScript projects it checks each JavaScript module with `node --check`. These are smoke/static checks, not a claim that untested behavior is semantically correct.

## Safety behavior

Candidates are applied in a temporary copy first, then independently verified. Live changes are backed up and rolled back if verification fails. Validation rejects empty successful command output, unknown validation types, path traversal, and symlink/junction escapes. Task locking uses atomic creation and an alive process is not evicted solely because its heartbeat is old.

Only the JEV Typesafe provider is enabled by the published package. Qwen, Ollama, NVIDIA/Gemma and other provider fallbacks are disabled. The synthesis policy is enforced from `config/synthesis.json`, so stale `JEV_SYNTH_*` environment variables cannot silently activate another model. The Typesafe credential is read from the user's secure environment and is never written to task output.

The Codex setup session is not a permanent model service. A task cannot run while the computer is powered off; after restart, persisted state and logs remain available for recovery/inspection.
