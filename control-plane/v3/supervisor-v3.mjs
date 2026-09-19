import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repairFailure } from "./repair-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RUN_TASK = path.join(ROOT, "run-task.ps1");
const WORKER_RUNTIME = path.join(HERE, "worker-runtime.mjs");
const WORKSPACE_FILE = path.join(ROOT, "config", "workspace.json");
const STATE_DIR = path.join(HERE, "state");
const LOG_DIR = path.join(HERE, "logs");
const LOCK_FILE = path.join(STATE_DIR, "active-task.json");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function decode(v) {
  return Buffer.from(v || "", "base64").toString("utf8");
}

function parseArgs(argv) {
  const out = { task: "", acceptance: "", workspace: "", allowSyntaxOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-b64") out.task = decode(argv[++i]);
    else if (argv[i] === "--acceptance-b64") out.acceptance = decode(argv[++i]);
    else if (argv[i] === "--workspace") out.workspace = argv[++i] || "";
    else if (argv[i] === "--allow-syntax-only") out.allowSyntaxOnly = true;
  }
  return out;
}

function writeState(taskId, stage, status, extra = {}) {
  const file = path.join(STATE_DIR, `${taskId}.json`);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  fs.writeFileSync(file, JSON.stringify({
    ...previous,
    taskId,
    timestamp: new Date().toISOString(),
    stage,
    status,
    ...extra
  }, null, 2));
}

const sleep =
  ms =>
    new Promise(
      resolve =>
        setTimeout(resolve, ms)
    );

// JEV_SUPERVISOR_V31_QUEUE_LEASE
let leaseTimer = null;

function processExists(pid) {
  if (
    !Number.isInteger(Number(pid)) ||
    Number(pid) <= 0
  ) {
    return false;
  }

  try {
    process.kill(
      Number(pid),
      0
    );

    return true;
  }
  catch {
    return false;
  }
}

function readLock() {
  if (
    !fs.existsSync(
      LOCK_FILE
    )
  ) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(
        LOCK_FILE,
        "utf8"
      ).replace(
        /^\uFEFF/,
        ""
      )
    );
  }
  catch {
    return {
      malformed:
        true
    };
  }
}

function writeLock(taskId) {
  const now =
    new Date()
      .toISOString();

  const payload = JSON.stringify(
      {
        taskId,
        pid:
          process.pid,
        startedAt:
          now,
        heartbeatAt:
          now
      },
      null,
      2
    );

  let fd;
  try {
    fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, payload, "utf8");
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function refreshLease(taskId) {
  const current =
    readLock();

  if (
    !current ||
    current.taskId !==
      taskId ||
    Number(current.pid) !==
      process.pid
  ) {
    return;
  }

  current.heartbeatAt =
    new Date()
      .toISOString();

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify(
      current,
      null,
      2
    )
  );
}

function startLease(taskId) {
  if (
    leaseTimer
  ) {
    clearInterval(
      leaseTimer
    );
  }

  refreshLease(
    taskId
  );

  leaseTimer =
    setInterval(
      () => {
        try {
          refreshLease(
            taskId
          );
        }
        catch {}
      },
      5000
    );
}

async function acquire(taskId) {
  const queueWaitMs =
    Math.max(
      30000,
      Number(
        process.env
          .JEV_TASK_QUEUE_WAIT_MS ||
        3600000
      )
    );

  const staleLeaseMs =
    Math.max(
      60000,
      Number(
        process.env
          .JEV_TASK_LOCK_STALE_MS ||
        180000
      )
    );

  const deadline =
    Date.now() +
    queueWaitMs;

  let announcedOwner =
    "";

  while (
    true
  ) {
    const old =
      readLock();

    if (!old && writeLock(taskId)) {

      startLease(
        taskId
      );

      console.log(
        `[WORKER_QUEUE] lock_acquired=true task_id=${taskId}`
      );

      return;
    }

    if (!old) {
      await sleep(25);
      continue;
    }

    if (
      old.malformed ===
      true
    ) {
      console.log(
        "[WORKER_QUEUE] malformed_lock_recovered=true"
      );

      fs.rmSync(
        LOCK_FILE,
        {
          force:
            true
        }
      );

      continue;
    }

    if (
      old.taskId ===
        taskId &&
      Number(old.pid) ===
        process.pid
    ) {
      startLease(
        taskId
      );

      return;
    }

    const alive =
      processExists(
        old.pid
      );

    const heartbeatMs =
      Date.parse(
        old.heartbeatAt ||
        old.startedAt ||
        ""
      );

    const heartbeatAgeMs =
      Number.isFinite(
        heartbeatMs
      )
        ? Date.now() -
          heartbeatMs
        : Infinity;

    if (!alive) {
      console.log(
        `[WORKER_QUEUE] stale_lock_recovered=true owner=${old.taskId || "unknown"} pid=${old.pid || "unknown"} alive=${alive} heartbeat_age_ms=${Math.max(0, Math.round(heartbeatAgeMs))}`
      );

       fs.rmSync(
        LOCK_FILE,
        {
          force:
            true
        }
      );

      continue;
    }

    if (
      announcedOwner !==
      String(
        old.taskId ||
        old.pid ||
        "unknown"
      )
    ) {
      announcedOwner =
        String(
          old.taskId ||
          old.pid ||
          "unknown"
        );

      console.log(
        `[WORKER_QUEUE] waiting_for=${announcedOwner} owner_pid=${old.pid} queue=true`
      );
    }

    if (
      Date.now() >=
      deadline
    ) {
      throw new Error(
        `Task queue wait exceeded ${queueWaitMs} ms while waiting for ${old.taskId || old.pid || "active task"}`
      );
    }

    await sleep(
      2000
    );
  }
}

