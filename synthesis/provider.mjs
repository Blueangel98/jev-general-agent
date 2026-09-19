import fs from "node:fs";
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

const SYNTH_FAILOVER_TRACE_FILE =
  "C:\\Users\\Orhan\\jev-general-agent\\logs\\synthesis-failover.jsonl";

function appendSynthFailoverTrace(
  event,
  data = {}
) {
  try {
    fs.mkdirSync(
      "C:\\Users\\Orhan\\jev-general-agent\\logs",
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
      20000
    );

  return Number.isFinite(
    value
  ) &&
    value > 0
      ? value
      : 20000;
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
  return {
    baseUrl:
      process.env.JEV_SYNTH_BASE_URL || "",

    apiKey:
      process.env.JEV_SYNTH_API_KEY || "",

    model:
      process.env.JEV_SYNTH_MODEL || "",

    timeoutMs:
      Number(
        process.env.JEV_SYNTH_TIMEOUT_MS ||
        20000
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
    config.baseUrl &&
    config.apiKey &&
    config.model
  );
}

export async function generatePatchPlan({
  task,
  context
}) {
  const config =
    synthesisConfig();

  if (
    !synthesisConfigured()
  ) {
    throw new Error(
      "Synthesis provider is not configured"
    );
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
