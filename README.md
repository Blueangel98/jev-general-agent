# JEV General Agent

JEV is a local task runner and Cline-compatible proxy for general development work. The decision/control plane remains local; configured providers are used for planning, synthesis and repair decisions.

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

The code self-improvement path is bounded: candidate -> syntax/security/evaluation -> promote, reject, or rollback. Run `node self-improvement/manager.mjs test-cycle` to verify the rejection and rollback path. A trusted source change should be followed by `node self-improvement/manager.mjs rebaseline`.

The agent does not claim parity with a frontier ChatGPT model. It provides the local equivalent workflow: inspect the selected workspace, edit through an isolated candidate, execute explicit validation commands, preserve evidence, and apply only a passing result.

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

## Safety behavior

Candidates are applied in a temporary copy first, then independently verified. Live changes are backed up and rolled back if verification fails. Validation rejects empty successful command output, unknown validation types, path traversal, and symlink/junction escapes. Task locking uses atomic creation and an alive process is not evicted solely because its heartbeat is old.

Only the JEV Typesafe provider is supported by the published package. Qwen, Ollama, NVIDIA/Gemma and other provider fallbacks are disabled. The Typesafe credential is read from the user's secure environment and is never written to task output.

The Codex setup session is not a permanent model service. A task cannot run while the computer is powered off; after restart, persisted state and logs remain available for recovery/inspection.
