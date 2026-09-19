import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename =
  fileURLToPath(
    import.meta.url
  );

const ROOT =
  path.dirname(
    __filename
  );

const CONFIG_DIR =
  path.join(
    ROOT,
    "config"
  );

const RUNTIME_DIR =
  path.join(
    ROOT,
    "runtime"
  );

const LOG_DIR =
  path.join(
    ROOT,
    "logs"
  );

const SNAPSHOT_DIR =
  path.join(
    ROOT,
    "snapshots"
  );

const AGENT_CONFIG =
  path.join(
    CONFIG_DIR,
    "agent.json"
  );

const WORKSPACE_CONFIG =
  path.join(
    CONFIG_DIR,
    "workspace.json"
  );

const ACTIVE_AGENT =
  path.join(
    RUNTIME_DIR,
    "active-agent.mjs"
  );

const STABLE_AGENT =
  path.join(
    RUNTIME_DIR,
    "stable-agent.mjs"
  );

const STATE = {
  child: null,

  lastStartAt: 0,

  intentionalStop: false,

  shuttingDown: false,

  pendingRestartReason: null,

  restartTimer: null,

  instabilityEvents: [],

  healthFailures: 0,

  workspaceTimer: null,

  runtimeTimer: null,

  suppressRuntimeWatchUntil: 0
};

fs.mkdirSync(
  LOG_DIR,
  {
    recursive: true
  }
);

fs.mkdirSync(
  SNAPSHOT_DIR,
  {
    recursive: true
  }
);

function readJson(
  file
) {
  const raw =
    fs.readFileSync(
      file,
      "utf8"
    );

  return JSON.parse(
    raw.replace(
      /^\uFEFF/,
      ""
    )
  );
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(
      /[:.]/g,
      "-"
    );
}

function log(
  message
) {
  const line =
    `[${new Date().toISOString()}] ${message}`;

  console.log(
    line
  );

  fs.appendFileSync(
    path.join(
      LOG_DIR,
      "supervisor.log"
    ),
    line + "\n"
  );
}

function filesEqual(
  a,
  b
) {
  if (
    !fs.existsSync(a) ||
    !fs.existsSync(b)
  ) {
    return false;
  }

  const aa =
    fs.readFileSync(
      a
    );

  const bb =
    fs.readFileSync(
      b
    );

  return aa.equals(
    bb
  );
}

function validateWorkspace(
  workspace
) {
  if (
    !workspace ||
    typeof workspace.path !== "string"
  ) {
    throw new Error(
      "workspace.json path missing"
    );
  }

  const resolved =
    path.resolve(
      workspace.path
    );

  if (
    !fs.existsSync(
      resolved
    )
  ) {
    throw new Error(
      `Workspace not found: ${resolved}`
    );
  }

  return resolved;
}

function clearRestartTimer() {
  if (
    STATE.restartTimer
  ) {
    clearTimeout(
      STATE.restartTimer
    );

    STATE.restartTimer =
      null;
  }
}

function scheduleStart(
  reason,
  delay = 1000
) {
  if (
    STATE.shuttingDown
  ) {
    return;
  }

  clearRestartTimer();

  log(
    `Agent start scheduled reason="${reason}" delay=${delay}ms`
  );

  STATE.restartTimer =
    setTimeout(
      () => {
        STATE.restartTimer =
          null;

        startAgent(
          reason
        );
      },
      delay
    );
}

function snapshotActive(
  reason
) {
  if (
    !fs.existsSync(
      ACTIVE_AGENT
    )
  ) {
    return;
  }

  const destination =
    path.join(
      SNAPSHOT_DIR,
      `failed-active-${timestamp()}.mjs`
    );

  fs.copyFileSync(
    ACTIVE_AGENT,
    destination
  );

  log(
    `Active runtime snapshot created reason="${reason}" file=${destination}`
  );
}

function activateStable(
  reason
) {
  if (
    !fs.existsSync(
      STABLE_AGENT
    )
  ) {
    log(
      "STABLE FALLBACK FAILED: stable-agent.mjs missing"
    );

    return false;
  }

  if (
    !filesEqual(
      ACTIVE_AGENT,
      STABLE_AGENT
    )
  ) {
    snapshotActive(
      reason
    );
  }

  STATE.suppressRuntimeWatchUntil =
    Date.now() + 4000;

  fs.copyFileSync(
    STABLE_AGENT,
    ACTIVE_AGENT
  );

  STATE.instabilityEvents = [];
  STATE.healthFailures = 0;

  log(
    `STABLE FALLBACK ACTIVATED reason="${reason}"`
  );

  return true;
}

