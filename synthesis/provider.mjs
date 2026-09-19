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

async function generateBrowserPatchPlan({ task, context }) {
  const prompt = `You are the code-writing worker inside a supervised local coding agent.

Return JSON only with this exact shape:
{"candidates":[{"id":"candidate-1","summary":"...","rationale":"...","operations":[{"type":"create_file","path":"relative/path","content":"complete file"},{"type":"exact_replace","path":"relative/path","old_text":"exact text","new_text":"replacement"}]}]}

Rules:
- Write the requested code; do not merely explain it.
- Use only relative paths inside the selected workspace.
- Existing files must use exact_replace; new files use create_file.
- Do not modify supervisor.mjs or runtime/stable-agent.mjs.
- Preserve existing behavior unless the task requests a change.
- Produce a complete, testable patch.
- Output strict RFC 8259 JSON that can be parsed by JSON.parse.
- Escape every double quote inside a JSON string as \\"; never place raw unescaped quotes inside summary, rationale, paths, or file contents.
- Before sending, validate the complete response mentally as one JSON object. If no change is needed, return operations as an empty array.
- Do not include markdown fences or commentary outside the JSON.

TASK:
${task}

WORKSPACE EVIDENCE:
${context}`;
  const response = await runBrowserBridge(prompt);
  try {
    return {
      latencyMs: 0,
      attempts: 1,
      provider: "chatgpt-browser",
      plan: parseJsonContent(response.response)
    };
  } catch (firstError) {
    appendSynthFailoverTrace("browser_json_repair_start", {
      error: String(firstError?.message || firstError)
    });
    const repairPrompt = `You are a strict JSON repair worker.

Return only one syntactically valid JSON object with this exact shape:
{"candidates":[{"id":"candidate-1","summary":"...","rationale":"...","operations":[{"type":"create_file","path":"relative/path","content":"complete file"},{"type":"exact_replace","path":"relative/path","old_text":"exact text","new_text":"replacement"}]}]}

Repair the previous worker output below. Preserve its intended candidate, paths, operations, and file contents. Escape all embedded double quotes correctly. Do not add commentary, markdown fences, or new work. If the previous output intended no change, preserve operations as an empty array.

BEGIN PREVIOUS OUTPUT
${response.response}
END PREVIOUS OUTPUT`;
    try {
      const repaired = await runBrowserBridge(repairPrompt);
      return {
        latencyMs: 0,
        attempts: 2,
        provider: "chatgpt-browser",
        plan: parseJsonContent(repaired.response)
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