function release(taskId) {
  if (
    leaseTimer
  ) {
    clearInterval(
      leaseTimer
    );

    leaseTimer =
      null;
  }

  const current =
    readLock();

  if (
    current &&
    current.taskId ===
      taskId &&
    Number(current.pid) ===
      process.pid
  ) {
    fs.rmSync(
      LOCK_FILE,
      {
        force:
          true
      }
    );

    console.log(
      `[WORKER_QUEUE] lock_released=true task_id=${taskId}`
    );
  }
}
function workspace() {
  const x = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8").replace(/^\uFEFF/, ""));
  return path.resolve(x.path);
}

function runTask(args, taskId, attempt) {
  return new Promise((resolve) => {
    const psArgs = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", RUN_TASK,
      "-Task", args.task
    ];
    if (args.acceptance) psArgs.push("-Acceptance", args.acceptance);
    if (args.workspace) psArgs.push("-Workspace", args.workspace);
    if (args.allowSyntaxOnly) psArgs.push("-AllowSyntaxOnly");

    const child = spawn("powershell.exe", psArgs, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      shell: false
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });

    child.stderr.on("data", d => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, Number(process.env.JEV_DIRECT_AUTONOMY_TIMEOUT_MS || 3600000));

    child.on("close", code => {
      clearTimeout(timer);
      const combined = stdout + "\n" + stderr;
      fs.writeFileSync(path.join(LOG_DIR, `${taskId}-attempt-${attempt}.log`), combined);
      resolve({ code: Number(code ?? 4), stdout, stderr, combined });
    });

    child.on("error", err => {
      clearTimeout(timer);
      const combined = stdout + "\n" + stderr + "\n" + String(err?.stack || err);
      fs.writeFileSync(path.join(LOG_DIR, `${taskId}-attempt-${attempt}.log`), combined);
      resolve({ code: 4, stdout, stderr, combined });
    });
  });
}

function runWorker(role, ws, task, evidence = {}) {
  return new Promise(resolve => {
    const worker = spawn(process.execPath, [
      WORKER_RUNTIME,
      "--role", role,
      "--workspace", ws,
      "--task-b64", Buffer.from(task || "", "utf8").toString("base64"),
      "--evidence-b64", Buffer.from(JSON.stringify(evidence), "utf8").toString("base64")
    ], { cwd: ROOT, env: process.env, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ code: Number(code ?? 4), parsed, stdout, stderr, error: error ? String(error) : null });
    };
    worker.stdout.on("data", data => { stdout += data.toString(); });
    worker.stderr.on("data", data => { stderr += data.toString(); });
    timer = setTimeout(() => {
      try { worker.kill(); } catch {}
      finish(124, "worker timeout");
    }, Math.min(120000, Number(process.env.JEV_WORKER_TIMEOUT_MS || 60000)));
    worker.on("error", error => finish(4, error));
    worker.on("close", code => finish(code));
  });
}

function terminalStatus(text, code) {
  const matches = [...String(text || "").matchAll(/"status"\s*:\s*"(APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)"/gi)];
  if (matches.length) return matches[matches.length - 1][1].toUpperCase();
  return code === 0 ? "NEEDS_VERIFICATION" : "ERROR";
}

function emitTerminal(obj, code = 4) {
  console.log(JSON.stringify(obj, null, 2));
  process.exitCode = code;
}

