import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildContext } from "./context-builder.mjs";
import { deriveSafeAcceptance } from "./acceptance-deriver.mjs";
import { experienceContext } from "../memory/experience-store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE_FILE = path.join(ROOT, "config", "workspace.json");
const PROPOSALS = path.join(ROOT, "proposals");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function decodeB64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function parseArgs(argv) {
  const acceptance = [];
  let allowSyntaxOnly = false;
  let task = "";
  let workspace = "";
  const legacyTaskParts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--task-b64") {
      const next = argv[++i];
      if (!next) throw new Error("--task-b64 requires a value");
      task = decodeB64(next);
      continue;
    }

    if (arg === "--acceptance-b64") {
      const next = argv[++i];
      if (!next) throw new Error("--acceptance-b64 requires a value");
      acceptance.push(decodeB64(next));
      continue;
    }

    if (arg === "--acceptance") {
      const next = argv[++i];
      if (!next) throw new Error("--acceptance requires a command");
      acceptance.push(next);
      continue;
    }

    if (arg === "--allow-syntax-only") {
      allowSyntaxOnly = true;
      continue;
    }

    if (arg === "--workspace") {
      const next = argv[++i];
      if (!next) throw new Error("--workspace requires a value");
      workspace = next;
      continue;
    }

    legacyTaskParts.push(arg);
  }

  if (!task) task = legacyTaskParts.join(" ").trim();

  return {
    task: task.trim(),
    acceptance,
    allowSyntaxOnly,
    workspace: workspace.trim()
  };
}

import { extractExplicitAcceptanceCommands } from "./explicit-acceptance.mjs";

const args = parseArgs(process.argv.slice(2));

const explicitAcceptance =
  extractExplicitAcceptanceCommands(
    args.task
  );

if (
  args.acceptance.length === 0 &&
  explicitAcceptance.commands.length > 0
) {
  args.acceptance.push(
    ...explicitAcceptance.commands
  );
}

if (
  args.acceptance.length === 0 &&
  explicitAcceptance.rejected.length > 0
) {
  console.log(
    JSON.stringify(
      {
        status:
          "NEEDS_VERIFICATION",

        reason:
          "Explicit acceptance command was rejected by the deterministic safety policy.",

        rejectedAcceptance:
          explicitAcceptance.rejected
      },
      null,
      2
    )
  );

  process.exit(4);
}

if (!args.task) {
  throw new Error(
    'Usage: node autonomy/general-task.mjs --task-b64 <base64> [--acceptance-b64 <base64>] [--allow-syntax-only]'
  );
}

const configuredWorkspace = readJson(WORKSPACE_FILE).path || "";
const workspaceValue = args.workspace || process.env.JEV_WORKSPACE_ROOT || configuredWorkspace;
if (!workspaceValue) {
  throw new Error("JEV workspace is not configured. Pass --workspace or set JEV_WORKSPACE_ROOT.");
}
const workspace = path.resolve(workspaceValue);

if (!fs.existsSync(workspace)) {
  throw new Error(`Workspace missing: ${workspace}`);
}

const discovered = buildContext({
  workspace,
  task: args.task
});

const priorExperience = experienceContext(args.task);

let autoAcceptance = null;

function isHandledBySandboxProjectTest(command) {
  return /^(?:npm test|python -m pytest -q(?:\s+-p\s+no:cacheprovider)?|gradlew\.bat test|\.\/gradlew test)$/i.test(String(command || "").trim());
}

function scaffoldAcceptance(task) {
  if (!/```[\s\S]*```/m.test(String(task || ""))) return null;
  const file = String(task || "").match(/\b([A-Za-z0-9_.\/-]+\.(?:py|js|mjs|cjs))\b/i)?.[1];
  if (!file) return null;
  if (/\.py$/i.test(file)) return `python -m py_compile "${file}"`;
  return `node --check "${file}"`;
}

