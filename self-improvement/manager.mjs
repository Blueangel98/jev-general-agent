import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  fileURLToPath
} from "node:url";

import {
  evaluateCandidate,
  sha256
} from "./evaluator.mjs";

const __filename =
  fileURLToPath(
    import.meta.url
  );

const ROOT =
  path.dirname(
    path.dirname(
      __filename
    )
  );

const ACTIVE =
  path.join(
    ROOT,
    "runtime",
    "active-agent.mjs"
  );

const STABLE =
  path.join(
    ROOT,
    "runtime",
    "stable-agent.mjs"
  );

const CANDIDATE =
  path.join(
    ROOT,
    "runtime",
    "candidate-agent.mjs"
  );

const SUPERVISOR =
  path.join(
    ROOT,
    "supervisor.mjs"
  );

const STATE_FILE =
  path.join(
    ROOT,
    "self-improvement",
    "state.json"
  );

const HISTORY =
  path.join(
    ROOT,
    "memory",
    "repair-history.jsonl"
  );

const SNAPSHOTS =
  path.join(
    ROOT,
    "snapshots"
  );

function now() {
  return new Date()
    .toISOString();
}

function blankState() {
  return {
    status:
      "idle",

    baselineStableHash:
      null,

    baselineSupervisorHash:
      null,

    candidateCreatedAt:
      null,

    lastEvaluation:
      null,

    lastPromotion:
      null,

    lastRejection:
      null,

    activeHash:
      null,

    stableHash:
      null,

    candidateHash:
      null
  };
}

function readJson(file) {
  if (
    !fs.existsSync(file)
  ) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      file,
      "utf8"
    )
      .replace(
        /^\uFEFF/,
        ""
      )
  );
}