function noteInstability(
  reason
) {
  const now =
    Date.now();

  STATE.instabilityEvents =
    STATE.instabilityEvents
      .filter(
        time =>
          now - time <
          60000
      );

  STATE.instabilityEvents.push(
    now
  );

  log(
    `Instability count=${STATE.instabilityEvents.length}/3 reason="${reason}"`
  );

  if (
    STATE.instabilityEvents.length <
    3
  ) {
    return false;
  }

  if (
    filesEqual(
      ACTIVE_AGENT,
      STABLE_AGENT
    )
  ) {
    log(
      "Stable runtime is already active; fallback skipped."
    );

    STATE.instabilityEvents = [];

    return false;
  }

  return activateStable(
    reason
  );
}

function requestRestart(
  reason,
  {
    instability = false
  } = {}
) {
  if (
    STATE.shuttingDown
  ) {
    return;
  }

  if (
    instability
  ) {
    const fellBack =
      noteInstability(
        reason
      );

    if (
      fellBack
    ) {
      reason =
        `stable fallback after ${reason}`;
    }
  }

  STATE.pendingRestartReason =
    reason;

  if (
    !STATE.child
  ) {
    scheduleStart(
      reason,
      500
    );

    return;
  }

  if (
    STATE.intentionalStop
  ) {
    return;
  }

  STATE.intentionalStop =
    true;

  log(
    `Restart requested reason="${reason}"`
  );

  try {
    STATE.child.kill();
  }
  catch (
    error
  ) {
    log(
      `Child stop error: ${error.message}`
    );

    STATE.child =
      null;

    STATE.intentionalStop =
      false;

    scheduleStart(
      reason,
      500
    );
  }
}

function startAgent(
  reason = "initial start"
) {
  if (
    STATE.shuttingDown ||
    STATE.child
  ) {
    return;
  }

  try {
    const config =
      readJson(
        AGENT_CONFIG
      );

    const workspace =
      readJson(
        WORKSPACE_CONFIG
      );

    const workspaceRoot =
      validateWorkspace(
        workspace
      );

    if (
      !fs.existsSync(
        ACTIVE_AGENT
      )
    ) {
      throw new Error(
        `Active agent missing: ${ACTIVE_AGENT}`
      );
    }

    STATE.lastStartAt =
      Date.now();

    STATE.healthFailures = 0;

    log(
      `Starting agent reason="${reason}"`
    );

    log(
      `Workspace: ${workspace.name} -> ${workspaceRoot}`
    );

    const env = {
      ...process.env,

      /*
        Legacy compatibility for V4.
        Name will disappear after runtime refactor.
      */
      JEV_WORKSPACE_ROOT:
        workspaceRoot,

      JEV_GENERAL_AGENT_ROOT:
        ROOT
    };

    const child =
      spawn(
        process.execPath,
        [
          ACTIVE_AGENT
        ],
        {
          cwd:
            ROOT,

          env,

          stdio:
            [
              "ignore",
              "pipe",
              "pipe"
            ]
        }
      );

    STATE.child =
      child;

    child.stdout.on(
      "data",
      data => {
        process.stdout.write(
          data
        );

        fs.appendFileSync(
          path.join(
            LOG_DIR,
            "agent.log"
          ),
          data
        );
      }
    );

    child.stderr.on(
      "data",
      data => {
        process.stderr.write(
          data
        );

        fs.appendFileSync(
          path.join(
            LOG_DIR,
            "agent-error.log"
          ),
          data
        );
      }
    );

    child.on(
      "exit",
      (
        code,
        signal
      ) => {
        const intentional =
          STATE.intentionalStop;

        const restartReason =
          STATE.pendingRestartReason;

        STATE.child =
          null;

        STATE.intentionalStop =
          false;

        STATE.pendingRestartReason =
          null;

        if (
          STATE.shuttingDown
        ) {
          return;
        }

        log(
          `Agent stopped code=${code} signal=${signal} intentional=${intentional}`
        );

        if (
          intentional
        ) {
          scheduleStart(
            restartReason ||
            "requested reload",
            500
          );

          return;
        }

        const fellBack =
          noteInstability(
            `unexpected exit code=${code}`
          );

        scheduleStart(
          fellBack
            ? "stable fallback"
            : "crash recovery",
          1500
        );
      }
    );

    log(
      `Agent process started pid=${child.pid}`
    );

    if (
      config.autoRestart === false
    ) {
      log(
        "WARNING: agent.json autoRestart=false"
      );
    }
  }
  catch (
    error
  ) {
    log(
      `START ERROR: ${error.stack || error}`
    );

    scheduleStart(
      "start retry",
      3000
    );
  }
}

