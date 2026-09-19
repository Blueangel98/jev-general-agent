# Contributing

JEV is a local, general-purpose coding agent. Contributions must remain project-agnostic and must not add exchange, broker, or application-specific behavior to the runtime.

Before opening a pull request:

```powershell
node --check runtime/active-agent.mjs
node --check runtime/stable-agent.mjs
node evaluations/core-regression-probe.mjs
node autonomy/acceptance-engine-probe.mjs
node autonomy/sandbox-security-probe.mjs
node self-improvement/manager.mjs test-cycle
```

Never commit API keys, workspace-specific logs, task memory, snapshots, or backup files.

The JEV Typesafe key is supplied by each installation through `configure-jev.ps1`; it must never be added to a commit.