const args = parseArgs(process.argv.slice(2));
const taskId = `TASK-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;

if (!args.task.trim()) {
  emitTerminal({ status: "NEEDS_VERIFICATION", stage: "supervisor", retryable: false, reason: "Task is empty." });
} else {
  try {
    await acquire(taskId);
    const ws = path.resolve(args.workspace || workspace());
    console.log(`[SUPERVISOR_V3] task_id=${taskId}`);
    console.log("[SUPERVISOR_V3] self_healing=true");
    console.log(`[WORKER_SCOUT] workspace=${ws}`);

    writeState(taskId, "SCOUT", "RUNNING", { workspace: ws, task: args.task });
    const scout = await runWorker("scout", ws, args.task);
    if (scout.code !== 0 || scout.parsed?.ok !== true) {
      throw new Error(`Scout worker failed: ${scout.stderr || scout.stdout || scout.error || "unknown error"}`);
    }

    writeState(taskId, "SCOUT", "PASS", { workspace: ws, worker: scout.parsed });

    console.log("[WORKER_PLANNER] planning_with_local_synthesis=true");
    writeState(taskId, "PLANNER", "RUNNING", { worker: "planner" });
    const planner = await runWorker("planner", ws, args.task, { scout: scout.parsed });
    if (planner.code !== 0 || planner.parsed?.ok !== true) {
      throw new Error(`Planner worker failed: ${planner.stderr || planner.stdout || planner.error || "unknown error"}`);
    }
    writeState(taskId, "PLANNER", "PASS", { worker: planner.parsed });
    console.log(`[WORKER_PLANNER] verification=${(planner.parsed.verificationCommands || []).join(" | ") || "none"} synthesis=${planner.parsed.synthesisProvider}`);

    const plannedArgs = {
      ...args,
      acceptance: args.acceptance || planner.parsed.verificationCommands?.[0] || ""
    };

    let repairDepth = 0;
    const maxRepairDepth = Number(process.env.JEV_SELF_HEAL_MAX_REPAIRS || 2);
    let completed = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[WORKER_BUILDER] attempt=${attempt}/3`);
      writeState(taskId, "BUILDER", "RUNNING", { attempt, repairDepth });

      const result = await runTask(plannedArgs, taskId, attempt);
      const status = terminalStatus(result.combined, result.code);

      console.log(`[WORKER_VALIDATOR] terminal=${status} exit=${result.code}`);

      const validator = await runWorker("validator", ws, args.task, {
        status,
        code: result.code,
        output: result.combined
      });
      if (validator.parsed?.ok !== true) {
        console.log(`[WORKER_VALIDATOR] independent_check=false reason=${validator.parsed?.error || "terminal evidence rejected"}`);
      }

      const reviewer = await runWorker("reviewer", ws, args.task, {
        status,
        code: result.code,
        changed: result.combined.match(/"changed"\s*:\s*\[([\s\S]*?)\]/i)?.[1]?.match(/"([^\"]+)"/g)?.map(value => value.slice(1, -1)) || [],
        validatorOk: validator.parsed?.ok === true,
        planner: planner.parsed
      });
      console.log(`[WORKER_REVIEWER] accepted=${reviewer.parsed?.ok === true} review=${reviewer.parsed?.review || reviewer.parsed?.error || "unknown"}`);

      if (status === "APPLIED" && result.code === 0 && validator.parsed?.ok === true && reviewer.parsed?.ok === true) {
        writeState(taskId, "REPORTER", "APPLIED", { attempt, repairDepth, planner: planner.parsed, validator: validator.parsed, reviewer: reviewer.parsed });
        console.log("[SUPERVISOR_V3] final=APPLIED");
        process.exitCode = 0;
        completed = true;
        break;
      }

      if (repairDepth >= maxRepairDepth) {
        writeState(taskId, "REPORTER", "NEEDS_VERIFICATION", { attempt, repairDepth });
        emitTerminal({
          status: "NEEDS_VERIFICATION",
          stage: "self_heal",
          retryable: false,
          reason: "Autonomous self-heal budget exhausted.",
          taskId
        });
        completed = true;
        break;
      }

      console.log(`[WORKER_REPAIRER] analyzing_failure repair_depth=${repairDepth + 1}/${maxRepairDepth}`);
      writeState(taskId, "REPAIRER", "RUNNING", { attempt, repairDepth: repairDepth + 1 });

      const repair = await repairFailure({
        failureText: result.combined,
        taskId
      });

      console.log(`[WORKER_REPAIRER] action=${repair.action} changed=${(repair.changed || []).join(",") || "none"}`);

      if (repair.action === "retry_only") {
        console.log("[WORKER_RECOVERY] retrying_without_code_change=true");
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (repair.action === "repaired") {
        repairDepth += 1;
        console.log(`[WORKER_RECOVERY] repair_applied=true worker_created=${repair.workerCreated === true}`);
        console.log("[WORKER_RECOVERY] rerunning_original_task=true");
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      writeState(taskId, "REPORTER", "NEEDS_VERIFICATION", { attempt, repairDepth, repair });
      emitTerminal({
        status: "NEEDS_VERIFICATION",
        stage: "self_heal",
        retryable: false,
        reason: repair.reason || "Jev did not authorize a safe autonomous repair.",
        taskId,
        repair
      });
      completed = true;
      break;
    }

    if (!completed) {
      writeState(taskId, "REPORTER", "NEEDS_VERIFICATION", { reason: "Attempt budget exhausted without a verified terminal result." });
      emitTerminal({
        status: "NEEDS_VERIFICATION",
        stage: "reporter",
        retryable: false,
        reason: "Attempt budget exhausted without a verified terminal result.",
        taskId
      });
    }
  } catch (err) {
    writeState(taskId, "CONTROL_PLANE", "ERROR", { error: String(err?.stack || err) });
    emitTerminal({
      status: "NEEDS_VERIFICATION",
      stage: "control_plane",
      retryable: false,
      reason: String(err?.message || err),
      taskId
    });
  } finally {
    release(taskId);
  }
}
