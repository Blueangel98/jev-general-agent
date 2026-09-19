import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deterministicPatchPlan } from "./deterministic-engine.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SYNTHESIS_POLICY_FILE = path.join(ROOT, "config", "synthesis.json");
const BROWSER_BRIDGE = path.join(ROOT, "browser", "chatgpt-cdp-bridge.mjs");

function synthesisPolicy() {
  try {
    return JSON.parse(fs.readFileSync(SYNTHESIS_POLICY_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { enabled: false };
  }
}
function stripJsonFence(text) {
  const raw =
    String(text || "")
      .trim();

  const fenced =
    raw.match(
      /^```(?:json)?\s*([\s\S]*?)\s*```$/i
    );

  return fenced
    ? fenced[1]
    : raw;
}

function repairLikelyJson(raw) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }

    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      const next = raw[index + 1] || "";
      if ('"\\/bfnrtu'.includes(next)) {
        output += character;
        escaped = true;
      } else {
        output += "\\\\";
      }
      continue;
    }

    if (character === '"') {
      let nextIndex = index + 1;
      while (/\s/.test(raw[nextIndex] || "")) nextIndex += 1;
      const next = raw[nextIndex] || "";
      if (nextIndex >= raw.length || [",", "}", "]", ":"].includes(next)) {
        output += character;
        inString = false;
      } else {
        // The quote is inside a malformed JSON string, e.g. summary text
        // containing "PY_OK". Preserve it as data instead of closing the
        // string prematurely.
        output += "\\\"";
      }
      continue;
    }

    if (character === "\r" || character === "\n") {
      if (character === "\r" && raw[index + 1] === "\n") index += 1;
      output += "\\n";
      continue;
    }

    output += character;
  }
  return output;
}

function decodeBase64Text(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be standard base64 text`);
  }
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(`${field} must be standard base64 text`);
  }
  const decoded = Buffer.from(compact, "base64").toString("utf8");
  const canonical = Buffer.from(decoded, "utf8").toString("base64");
  if (canonical.replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw new Error(`${field} is not valid UTF-8 base64`);
  }
  return decoded;
}

function normalizeEncodedPlan(plan) {
  if (!plan || !Array.isArray(plan.candidates)) return plan;
  return {
    ...plan,
    candidates: plan.candidates.map(candidate => ({
      ...candidate,
      operations: (Array.isArray(candidate.operations)
        ? candidate.operations
        : candidate.operations && typeof candidate.operations === "object"
          ? [candidate.operations]
          : candidate.operations) ?.map(operation => {
            const {
              content_base64,
              old_text_base64,
              new_text_base64,
              ...plainOperation
            } = operation || {};
            const normalized = { ...plainOperation };
            if (content_base64 !== undefined) {
              normalized.content = decodeBase64Text(content_base64, "content_base64");
            }
            if (old_text_base64 !== undefined) {
              normalized.old_text = decodeBase64Text(old_text_base64, "old_text_base64");
            }
            if (new_text_base64 !== undefined) {
              normalized.new_text = decodeBase64Text(new_text_base64, "new_text_base64");
            }
            return normalized;
          })
    }))
  };
}

function parseJsonContent(text) {
  const raw = stripJsonFence(text);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(repairLikelyJson(raw)); } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const objectText = raw.slice(first, last + 1);
    try { return JSON.parse(objectText); } catch {}
    return JSON.parse(repairLikelyJson(objectText));
  }
  throw new Error("Browser synthesis response did not contain a JSON patch plan");
}

function browserSynthesisConfigured() {
  const policy = synthesisPolicy();
  return policy.enabled === true &&
    policy.provider === "chatgpt-browser" &&
    process.env.JEV_BROWSER_ALLOW_TRANSMIT === "1";
}

function runBrowserBridge(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BROWSER_BRIDGE, "send"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ChatGPT browser worker exited with code ${code}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`ChatGPT browser worker returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify({ prompt }));
  });
}

function compactSynthesisText(value, limit) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.62);
  const tail = Math.floor(limit * 0.28);
  return `${text.slice(0, head)}\n\n...[context shortened for this step]...\n\n${text.slice(-tail)}`;
}

function extractRepairFeedback(context) {
  const text = String(context || "");
  const marker = "PREVIOUS CANDIDATES FAILED DETERMINISTIC SANDBOX VERIFICATION.";
  const index = text.indexOf(marker);
  return index >= 0
    ? compactSynthesisText(text.slice(index), 10000)
    : "none";
}