if (args.acceptance.length === 0 && discovered.verificationCommands.length > 0) {
  args.acceptance.push(
    ...discovered.verificationCommands.filter(command => !isHandledBySandboxProjectTest(command))
  );
}

if (args.acceptance.length === 0) {
  const scaffoldCommand = scaffoldAcceptance(args.task);
  if (scaffoldCommand) args.acceptance.push(scaffoldCommand);
}

if (
  args.acceptance.length === 0 &&
  discovered.verificationCommands.length === 0 &&
  !args.allowSyntaxOnly
) {
  const derived =
    deriveSafeAcceptance({
      task: args.task
    });

  if (
    derived.derived
  ) {
    autoAcceptance =
      derived;

    args.acceptance.push(
      derived.command
    );
  }
}

const hasSemanticVerification =
  discovered.verificationCommands.length > 0 ||
  args.acceptance.length > 0;

if (!hasSemanticVerification && !args.allowSyntaxOnly) {
  console.log(JSON.stringify({
    status: "NEEDS_VERIFICATION",
    workspace,
    reason:
      "No project test suite, explicit acceptance command, or supported deterministic auto-acceptance could be derived. Live apply remains blocked.",
    selectedContextFiles: discovered.contextFiles,
    hint:
      "A safe deterministic acceptance pattern is required for behavioral code changes."
  }, null, 2));

  process.exit(4);
}

fs.mkdirSync(PROPOSALS, { recursive: true });

const specFile =
  path.join(
    PROPOSALS,
    `auto-task-${Date.now()}.json`
  );

writeJson(specFile, {
  task: args.task,
  context:
    discovered.context +
    (priorExperience ? `\n\n${priorExperience}` : "") +
    "\n\nSafety: make the smallest evidence-supported change. Do not touch supervisor.mjs or runtime/stable-agent.mjs.",
  contextFiles: discovered.contextFiles,
  acceptanceCommands: args.acceptance,
  autoProjectTests: true,
  workspace,
  allowSyntaxOnly: args.allowSyntaxOnly,
  priorExperienceIncluded: Boolean(priorExperience),
  maxCandidates: 1,
  maxSynthesisRounds: 1,
  timeoutMs: Number(
    process.env.JEV_DIRECT_AUTONOMY_TIMEOUT_MS ||
    3600000
  )
});

console.log(
  `[GENERAL_TASK] workspace=${workspace}`
);

console.log(
  `[GENERAL_TASK] context_files=${discovered.contextFiles.length}/${discovered.totalFiles}`
);

console.log(
  "[GENERAL_TASK] acceptance_transport=base64-safe"
);
if (
  explicitAcceptance.commands.length > 0
) {
  console.log(
    `[GENERAL_TASK] explicit_acceptance=${explicitAcceptance.commands.join(" | ")}`
  );
}

if (
  autoAcceptance
) {
  console.log(
    `[GENERAL_TASK] auto_acceptance=${autoAcceptance.kind} file=${autoAcceptance.file} export=${autoAcceptance.exportName} expected=${autoAcceptance.expected}`
  );
}

console.log(
  `[GENERAL_TASK] verification=${[
    ...(args.acceptance.length > 0 ? args.acceptance : discovered.verificationCommands)
  ].join(" | ") || "syntax-only-explicit"}`
);

const result =
  spawnSync(
    process.execPath,
    [
      path.join(
        ROOT,
        "autonomy",
        "task-loop.mjs"
      ),
      specFile
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    }
  );

if (
  result.status === 1
) {
  console.log(
    "[GENERAL_TASK] child_exit_unhandled=1"
  );

  console.log(
    JSON.stringify(
      {
        status:
          "NEEDS_VERIFICATION",

        stage:
          "autonomy_child",

        retryable:
          true,

        reason:
          "Autonomy child process exited before producing a verified apply result. No live apply is considered successful.",

        childExitCode:
          1
      },
      null,
      2
    )
  );
}

process.exit(
  typeof result.status === "number"
    ? result.status
    : 1
);
