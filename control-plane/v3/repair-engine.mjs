import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const V3 = HERE;
const MEMORY_DIR = path.join(V3, "memory");
// Keep candidate copies outside ROOT; copying ROOT into a descendant is unsafe
// and fails on Windows before validation can even begin.
const WORK_DIR = path.join(path.dirname(ROOT), "jev-agent-repair-work");
const HISTORY = path.join(MEMORY_DIR, "repair-history.jsonl");
const REGISTRY = path.join(V3, "workers", "registry.json");

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
const JEV_KEY = process.env.TYPESAFE_API_KEY || "";

const SYNTH_BASE = (process.env.JEV_SYNTH_BASE_URL || "").replace(/\/+$/, "");
const SYNTH_MODEL = process.env.JEV_SYNTH_MODEL || JEV_MODEL;
const SYNTH_KEY = process.env.JEV_SYNTH_API_KEY || "";
const SYNTH_TIMEOUT = Number(process.env.JEV_SYNTH_TIMEOUT_MS || 3600000);

const PROTECTED = new Set([
  "supervisor.mjs",
  "runtime/stable-agent.mjs",
  "runtime/active-agent.mjs"
]);

const ALLOWED_PREFIXES = [
  "control-plane/v3/",
  "autonomy/",
  "synthesis/",
  "run-task.ps1",
  "invoke-from-cline-b64.ps1",
  "config/"
];

function log(msg) {
  console.log(`[SELF_HEAL] ${msg}`);
}

function normRel(p) {
  return p.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isAllowed(rel) {
  rel = normRel(rel);
  if (PROTECTED.has(rel)) return false;
  return ALLOWED_PREFIXES.some(prefix =>
    prefix.endsWith("/") ? rel.startsWith(prefix) : rel === prefix
  );
}

function safeRead(file, max = 50000) {
  try {
    const s = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return s.length > max ? s.slice(0, max) + "\n...[TRUNCATED]..." : s;
  } catch {
    return "";
  }
}

function appendHistory(obj) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...obj
  }) + "\n");
}

function signature(text) {
  const normalized = String(text || "")
    .replace(/[A-Fa-f0-9]{8,}/g, "<HEX>")
    .replace(/\b\d{4,}\b/g, "<N>")
    .replace(/TASK-[^\s]+/g, "<TASK>")
    .slice(-12000);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function repeatedCount(sig) {
  if (!fs.existsSync(HISTORY)) return 0;
  return fs.readFileSync(HISTORY, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .reduce((n, line) => {
      try {
        return n + (JSON.parse(line).signature === sig ? 1 : 0);
      } catch {
        return n;
      }
    }, 0);
}

function implicatedFiles(failureText) {
  const out = new Set([
    "control-plane/v3/supervisor-v3.mjs",
    "control-plane/v3/repair-engine.mjs",
    "run-task.ps1",
    "autonomy/general-task.mjs",
    "autonomy/task-loop.mjs",
    "synthesis/provider.mjs"
  ]);

  const rootPattern = ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\", "/");
  const rx = new RegExp(`(?:file:///)?${rootPattern}/([^:\\r\\n)]+)(?::\\d+:\\d+)?`, "gi");
  const normalized = String(failureText || "").replaceAll("\\", "/");
  for (const m of normalized.matchAll(rx)) {
    const rel = normRel(m[1]);
    if (isAllowed(rel)) out.add(rel);
  }
  return [...out].slice(0, 10);
}

async function fetchJson(url, options, timeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...options, signal: c.signal });
      const text = await r.text();
      if (!r.ok) {
        const error = new Error(`HTTP ${r.status}: ${text.slice(0, 1000)}`);
        error.transient = [429, 500, 502, 503, 504].includes(r.status);
        throw error;
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const transient = error?.transient === true ||
        /AbortError|aborted|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error));
      if (!transient || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(4000, 500 * 2 ** (attempt - 1))));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Provider request failed");
}