function deriveSynthesisSteps(task) {
  const text = String(task || "").trim();
  const milestonePattern = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*)?M(\d+)\s*[—–-]\s*([^\n*]+)(?:\*\*)?/gim;
  const milestones = [...text.matchAll(milestonePattern)];

  if (milestones.length >= 2) {
    const chunks = milestones.map((match, index) => {
      const start = match.index;
      const end = index + 1 < milestones.length
        ? milestones[index + 1].index
        : text.length;
      return {
        title: `M${match[1]} — ${match[2].trim()}`,
        body: text.slice(start, end).trim()
      };
    });
    const grouped = [];
    for (let index = 0; index < chunks.length; index += 3) {
      const group = chunks.slice(index, index + 3);
      grouped.push({
        title: group.map(step => step.title).join("; "),
        body: group.map(step => step.body).join("\n\n")
      });
    }
    return grouped;
  }

  const headings = [...text.matchAll(/(?:^|\n)\s{0,3}(#{2,4})\s+([^\n]+)\s*/g)]
    .map((match, index, all) => ({
      title: match[2].trim(),
      body: text.slice(match.index, index + 1 < all.length ? all[index + 1].index : text.length).trim()
    }));

  if (headings.length >= 3) {
    const grouped = [];
    for (let index = 0; index < headings.length; index += 2) {
      const group = headings.slice(index, index + 2);
      grouped.push({
        title: group.map(step => step.title).join("; "),
        body: group.map(step => step.body).join("\n\n")
      });
    }
    return grouped.slice(0, 5);
  }

  return [{
    title: "Current implementation slice",
    body: text
  }];
}

function buildBrowserStepPrompt({ task, context, step, index, total, completed }) {
  const globalBrief = compactSynthesisText(task, 2400);
  const stepBrief = compactSynthesisText(step.body, 7600);
  const repairFeedback = extractRepairFeedback(context);
  const workspaceContext = repairFeedback === "none"
    ? context
    : String(context).slice(0, String(context).indexOf("PREVIOUS CANDIDATES FAILED DETERMINISTIC SANDBOX VERIFICATION."));
  const workspaceEvidence = compactSynthesisText(workspaceContext, 7800);
  const completedBrief = completed.length
    ? completed.map(item => `${item.title}: ${item.paths.join(", ") || "no file changes"}`).join("\n")
    : "none";

  return `You are the code-writing worker inside a supervised local coding agent.

This is step ${index + 1} of ${total}: ${step.title}
Work like a careful Codex coding agent: inspect the evidence, make a coherent implementation change, preserve existing behavior, and return working code rather than an explanation. Handle only this step and its direct prerequisites. Do not implement later steps in this response.
If validation feedback is present below, treat it as a blocking defect report. Resolve the named import, symbol, path, or test failure against the supplied workspace evidence before returning code. Do not repeat a candidate that produced the same error.

Return plain text containing exactly one strict RFC 8259 JSON object:
{"candidates":[{"id":"step-${index + 1}","summary":"...","rationale":"...","operations":[{"type":"create_file","path":"relative/path","content_base64":"..."},{"type":"exact_replace","path":"relative/path","old_text_base64":"...","new_text_base64":"..."}]}]}

Rules:
- Write the requested code; do not merely explain it.
- Use only relative paths inside the selected workspace.
- Existing files use exact_replace; new files use create_file.
- Do not modify supervisor.mjs or runtime/stable-agent.mjs.
- Keep this step focused. Avoid unrelated refactors and do not repeat files already owned by an earlier step unless this step explicitly extends them.
- Use UTF-8 standard base64 for every code/text payload. Never put raw source code in JSON string fields.
- Return one candidate with a small, coherent patch. If this step genuinely needs no code change, return operations as an empty array.
- No markdown fence, attachment, bullet list, or commentary outside the JSON.
- Validate the complete response with JSON.parse before sending.

GLOBAL TASK BRIEF:
${globalBrief}

CURRENT STEP REQUIREMENTS:
${stepBrief}

WORKSPACE EVIDENCE FOR THIS STEP:
${workspaceEvidence}

VALIDATION FEEDBACK FROM THE PREVIOUS CANDIDATE:
${repairFeedback}

COMPLETED STEP SUMMARY (do not redo these changes):
${completedBrief}`;
}

async function generateOneBrowserPatchPlan(prompt) {
  const response = await runBrowserBridge(prompt);
  try {
    return {
      latencyMs: Number(response.latencyMs || 0),
      attempts: 1,
      provider: "chatgpt-browser",
      plan: normalizeEncodedPlan(parseJsonContent(response.response))
    };
  } catch (firstError) {
    appendSynthFailoverTrace("browser_json_repair_start", {
      error: String(firstError?.message || firstError)
    });
    const repairPrompt = `You are a strict JSON repair worker.

Return only one valid JSON object in this shape:
{"candidates":[{"id":"step-repaired","summary":"...","rationale":"...","operations":[{"type":"create_file","path":"relative/path","content_base64":"..."},{"type":"exact_replace","path":"relative/path","old_text_base64":"...","new_text_base64":"..."}]}]}

Preserve the previous worker's intended code and operations. Repair syntax only; do not add new work. Keep code/text payloads as UTF-8 standard base64. Do not output markdown or commentary.

BEGIN PREVIOUS OUTPUT
${response.response}
END PREVIOUS OUTPUT`;
    try {
      const repaired = await runBrowserBridge(repairPrompt);
      return {
        latencyMs: Number(repaired.latencyMs || 0),
        attempts: 2,
        provider: "chatgpt-browser",
        plan: normalizeEncodedPlan(parseJsonContent(repaired.response))
      };
    } catch (repairError) {
      appendSynthFailoverTrace("browser_json_repair_failed", {
        error: String(repairError?.message || repairError)
      });
      throw new Error(
        `ChatGPT browser synthesis returned invalid JSON after repair: ${repairError.message}`
      );
    }
  }
}

async function generateBrowserPatchPlan({ task, context }) {
  const steps = deriveSynthesisSteps(task);
  const completed = [];
  const plans = [];
  let latencyMs = 0;
  let attempts = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    console.error(`[SYNTHESIS] step=${index + 1}/${steps.length} title=${step.title}`);
    const generated = await generateOneBrowserPatchPlan(buildBrowserStepPrompt({
      task,
      context,
      step,
      index,
      total: steps.length,
      completed
    }));
    const plan = generated.plan;
    const candidate = Array.isArray(plan?.candidates) ? plan.candidates[0] : null;
    if (!candidate) throw new Error(`Step ${index + 1} returned no candidate`);
    plans.push(candidate);
    latencyMs += generated.latencyMs;
    attempts += generated.attempts;
    completed.push({
      title: step.title,
      paths: Array.isArray(candidate.operations)
        ? candidate.operations.map(operation => operation.path).filter(Boolean)
        : []
    });
  }

  return {
    latencyMs,
    attempts,
    provider: "chatgpt-browser",
    plan: {
      candidates: [{
        id: "stepwise-implementation",
        summary: plans.map(candidate => candidate.summary).filter(Boolean).join("; ") || "Stepwise implementation",
        rationale: plans.map(candidate => candidate.rationale).filter(Boolean).join("; "),
        operations: plans.flatMap(candidate => Array.isArray(candidate.operations) ? candidate.operations : [])
      }]
    }
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

const SYNTH_FAILOVER_TRACE_FILE =
  path.join(ROOT, "logs", "synthesis-failover.jsonl");

function appendSynthFailoverTrace(
  event,
  data = {}
) {
  try {
    fs.mkdirSync(
      path.dirname(SYNTH_FAILOVER_TRACE_FILE),
      {
        recursive:
          true
      }
    );

    fs.appendFileSync(
      SYNTH_FAILOVER_TRACE_FILE,
      JSON.stringify({
        ts:
          new Date().toISOString(),

        event,
        ...data
      }) +
        "\n",
      "utf8"
    );
  }
  catch {
    // Telemetry must never alter synthesis behavior.
  }
}

const synthNativeFetch =
  globalThis.fetch.bind(
    globalThis
  );

function synthFallbackModel() {
  return String(process.env.JEV_SYNTH_FALLBACK_MODEL || "").trim();
}

function synthFallbackTimeoutMs() {
  const value =
    Number(
      process.env.JEV_SYNTH_FALLBACK_TIMEOUT_MS ||
      process.env.JEV_SYNTH_TIMEOUT_MS ||
      3600000
    );

  return Number.isFinite(
    value
  ) &&
    value > 0
      ? value
      : 3600000;
}

function synthTransientError(
  error
) {
  const text =
    String(
      error?.stack ||
      error?.message ||
      error ||
      ""
    );

  return (
    error?.name ===
      "AbortError" ||
    /AbortError|aborted|timeout|timed out|ResourceExhausted|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(
      text
    )
  );
}

async function synthFetchFallbackRequest(
  url,
  init,
  payload,
  primaryModel,
  fallbackModel,
  reason
) {
  const controller =
    new AbortController();

  const timeoutMs =
    synthFallbackTimeoutMs();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  console.log(
    `[SYNTH_FALLBACK] primary=${primaryModel} fallback=${fallbackModel} reason=${reason}`
  );
  appendSynthFailoverTrace(
    "fallback_start",
    {
      primary:
        primaryModel,

      fallback:
        fallbackModel,

      reason
    }
  );

  try {
    const fallbackResponse =
      await synthNativeFetch(
        url,
        {
          ...init,

          body:
            JSON.stringify({
              ...payload,
              model:
                fallbackModel
            }),

          signal:
            controller.signal
        }
      );

    console.log(
      `[SYNTH_FALLBACK_RESULT] model=${fallbackModel} status=${fallbackResponse.status}`
    );
    appendSynthFailoverTrace(
      "fallback_result",
      {
        model:
          fallbackModel,

        status:
          fallbackResponse.status,

        ok:
          fallbackResponse.ok
      }
    );

    return fallbackResponse;
  }
  catch (
    error
  ) {
    console.log(
      `[SYNTH_FALLBACK_RESULT] model=${fallbackModel} error=${error?.name || "Error"}`
    );
    appendSynthFailoverTrace(
      "fallback_error",
      {
        model:
          fallbackModel,

        errorName:
          error?.name ||
          "Error"
      }
    );

    throw error;
  }
  finally {
    clearTimeout(
      timer
    );
  }
}

async function synthFetchWithFallback(
  url,
  init = {}
) {
  let payload =
    null;

  try {
    payload =
      typeof init?.body ===
      "string"
        ? JSON.parse(
            init.body
          )
        : null;
  }
  catch {
    payload =
      null;
  }

  const primaryModel =
    String(
      payload?.model ||
      ""
    ).trim();

  const fallbackModel =
    synthFallbackModel();

  const fallbackEnabled =
    Boolean(
      payload &&
      primaryModel &&
      fallbackModel &&
      primaryModel !==
        fallbackModel
    );

  try {
    const response =
      await synthNativeFetch(
        url,
        init
      );

    if (
      fallbackEnabled &&
      [429, 500, 502, 503, 504]
        .includes(
          response.status
        )
    ) {
      return await synthFetchFallbackRequest(
        url,
        init,
        payload,
        primaryModel,
        fallbackModel,
        `status_${response.status}`
      );
    }

    return response;
  }
  catch (
    error
  ) {
    if (
      fallbackEnabled &&
      synthTransientError(
        error
      )
    ) {
      return await synthFetchFallbackRequest(
        url,
        init,
        payload,
        primaryModel,
        fallbackModel,
        error?.name ===
          "AbortError"
          ? "timeout"
          : "transient_error"
      );
    }

    throw error;
  }
}

export function synthesisConfig() {
  const policy = synthesisPolicy();

  return {
    enabled: policy.enabled === true,
    provider: policy.provider || "disabled",

    baseUrl:
      process.env.JEV_SYNTH_BASE_URL || "",

    apiKey:
      process.env.JEV_SYNTH_API_KEY || "",

    model:
      process.env.JEV_SYNTH_MODEL || "",

    timeoutMs:
      Number(
        process.env.JEV_SYNTH_TIMEOUT_MS ||
        3600000
      ),

    maxAttempts:
      Math.max(
        1,
        Math.min(
          Number(
            process.env.JEV_SYNTH_MAX_ATTEMPTS ||
            4
          ),
          6
        )
      )
  };
}

export function synthesisConfigured() {
  const config =
    synthesisConfig();

  return Boolean(
    (config.enabled && config.baseUrl && config.apiKey && config.model) ||
    browserSynthesisConfigured()
  );
}

export async function generatePatchPlan({
  task,
  context
}) {
  const config =
    synthesisConfig();

  if (browserSynthesisConfigured()) {
    return generateBrowserPatchPlan({ task, context });
  }

  if (
    !synthesisConfigured()
  ) {
    const localPlan = deterministicPatchPlan({ task, context });
    if (localPlan) {
      return {
        latencyMs: 0,
        attempts: 1,
        provider: "local-deterministic",
        plan: localPlan
      };
    }

    const error = new Error(
      "Local deterministic synthesis does not support this free-form code-generation task"
    );
    error.code = "LOCAL_SYNTHESIS_UNSUPPORTED";
    throw error;
  }

  const url =
    config.baseUrl
      .replace(/\/+$/, "") +
    "/chat/completions";

  const systemPrompt = `
You are a CODE SYNTHESIS WORKER.

You are NOT the autonomous agent.
You cannot decide what project goal should be pursued.
You cannot run tools.
You cannot modify files.
You cannot promote code.

Your only job is to produce candidate patch plans
for the supplied task and evidence.

Return JSON only.

Schema:

{
  "candidates": [
    {
      "id": "candidate-1",
      "summary": "...",
      "rationale": "...",
      "operations": [
        {
          "type": "create_file",
          "path": "relative/path.ext",
          "content": "..."
        }
      ]
    }
  ]
}

Allowed operations:

create_file:
{
  "type": "create_file",
  "path": "relative/path.ext",
  "content": "complete file content"
}

exact_replace:
{
  "type": "exact_replace",
  "path": "relative/path.ext",
  "old_text": "exact existing text",
  "new_text": "replacement text"
}

CRITICAL PATCH RULES:

- If context shows that a target file ALREADY EXISTS,
  NEVER use create_file for that path.
- For an existing file use exact_replace.
- old_text must be copied exactly from the supplied file evidence.
- Prefer the smallest exact replacement that uniquely performs the task.
- Do not rewrite an entire existing file when a smaller exact replacement is possible.
- If a previous sandbox attempt says a file already exists,
  repair the proposal by using exact_replace against the supplied current content.
- If previous sandbox feedback says an exact match was not unique or not found,
  use the refreshed file evidence to produce a corrected exact replacement.

Never modify:
- supervisor.mjs
- runtime/stable-agent.mjs

Do not use absolute paths.
Do not invent evidence.
`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= config.maxAttempts;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        config.timeoutMs
      );

    const started =
      Date.now();

    try {
      const response =
        await synthFetchWithFallback(
          url,
          {
            method:
              "POST",

            headers: {
              "content-type":
                "application/json",

              authorization:
                `Bearer ${config.apiKey}`
            },

            body:
              JSON.stringify({
                model:
                  config.model,

                temperature:
                  0,

                messages: [
                  {
                    role:
                      "system",

                    content:
                      systemPrompt
                  },
                  {
                    role:
                      "user",

                    content:
                      JSON.stringify({
                        task,
                        context
                      })
                  }
                ]
              }),

            signal:
              controller.signal
          }
        );

      const raw =
        await response.text();

      if (
        !response.ok
      ) {
        const error =
          new Error(
            `Synthesis HTTP ${response.status}: ${raw.slice(0, 1000)}`
          );

        lastError =
          error;

        if (
          isTransientStatus(
            response.status
          ) &&
          attempt <
            config.maxAttempts
        ) {
          const delay =
            Math.min(
              15000,
              1500 *
              Math.pow(
                2,
                attempt - 1
              )
            );

          console.log(
            `[SYNTH_RETRY] attempt=${attempt}/${config.maxAttempts} status=${response.status} wait_ms=${delay}`
          );

          await sleep(
            delay
          );

          continue;
        }

        throw error;
      }

      const envelope =
        JSON.parse(
          raw
        );

      const content =
        envelope
          ?.choices?.[0]
          ?.message?.content;

      if (
        typeof content !== "string"
      ) {
        throw new Error(
          "Synthesis response has no message.content"
        );
      }

      const plan =
        JSON.parse(
          stripJsonFence(
            content
          )
        );

      return {
        latencyMs:
          Date.now() -
          started,

        attempts:
          attempt,

        plan
      };
    }
    catch (
      error
    ) {
      lastError =
        error;

      const transientAbort =
        error?.name ===
        "AbortError";

      if (
        transientAbort &&
        attempt <
          config.maxAttempts
      ) {
        const delay =
          Math.min(
            15000,
            1500 *
            Math.pow(
              2,
              attempt - 1
            )
          );

        console.log(
          `[SYNTH_RETRY] attempt=${attempt}/${config.maxAttempts} reason=timeout wait_ms=${delay}`
        );

        await sleep(
          delay
        );

        continue;
      }

      throw error;
    }
    finally {
      clearTimeout(
        timer
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Synthesis failed"
    )
  );
}