function writeJson(
  file,
  value
) {
  const temp =
    `${file}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(
      value,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temp,
    file
  );
}

function appendHistory(
  action,
  result,
  extra = {}
) {
  fs.appendFileSync(
    HISTORY,
    JSON.stringify({
      timestamp:
        now(),

      action,

      result,

      ...extra
    }) + "\n",
    "utf8"
  );
}

function ensureState() {
  let state =
    readJson(
      STATE_FILE
    ) ||
    blankState();

  if (
    !state.baselineStableHash
  ) {
    state.baselineStableHash =
      sha256(
        STABLE
      );
  }

  if (
    !state.baselineSupervisorHash
  ) {
    state.baselineSupervisorHash =
      sha256(
        SUPERVISOR
      );
  }

  state.activeHash =
    sha256(
      ACTIVE
    );

  state.stableHash =
    sha256(
      STABLE
    );

  if (
    fs.existsSync(
      CANDIDATE
    )
  ) {
    state.candidateHash =
      sha256(
        CANDIDATE
      );
  }

  writeJson(
    STATE_FILE,
    state
  );

  return state;
}

function protectedFilesValid(
  state
) {
  return (
    sha256(STABLE) ===
      state.baselineStableHash &&
    sha256(SUPERVISOR) ===
      state.baselineSupervisorHash
  );
}

function prepare() {
  const state =
    ensureState();

  if (
    !protectedFilesValid(
      state
    )
  ) {
    throw new Error(
      "Protected file hash mismatch"
    );
  }

  fs.copyFileSync(
    ACTIVE,
    CANDIDATE
  );

  state.status =
    "candidate_ready";

  state.candidateCreatedAt =
    now();

  state.candidateHash =
    sha256(
      CANDIDATE
    );

  writeJson(
    STATE_FILE,
    state
  );

  appendHistory(
    "prepare",
    "success",
    {
      candidateHash:
        state.candidateHash
    }
  );

  return state;
}

function rebaseline() {
  const stableCheck = spawnSync(process.execPath, ["--check", STABLE], { encoding: "utf8" });
  const supervisorCheck = spawnSync(process.execPath, ["--check", SUPERVISOR], { encoding: "utf8" });
  if (stableCheck.status !== 0 || supervisorCheck.status !== 0) {
    throw new Error("Cannot rebaseline invalid protected source files");
  }

  const state = ensureState();
  state.baselineStableHash = sha256(STABLE);
  state.baselineSupervisorHash = sha256(SUPERVISOR);
  state.status = "baseline_updated";
  state.lastBaselineUpdate = now();
  writeJson(STATE_FILE, state);
  appendHistory("rebaseline", "success", {
    stableHash: state.baselineStableHash,
    supervisorHash: state.baselineSupervisorHash
  });
  return state;
}

function evaluate() {
  const state =
    ensureState();

  const result =
    evaluateCandidate(
      CANDIDATE
    );

  state.status =
    result.pass
      ? "evaluation_pass"
      : "evaluation_fail";

  state.lastEvaluation = {
    timestamp:
      now(),

    pass:
      result.pass,

    checks:
      result.checks
  };

  state.candidateHash =
    result.candidateHash ||
    null;

  writeJson(
    STATE_FILE,
    state
  );

  appendHistory(
    "evaluate",
    result.pass
      ? "pass"
      : "fail",
    {
      candidateHash:
        state.candidateHash
    }
  );

  return result;
}

function snapshotActive() {
  fs.mkdirSync(
    SNAPSHOTS,
    {
      recursive: true
    }
  );

  const file =
    path.join(
      SNAPSHOTS,
      `active-${Date.now()}.mjs`
    );

  fs.copyFileSync(
    ACTIVE,
    file
  );

  return file;
}

function promote() {
  const state =
    ensureState();

  if (
    !protectedFilesValid(
      state
    )
  ) {
    throw new Error(
      "Protected file hash mismatch"
    );
  }

  const evaluation =
    evaluate();

  if (
    !evaluation.pass
  ) {
    appendHistory(
      "promote",
      "rejected_evaluation_failed"
    );

    throw new Error(
      "Candidate evaluation failed"
    );
  }

  const snapshot =
    snapshotActive();

  const next =
    path.join(
      ROOT,
      "runtime",
      `active-agent.next-${process.pid}.mjs`
    );

  fs.copyFileSync(
    CANDIDATE,
    next
  );

  try {
    fs.renameSync(
      next,
      ACTIVE
    );
  }
  catch {
    fs.copyFileSync(
      next,
      ACTIVE
    );

    fs.rmSync(
      next,
      {
        force: true
      }
    );
  }

  state.status =
    "promoted";

  state.lastPromotion = {
    timestamp:
      now(),

    snapshot
  };

  state.activeHash =
    sha256(
      ACTIVE
    );

  state.stableHash =
    sha256(
      STABLE
    );

  writeJson(
    STATE_FILE,
    state
  );

  appendHistory(
    "promote",
    "success",
    {
      activeHash:
        state.activeHash,

      stableHash:
        state.stableHash,

      snapshot
    }
  );

  return state;
}

function reject(
  reason = "manual"
) {
  const state =
    ensureState();

  fs.rmSync(
    CANDIDATE,
    {
      force: true
    }
  );

  state.status =
    "rejected";

  state.lastRejection = {
    timestamp:
      now(),

    reason
  };

  state.candidateHash =
    null;

  writeJson(
    STATE_FILE,
    state
  );

  appendHistory(
    "reject",
    "success",
    {
      reason
    }
  );

  return state;
}

function status() {
  const state =
    ensureState();

  return {
    ...state,

    protectedFilesValid:
      protectedFilesValid(
        state
      ),

    candidateExists:
      fs.existsSync(
        CANDIDATE
      )
  };
}

function testCycle() {
  const initial =
    ensureState();

  const stableBefore =
    sha256(
      STABLE
    );

  const supervisorBefore =
    sha256(
      SUPERVISOR
    );

  prepare();

  const passEvaluation =
    evaluate();

  if (
    !passEvaluation.pass
  ) {
    throw new Error(
      "PASS candidate unexpectedly failed"
    );
  }

  promote();

  const activeAfterPromotion =
    sha256(
      ACTIVE
    );

  const stableAfterPromotion =
    sha256(
      STABLE
    );

  prepare();

  fs.appendFileSync(
    CANDIDATE,
    "\nTHIS IS INTENTIONALLY INVALID JAVASCRIPT !!!\n",
    "utf8"
  );

  const failEvaluation =
    evaluate();

  if (
    failEvaluation.pass
  ) {
    throw new Error(
      "Bad candidate unexpectedly passed"
    );
  }

  const activeBeforeReject =
    sha256(
      ACTIVE
    );

  reject(
    "controlled_bad_candidate"
  );

  const activeAfterReject =
    sha256(
      ACTIVE
    );

  const stableFinal =
    sha256(
      STABLE
    );

  const supervisorFinal =
    sha256(
      SUPERVISOR
    );

  const result = {
    passScenario:
      passEvaluation.pass,

    rejectionScenario:
      !failEvaluation.pass,

    activeUnchangedByReject:
      activeBeforeReject ===
      activeAfterReject,

    stableUnchanged:
      stableBefore ===
      stableAfterPromotion &&
      stableBefore ===
      stableFinal,

    supervisorUnchanged:
      supervisorBefore ===
      supervisorFinal,

    activeHash:
      activeAfterReject,

    stableHash:
      stableFinal,

    ready:
      passEvaluation.pass &&
      !failEvaluation.pass &&
      activeBeforeReject ===
        activeAfterReject &&
      stableBefore ===
        stableFinal &&
      supervisorBefore ===
        supervisorFinal
  };

  appendHistory(
    "test-cycle",
    result.ready
      ? "pass"
      : "fail",
    result
  );

  return result;
}

const command =
  process.argv[2] ||
  "status";

let output;

switch (
  command
) {
  case "init":
    output =
      ensureState();
    break;

  case "status":
    output =
      status();
    break;

  case "prepare":
    output =
      prepare();
    break;

  case "rebaseline":
    output = rebaseline();
    break;

  case "evaluate":
    output =
      evaluate();
    break;

  case "promote":
    output =
      promote();
    break;

  case "reject":
    output =
      reject(
        process.argv[3] ||
        "manual"
      );
    break;

  case "test-cycle":
    output =
      testCycle();
    break;

  default:
    throw new Error(
      `Unknown command: ${command}`
    );
}

console.log(
  JSON.stringify(
    output,
    null,
    2
  )
);