async function healthCheck() {
  if (
    STATE.shuttingDown ||
    !STATE.child ||
    STATE.intentionalStop
  ) {
    return;
  }

  /*
    Startup grace period.
  */
  if (
    Date.now() -
    STATE.lastStartAt <
    8000
  ) {
    return;
  }

  try {
    const response =
      await fetch(
        "http://127.0.0.1:4012/health",
        {
          signal:
            AbortSignal.timeout(
              2500
            )
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    if (
      STATE.healthFailures > 0
    ) {
      log(
        "Agent health recovered"
      );
    }

    STATE.healthFailures = 0;
  }
  catch (
    error
  ) {
    STATE.healthFailures += 1;

    log(
      `Health failure ${STATE.healthFailures}/3: ${error.message}`
    );

    if (
      STATE.healthFailures >= 3
    ) {
      STATE.healthFailures = 0;

      requestRestart(
        "health check failed",
        {
          instability: true
        }
      );
    }
  }
}

function installWatchers() {
  fs.watch(
    CONFIG_DIR,
    (
      eventType,
      filename
    ) => {
      if (
        filename !==
        "workspace.json"
      ) {
        return;
      }

      clearTimeout(
        STATE.workspaceTimer
      );

      STATE.workspaceTimer =
        setTimeout(
          () => {
            try {
              const workspace =
                readJson(
                  WORKSPACE_CONFIG
                );

              const workspaceRoot =
                validateWorkspace(
                  workspace
                );

              log(
                `Workspace change detected -> ${workspace.name} (${workspaceRoot})`
              );

              requestRestart(
                "workspace changed"
              );
            }
            catch (
              error
            ) {
              log(
                `Workspace reload rejected: ${error.message}`
              );
            }
          },
          500
        );
    }
  );

  fs.watch(
    RUNTIME_DIR,
    (
      eventType,
      filename
    ) => {
      if (
        filename !==
        "active-agent.mjs"
      ) {
        return;
      }

      if (
        Date.now() <
        STATE.suppressRuntimeWatchUntil
      ) {
        return;
      }

      clearTimeout(
        STATE.runtimeTimer
      );

      STATE.runtimeTimer =
        setTimeout(
          () => {
            log(
              "Active runtime change detected"
            );

            requestRestart(
              "active runtime changed"
            );
          },
          750
        );
    }
  );

  log(
    "Hot workspace watcher: ENABLED"
  );

  log(
    "Hot active-runtime watcher: ENABLED"
  );
}

function shutdown(
  signal
) {
  if (
    STATE.shuttingDown
  ) {
    return;
  }

  STATE.shuttingDown =
    true;

  clearRestartTimer();

  log(
    `Supervisor shutdown signal=${signal}`
  );

  if (
    STATE.child
  ) {
    try {
      STATE.child.kill();
    }
    catch {
      // ignored during shutdown
    }
  }

  setTimeout(
    () => {
      process.exit(
        0
      );
    },
    500
  );
}

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "uncaughtException",
  error => {
    log(
      `SUPERVISOR ERROR: ${error.stack || error}`
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    log(
      `SUPERVISOR REJECTION: ${error?.stack || error}`
    );
  }
);

log(
  "JEV GENERAL SUPERVISOR V2 STARTING"
);

log(
  "Crash recovery: ENABLED"
);

log(
  "Stable fallback: ENABLED"
);

installWatchers();

startAgent(
  "supervisor startup"
);

setInterval(
  healthCheck,
  10000
);