function deepFindChoice(value, allowed) {
  if (typeof value === "string" && allowed.has(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (typeof value.choice === "string" && allowed.has(value.choice)) return value.choice;
  for (const v of Object.values(value)) {
    const hit = deepFindChoice(v, allowed);
    if (hit) return hit;
  }
  return null;
}

async function jevChoice({ state, question, criteria }) {
  if (!JEV_KEY) throw new Error("TYPESAFE_API_KEY missing");
  const payload = {
    model: JEV_MODEL,
    state,
    questions: {
      decision: {
        type: "choice",
        instructions: question,
        criteria
      }
    }
  };
  const data = await fetchJson(JEV_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${JEV_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 30000);

  const choice = deepFindChoice(data, new Set(Object.keys(criteria)));
  if (!choice) throw new Error("Jev returned no recognized decision");
  return choice;
}

function stripFence(s) {
  let t = String(s || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

async function synthesizeRepair({ failureText, files, sig, repeated }) {
  if (!SYNTH_KEY) throw new Error("JEV_SYNTH_API_KEY missing");

  const sources = files.map(rel => ({
    path: rel,
    content: safeRead(path.join(ROOT, rel))
  }));

  const registry = safeRead(REGISTRY, 12000);
  const prior = fs.existsSync(HISTORY)
    ? safeRead(HISTORY, 18000)
    : "";

  const prompt = [
    "You are the subordinate code-repair worker for a self-healing development supervisor.",
    "Jev remains the decision authority. You only synthesize a candidate repair.",
    "Return ONLY strict JSON, no markdown.",
    "Goal: fix the concrete agent/control-plane failure, not the user's project feature.",
    "Smallest safe change only.",
    "Never modify supervisor.mjs, runtime/stable-agent.mjs, or runtime/active-agent.mjs.",
    "Allowed paths: control-plane/v3/**, autonomy/**, synthesis/**, run-task.ps1, invoke-from-cline-b64.ps1, config/**.",
    "You may create a specialized worker under control-plane/v3/workers/ if repeated evidence shows it is useful.",
    "Schema:",
    '{"diagnosis":"...","operations":[{"type":"replace_file","path":"relative/path","content":"full new file content"}],"verification":["short description"],"workerCreated":false}',
    `Failure signature: ${sig}`,
    `Seen before: ${repeated}`,
    "FAILURE OUTPUT:",
    String(failureText || "").slice(-18000),
    "WORKER REGISTRY:",
    registry,
    "PRIOR REPAIR MEMORY:",
    prior,
    "RELEVANT FILES:",
    JSON.stringify(sources)
  ].join("\n\n");

  const data = await fetchJson(`${SYNTH_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNTH_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: SYNTH_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 7000,
      stream: false
    })
  }, SYNTH_TIMEOUT);

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Repair synthesis has no message.content");

  const candidate = JSON.parse(stripFence(content));
  if (!candidate || !Array.isArray(candidate.operations)) {
    throw new Error("Repair synthesis returned invalid operations");
  }

  candidate.operations = candidate.operations.filter(op =>
    op &&
    op.type === "replace_file" &&
    typeof op.path === "string" &&
    typeof op.content === "string" &&
    isAllowed(op.path)
  );

  if (candidate.operations.length === 0) {
    throw new Error("Repair candidate has no allowed operations");
  }

  return candidate;
}

function copyAgentRoot(dst) {
  fs.cpSync(ROOT, dst, {
    recursive: true,
    filter(src) {
      const rel = normRel(path.relative(ROOT, src));
      if (!rel) return true;
      const denied = [
        ".git/",
        "node_modules/",
        "logs/",
        "snapshots/",
        "control-plane/v3/repair-work/"
      ];
      return !denied.some(p => rel === p.slice(0, -1) || rel.startsWith(p));
    }
  });
}

function applyOps(base, operations) {
  const changed = [];
  for (const op of operations) {
    const rel = normRel(op.path);
    if (!isAllowed(rel)) throw new Error(`Unsafe repair target: ${rel}`);
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, op.content, "utf8");
    changed.push(rel);
  }
  return changed;
}

function run(cmd, args, cwd, timeout = 90000) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout
  });
  return {
    pass: r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error ? String(r.error) : null
  };
}

function validateChanged(base, changed) {
  const results = [];
  for (const rel of changed) {
    const abs = path.join(base, rel);
    if (rel.endsWith(".mjs") || rel.endsWith(".js")) {
      results.push({ rel, kind: "node-check", ...run(process.execPath, ["--check", abs], base) });
    } else if (rel.endsWith(".json")) {
      try {
        JSON.parse(fs.readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
        results.push({ rel, kind: "json-parse", pass: true, status: 0, stdout: "", stderr: "", error: null });
      } catch (e) {
        results.push({ rel, kind: "json-parse", pass: false, status: 1, stdout: "", stderr: String(e), error: null });
      }
    } else if (rel.endsWith(".ps1")) {
      const escaped = abs.replaceAll("'", "''");
      const command = `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}else{exit 0}`;
      results.push({ rel, kind: "ps-parse", ...run("powershell.exe", ["-NoProfile", "-Command", command], base) });
    } else {
      results.push({
        rel,
        kind: "unsupported-validation-type",
        pass: false,
        status: 1,
        stdout: "",
        stderr: `No validator is registered for ${rel}`,
        error: `No validator is registered for ${rel}`
      });
    }
  }
  return results;
}

function summarizeCandidate(candidate, validation) {
  return {
    diagnosis: candidate.diagnosis || "",
    changed: candidate.operations.map(x => normRel(x.path)),
    workerCreated: Boolean(candidate.workerCreated),
    validation: validation.map(v => ({ rel: v.rel, kind: v.kind, pass: v.pass }))
  };
}

function hasVerifiedWorkerEvidence(base, changed) {
  const workerFiles = changed.filter(rel =>
    rel.startsWith("control-plane/v3/workers/") &&
    !rel.endsWith("/registry.json") &&
    /\.(mjs|js|cjs)$/i.test(rel)
  );
  const registryChanged = changed.some(rel => rel === "control-plane/v3/workers/registry.json");
  return workerFiles.length > 0 && registryChanged &&
    workerFiles.every(rel => {
      try {
        const content = fs.readFileSync(path.join(base, rel), "utf8");
        return /export\s+(async\s+)?function|module\.exports|export\s+default/.test(content);
      } catch {
        return false;
      }
    });
}

function backupAndApply(operations, repairDir) {
  const backupDir = path.join(repairDir, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const records = [];

  try {
    for (const op of operations) {
      const rel = normRel(op.path);
      const live = path.join(ROOT, rel);
      const bak = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });

      const existed = fs.existsSync(live);
      if (existed) fs.copyFileSync(live, bak);

      records.push({ rel, live, bak, existed });
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.writeFileSync(live, op.content, "utf8");
    }
  } catch (error) {
    rollback(records);
    throw error;
  }
  return records;
}

function rollback(records) {
  for (const r of [...records].reverse()) {
    if (r.existed && fs.existsSync(r.bak)) {
      fs.mkdirSync(path.dirname(r.live), { recursive: true });
      fs.copyFileSync(r.bak, r.live);
    } else if (!r.existed && fs.existsSync(r.live)) {
      fs.rmSync(r.live, { force: true });
    }
  }
}

async function health4014() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  try {
    const r = await fetch("http://127.0.0.1:4014/health", { signal: c.signal });
    if (!r.ok) return false;
    const x = await r.json();
    return x?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function repairFailure({ failureText, taskId }) {
  const sig = signature(failureText);
  const repeated = repeatedCount(sig);
  const files = implicatedFiles(failureText);

  log(`signature=${sig} repeated=${repeated} files=${files.length}`);

  const actionCriteria = {
    repair_code: "The failure is a concrete code/control-plane defect and should be repaired automatically.",
    retry_only: "The failure is transient and a clean retry is preferable to changing code.",
    create_worker: "A repeated failure class would benefit from a specialized subordinate worker plus a repair.",
    stop: "No safe autonomous repair is justified from the available evidence."
  };

  const action = await jevChoice({
    state: {
      taskId,
      failure: String(failureText || "").slice(-12000),
      signature: sig,
      repeated,
      relevantFiles: files
    },
    question: "Choose the safest next self-healing action. Do not ask the user when the logs contain enough technical evidence.",
    criteria: actionCriteria
  });

  log(`jev_action=${action}`);

  if (action === "retry_only") {
    appendHistory({ taskId, signature: sig, action, outcome: "retry_only" });
    return { action, signature: sig, changed: [] };
  }

  if (action === "stop") {
    appendHistory({ taskId, signature: sig, action, outcome: "stopped" });
    return { action, signature: sig, changed: [] };
  }

  // Browser synthesis is the configured code worker for this installation.
  // Do not turn a missing optional repair-model key into a control-plane
  // crash; report a safe stop and let the original task result stand.
  if (!SYNTH_KEY) {
    appendHistory({
      taskId,
      signature: sig,
      action,
      outcome: "repair_synthesis_unavailable"
    });
    return {
      action: "stop",
      signature: sig,
      changed: [],
      reason: "repair_synthesis_unavailable"
    };
  }

  const candidate = await synthesizeRepair({
    failureText,
    files,
    sig,
    repeated
  });

  const repairId = `${Date.now()}-${sig}`;
  const repairDir = path.join(WORK_DIR, repairId);
  const candidateRoot = path.join(repairDir, "candidate");
  fs.mkdirSync(repairDir, { recursive: true });

  copyAgentRoot(candidateRoot);
  const changed = applyOps(candidateRoot, candidate.operations);
  const validation = validateChanged(candidateRoot, changed);

  const workerRequested = action === "create_worker";
  const workerEvidence = workerRequested && hasVerifiedWorkerEvidence(candidateRoot, changed);
  if (workerRequested && !workerEvidence) {
    appendHistory({
      taskId,
      signature: sig,
      action,
      changed,
      outcome: "worker_creation_unverified"
    });
    return { action: "stop", signature: sig, changed, reason: "worker_creation_unverified", workerCreated: false };
  }
  candidate.workerCreated = workerEvidence;

  if (!validation.every(v => v.pass)) {
    appendHistory({
      taskId,
      signature: sig,
      action,
      diagnosis: candidate.diagnosis,
      changed,
      outcome: "candidate_validation_failed",
      validation
    });
    return { action: "stop", signature: sig, changed, reason: "candidate_validation_failed" };
  }

  const review = await jevChoice({
    state: {
      taskId,
      failure: String(failureText || "").slice(-10000),
      repair: summarizeCandidate(candidate, validation)
    },
    question: "Should this validated self-repair candidate be promoted to the live agent? Apply only if it directly addresses the observed failure and preserves rollback.",
    criteria: {
      apply: "The candidate is minimal, validated, directly relevant, and safe to promote.",
      reject: "The candidate is unnecessary, too broad, weakly supported, or unsafe."
    }
  });

  log(`jev_review=${review}`);

  if (review !== "apply") {
    appendHistory({
      taskId,
      signature: sig,
      action,
      diagnosis: candidate.diagnosis,
      changed,
      outcome: "jev_rejected"
    });
    return { action: "stop", signature: sig, changed, reason: "jev_rejected" };
  }

  const records = backupAndApply(candidate.operations, repairDir);
  const liveValidation = validateChanged(ROOT, changed);

  if (!liveValidation.every(v => v.pass)) {
    rollback(records);
    appendHistory({
      taskId,
      signature: sig,
      action,
      diagnosis: candidate.diagnosis,
      changed,
      outcome: "live_validation_failed_rolled_back",
      validation: liveValidation
    });
    return { action: "stop", signature: sig, changed, reason: "live_validation_failed" };
  }

  const health = await health4014();
  if (!health) {
    rollback(records);
    appendHistory({
      taskId,
      signature: sig,
      action,
      diagnosis: candidate.diagnosis,
      changed,
      outcome: "health_failed_rolled_back"
    });
    return { action: "stop", signature: sig, changed, reason: "health_failed" };
  }

  appendHistory({
    taskId,
    signature: sig,
    action,
    diagnosis: candidate.diagnosis,
    changed,
    workerCreated: Boolean(candidate.workerCreated),
    outcome: "applied"
  });

  return {
    action: "repaired",
    signature: sig,
    changed,
    diagnosis: candidate.diagnosis,
    workerCreated: Boolean(candidate.workerCreated)
  };
}
