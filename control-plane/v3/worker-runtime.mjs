import fs from "node:fs";
import path from "node:path";
import { detectVerificationSupport } from "../../autonomy/context-builder.mjs";

function decode(value) {
  return Buffer.from(value || "", "base64").toString("utf8");
}

function args(argv) {
  const out = { role: "", workspace: "", task: "", evidence: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--role") out.role = argv[++i] || "";
    else if (argv[i] === "--workspace") out.workspace = argv[++i] || "";
    else if (argv[i] === "--task-b64") out.task = decode(argv[++i]);
    else if (argv[i] === "--evidence-b64") out.evidence = decode(argv[++i]);
  }
  return out;
}

function emit(result, code = 0) {
  process.stdout.write(JSON.stringify({
    workerId: `${result.role || "worker"}-${process.pid}`,
    role: result.role,
    ok: result.ok === true,
    ...result
  }));
  process.exitCode = code;
}

function inventory(root) {
  const ignored = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache"]);
  const files = [];
  const walk = (current, depth) => {
    if (depth > 5) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  walk(root, 0);
  return files.sort().slice(0, 500);
}

const input = args(process.argv.slice(2));
const workspace = path.resolve(input.workspace || "");

function synthesisProvider() {
  try {
    const policy = JSON.parse(fs.readFileSync(path.resolve("config/synthesis.json"), "utf8"));
    if (policy.enabled === true && policy.provider === "chatgpt-browser" && process.env.JEV_BROWSER_ALLOW_TRANSMIT === "1") return "chatgpt-browser";
    if (policy.enabled === true && policy.provider) return policy.provider;
  } catch {}
  return "local-deterministic";
}

try {
  if (!input.role || !fs.existsSync(workspace)) throw new Error("worker requires an existing workspace");

  if (input.role === "scout") {
    const files = inventory(workspace);
    emit({ role: "scout", ok: true, workspace, taskReceived: Boolean(input.task), files, fileCount: files.length });
  } else if (input.role === "planner") {
    const files = inventory(workspace);
    const verificationCommands = detectVerificationSupport(workspace);
    emit({
      role: "planner",
      ok: true,
      workspace,
      fileCount: files.length,
      verificationCommands,
      synthesisProvider: synthesisProvider(),
      supportedPatterns: synthesisProvider() === "chatgpt-browser"
        ? ["free-form-multi-file-code-generation", "named-function-return", "json-primitive-update"]
        : ["named-function-return", "json-primitive-update"],
      planReady: verificationCommands.length > 0 || files.length === 0
    });
  } else if (input.role === "validator") {
    let evidence = {};
    try { evidence = JSON.parse(input.evidence || "{}"); } catch { throw new Error("validator evidence is not JSON"); }
    const status = String(evidence.status || "").toUpperCase();
    const ok = status === "APPLIED" && Number(evidence.code) === 0 &&
      String(evidence.output || "").trim().length > 0;
    emit({ role: "validator", ok, statusObserved: status, exitCodeObserved: evidence.code, evidencePresent: String(evidence.output || "").trim().length > 0 }, ok ? 0 : 4);
  } else if (input.role === "reviewer") {
    let evidence = {};
    try { evidence = JSON.parse(input.evidence || "{}"); } catch { throw new Error("reviewer evidence is not JSON"); }
    const status = String(evidence.status || "").toUpperCase();
    const changed = Array.isArray(evidence.changed) ? evidence.changed : [];
    const validatorOk = evidence.validatorOk === true;
    const ok = status === "APPLIED" && Number(evidence.code) === 0 && validatorOk && changed.length > 0;
    emit({
      role: "reviewer",
      ok,
      statusObserved: status,
      exitCodeObserved: evidence.code,
      changedFiles: changed,
      validatorAccepted: validatorOk,
      review: ok ? "verified_terminal_change" : "terminal_change_not_verified"
    }, ok ? 0 : 4);
  } else {
    throw new Error(`unknown worker role: ${input.role}`);
  }
} catch (error) {
  emit({ role: input.role, ok: false, error: String(error?.stack || error) }, 4);
}
