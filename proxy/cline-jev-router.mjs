import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import { Buffer } from "node:buffer";

const PORT =
  Number(
    process.env.JEV_CLINE_PROXY_PORT ||
    4014
  );

const UPSTREAM =
  process.env.JEV_CLINE_UPSTREAM ||
  "http://127.0.0.1:4012";

const JEV_URL =
  process.env.JEV_URL ||
  "https://api.typesafe.ai/v1/systemone";

const JEV_MODEL =
  process.env.JEV_MODEL ||
  "jev-latest";

const JEV_KEY =
  process.env.TYPESAFE_API_KEY ||
  "";

const BRIDGE =
  "C:\\Users\\Orhan\\jev-general-agent\\invoke-from-cline-b64.ps1";


const DIRECT_AUTONOMY_TIMEOUT_MS =
  Math.max(
    300000,
    Number(
      process.env.JEV_DIRECT_AUTONOMY_TIMEOUT_MS ||
      1200000
    )
  );
const JEV_LIVE_CONSOLE =
  process.env.JEV_LIVE_CONSOLE !==
  "0";const READONLY_DIAGNOSTIC =
  "C:\\Users\\Orhan\\jev-general-agent\\proxy\\readonly-diagnostics.ps1";

function appendDirectTail(
  current,
  chunk,
  limit = 1048576
) {
  const next =
    current +
    String(
      chunk || ""
    );

  return next.length >
    limit
      ? next.slice(
          -limit
        )
      : next;
}

function runDirectAutonomyBridge(
  taskB64,
  allowSyntaxOnly = false
) {
  return new Promise(
    resolve => {
      const args = [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        BRIDGE,
        "-TaskB64",
        taskB64
      ];

      if (
        allowSyntaxOnly
      ) {
        args.push(
          "-AllowSyntaxOnly"
        );
      }

      let stdout =
        "";

      let stderr =
        "";

      let settled = false;

      let timedOut = false;

      const child =
        spawn(
          "powershell.exe",
          args,
          {
            cwd:
              "C:\\Users\\Orhan\\jev-general-agent",

            env:
              process.env,

            windowsHide:
              true,

            stdio: [
              "ignore",
              "pipe",
              "pipe"
            ]
          }
        );

      const finish =
        (
          code,
          extraError = ""
        ) => {
          if (
            settled
          ) {
            return;
          }

          settled =
            true;

          clearTimeout(
            hardTimer
          );

          if (
            extraError
          ) {
            stderr =
              appendDirectTail(
                stderr,
                `\n${extraError}`
              );
          }

          resolve({
            exitCode:
              typeof code ===
              "number"
                ? code
                : 1,

            stdout,
            stderr,
            timedOut
          });
        };

      child.stdout.on(
        "data",
        chunk => {
          stdout =
            appendDirectTail(
              stdout,
              chunk.toString(
                "utf8"
              )
            );
        
        if (
          JEV_LIVE_CONSOLE
        ) {
          process.stdout.write(
            chunk
          );
        }}
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr =
            appendDirectTail(
              stderr,
              chunk.toString(
                "utf8"
              )
            );
        
        if (
          JEV_LIVE_CONSOLE
        ) {
          process.stderr.write(
            chunk
          );
        }}
      );

      child.on(
        "error",
        error => {
          finish(
            1,
            String(
              error?.stack ||
              error
            )
          );
        }
      );

      child.on(
        "close",
        code => {
          finish(
            code
          );
        }
      );

      const hardTimer =
        setTimeout(
          () => {
            timedOut =
              true;

            try {
              child.kill();
            }
            catch {}

            finish(
              4,
              `Direct autonomy bridge exceeded ${DIRECT_AUTONOMY_TIMEOUT_MS} ms hard limit.`
            );
          },
          DIRECT_AUTONOMY_TIMEOUT_MS
        );
    }
  );
}

function directAutonomyEvidence(
  result
) {
  const combined =
    [
      result?.stdout || "",
      result?.stderr || ""
    ]
      .filter(Boolean)
      .join("\n");

  const normalized =
    combined.replace(
      /\\"/g,
      '"'
    );
  if (
    result?.timedOut ===
    true
  ) {
    return [
      combined,
      JSON.stringify({
        status:
          "NEEDS_VERIFICATION",

        stage:
          "direct_autonomy",

        retryable:
          true,

        timeoutMs:
          DIRECT_AUTONOMY_TIMEOUT_MS,

        reason:
          "Direct autonomy exceeded its outer safety ceiling. No live apply is considered successful."
      })
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    /"status"\s*:\s*"(APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)"/i
      .test(
        normalized
      )
  ) {
    return combined;
  }

  return [
    combined,
    JSON.stringify({
      status:
        "ERROR",

      reason:
        `Direct autonomy bridge exited with code ${Number(result?.exitCode ?? 1)} without a structured terminal status. No live apply is considered successful.`
    })
  ]
    .filter(Boolean)
    .join("\n");
}

function writeDirectAutonomyJson(
  res,
  body,
  content
) {
  const raw =
    JSON.stringify({
      id:
        `chatcmpl-jev-direct-${Date.now()}`,

      object:
        "chat.completion",

      created:
        Math.floor(
          Date.now() /
          1000
        ),

      model:
        body?.model ||
        "jev-cline-agent",

      choices: [
        {
          index:
            0,

          message: {
            role:
              "assistant",

            content:
              String(
                content || ""
              )
          },

          finish_reason:
            "stop"
        }
      ]
    });

  res.writeHead(
    200,
    {
      "content-type":
        "application/json; charset=utf-8",

      "content-length":
        Buffer.byteLength(
          raw
        )
    }
  );

  res.end(
    raw
  );
}

function estimateDirectClineTokens(value) {
  let text = "";

  try {
    text =
      typeof value === "string"
        ? value
        : JSON.stringify(value ?? "");
  }
  catch {
    text = String(value ?? "");
  }

  const bytes =
    Buffer.byteLength(
      text,
      "utf8"
    );

  return bytes > 0
    ? Math.max(
        1,
        Math.ceil(bytes / 3.6)
      )
    : 0;
}

function estimateDirectClineUsage(body, report) {
  const promptShape = {
    model: body?.model ?? null,
    messages:
      Array.isArray(body?.messages)
        ? body.messages
        : [],
    tools:
      Array.isArray(body?.tools)
        ? body.tools
        : [],
    tool_choice:
      body?.tool_choice ?? null,
    response_format:
      body?.response_format ?? null
  };

  const promptTokens =
    estimateDirectClineTokens(
      promptShape
    );

  const completionTokens =
    estimateDirectClineTokens(
      String(report ?? "")
    );

  return {
    prompt_tokens:
      promptTokens,

    completion_tokens:
      completionTokens,

    total_tokens:
      promptTokens +
      completionTokens,

    prompt_tokens_details: {
      cached_tokens: 0
    },

    completion_tokens_details: {
      reasoning_tokens: 0
    }
  };
}

// JEV_DIRECT_USAGE_V2_HELPER
async function sendDirectAutonomy(
  res,
  body,
  taskB64,
  allowSyntaxOnly = false
) {
  const started =
    Date.now();

  appendRequestTrace(
    "direct_autonomy_start",
    {
      stream:
        body?.stream === true,

      allowSyntaxOnly
    }
  );

  if (
    body?.stream !==
    true
  ) {
    const result =
      await runDirectAutonomyBridge(
        taskB64,
        allowSyntaxOnly
      );

    const evidence =
      directAutonomyEvidence(
        result
      );

    const report =
      mutationReportFromEvidence(
        evidence
      );

    appendRequestTrace(
      "direct_autonomy_complete",
      {
        exitCode:
          result.exitCode,

        elapsedMs:
          Date.now() -
          started
      }
    );

    writeDirectAutonomyJson(
      res,
      body,
      report
    );

    return;
  }

  const id =
    `chatcmpl-jev-direct-${Date.now()}`;

  const created =
    Math.floor(
      Date.now() /
      1000
    );

  const model =
    body?.model ||
    "jev-cline-agent";

  res.writeHead(
    200,
    {
      "content-type":
        "text/event-stream; charset=utf-8",

      "cache-control":
        "no-cache",

      connection:
        "keep-alive"
    }
  );

  const emit =
    payload => {
      if (
        !res.writableEnded
      ) {
        res.write(
          `data: ${JSON.stringify(payload)}\n\n`
        );
      }
    };

  emit({
    id,
    object:
      "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index:
          0,
        delta: {
          role:
            "assistant"
        },
        finish_reason:
          null
      }
    ]
  });

  const heartbeat =
    setInterval(
      () => {
        if (
          !res.writableEnded
        ) {
          res.write(
            ": jev-autonomy-heartbeat\n\n"
          );
        }
      },
      5000
    );

  const result =
    await runDirectAutonomyBridge(
      taskB64,
      allowSyntaxOnly
    );

  clearInterval(
    heartbeat
  );

  const evidence =
    directAutonomyEvidence(
      result
    );

  const report =
    mutationReportFromEvidence(
      evidence
    );

  appendRequestTrace(
    "direct_autonomy_complete",
    {
      exitCode:
        result.exitCode,

      elapsedMs:
        Date.now() -
        started
    }
  );

  emit({
    id,
    object:
      "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index:
          0,
        delta: {
          content:
            String(
              report || ""
            )
        },
        finish_reason:
          null
      }
    ]
  });

  emit({
    id,
    object:
      "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index:
          0,
        delta: {},
        finish_reason:
          "stop"
      }
    ]
  });
  // JEV_DIRECT_USAGE_V2_EMIT
  const directUsage =
    estimateDirectClineUsage(
      body,
      report
    );

  if (
    !res.writableEnded
  ) {
    emit({
      id,
      object:
        "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage:
        directUsage
    });

    console.log(
      `[CLINE_USAGE_DIRECT] prompt=${directUsage.prompt_tokens} completion=${directUsage.completion_tokens} total=${directUsage.total_tokens} estimated=true`
    );
  }


  if (
    !res.writableEnded
  ) {
    res.write(
      "data: [DONE]\n\n"
    );

    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", chunk => {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
      );
    });

    req.on(
      "end",
      () =>
        resolve(
          Buffer.concat(chunks)
        )
    );

    req.on(
      "error",
      reject
    );
  });
}

function messageText(message) {
  const content =
    message?.content;

  if (
    typeof content ===
    "string"
  ) {
    return content;
  }

  if (
    Array.isArray(content)
  ) {
    return content
      .map(part => {
        if (
          typeof part ===
          "string"
        ) {
          return part;
        }

        if (
          typeof part?.text ===
          "string"
        ) {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function latestUserContext(messages) {
  let index =
    -1;

  for (
    let i = messages.length - 1;
    i >= 0;
    i--
  ) {
    if (
      messages[i]?.role ===
      "user"
    ) {
      index =
        i;

      break;
    }
  }

  if (
    index < 0
  ) {
    return {
      prompt:
        "",

      alreadyRouted:
        false
    };
  }

  const prompt =
    messageText(
      messages[index]
    );

  const after =
    messages
      .slice(
        index + 1
      )
      .map(
        messageText
      )
      .join(
        "\n"
      );

  const diagnosticCompleted =
    after.includes(
      "[JEV_READONLY_DIAGNOSTIC]"
    ) &&
    after.includes(
      "[JEV_READONLY_DIAGNOSTIC_DONE]"
    );

  return {
    prompt,
    after,
    diagnosticCompleted,

    alreadyRouted:
      after.includes(
        "[JEV_BRIDGE]"
      ) ||
      after.includes(
        "JEV_BRIDGE_RESULT"
      )
  };
}

function needsReadonlyDiagnostic(prompt) {
  const text =
    String(prompt || "")
      .toLowerCase();

  const terminalEvidenceTerms = [
    "pytest",
    "testleri",
    "testleri tekrar",
    "testleri Ã§alÄ±ÅŸtÄ±r",
    "testleri calistir",
    "test run",
    "run tests",
    "traceback",
    "stack trace",
    "git status",
    "git diff",
    "baseline",
    "head baseline",
    "build",
    "lint",
    "typecheck",
    "type-check",
    "working tree",
    "worktree",
    "baÅŸarÄ±sÄ±z test",
    "basarisiz test",
    "hata nedeni",
    "failure"
  ];

  return terminalEvidenceTerms.some(
    term =>
      text.includes(
        term
      )
  );
}

function hasRunCommandsTool(body) {
  return Array.isArray(
    body?.tools
  ) &&
  body.tools.some(
    tool =>
      tool
        ?.function
        ?.name ===
      "run_commands"
  );
}

async function classify(prompt) {
  if (
    !JEV_KEY
  ) {
    return {
      choice:
        "read_only_native",

      confidence:
        0,

      fallback:
        true
    };
  }

  const response =
    await fetch(
      JEV_URL,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",

          authorization:
            `Bearer ${JEV_KEY}`
        },

        body:
          JSON.stringify({
            model:
              JEV_MODEL,

            state: {
              userTask:
                prompt,

              policy:
                "Classify only the requested development intent. Do not solve the task."
            },

            questions: {
              route: {
                type:
                  "choice",

                instructions:
                  "Classify the user request into exactly one route.",

                criteria: {
                  read_only_native:
                    "Read-only work that can be completed by reading explicitly named files or searching explicitly named code terms without running terminal commands.",

                  read_only_diagnostic:
                    "Read-only development diagnosis that requires executing tests, git status/diff, project discovery, baseline comparison, build checks, or other terminal evidence, while not requesting project-file changes.",

                  nonbehavioral_modify:
                    "A requested project-file change limited to documentation, comments, prose, formatting, or other non-runtime behavior.",

                  behavioral_modify:
                    "A requested implementation, bug fix, refactor, configuration change, dependency change, test change, or any change that can affect runtime behavior."
                }
              }
            }
          })
      }
    );

  const raw =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Jev route HTTP ${response.status}: ${raw.slice(0, 500)}`
    );
  }

  const parsed =
    JSON.parse(
      raw
    );

  const answer =
    parsed
      ?.answers
      ?.route;

  if (
    !answer ||
    answer.type !==
      "choice"
  ) {
    throw new Error(
      "Invalid Jev route response"
    );
  }

  return {
    choice:
      answer.choice,

    confidence:
      answer.confidence ?? null,

    probabilities:
      answer.probabilities || {}
  };
}

function completionEnvelope({
  body,
  command
}) {
  return {
    id:
      `chatcmpl-jev-proxy-${Date.now()}`,

    object:
      "chat.completion",

    created:
      Math.floor(
        Date.now() /
        1000
      ),

    model:
      body?.model ||
      "jev-cline-agent",

    choices: [
      {
        index:
          0,

        message: {
          role:
            "assistant",

          content:
            null,

          tool_calls: [
            {
              id:
                `call_jev_bridge_${Date.now()}`,

              type:
                "function",

              function: {
                name:
                  "run_commands",

                arguments:
                  JSON.stringify({
                    commands: [
                      command
                    ]
                  })
              }
            }
          ]
        },

        finish_reason:
          "tool_calls"
      }
    ]
  };
}

function estimateClineTokens(
  value
) {
  let text = "";

  try {
    text =
      typeof value === "string"
        ? value
        : JSON.stringify(
            value ?? ""
          );
  }
  catch {
    text =
      String(
        value ?? ""
      );
  }

  const bytes =
    Buffer.byteLength(
      text,
      "utf8"
    );

  // Conservative tokenizer-independent approximation for mixed
  // English/Turkish/code/JSON traffic. Never returns zero for
  // non-empty content.
  return bytes > 0
    ? Math.max(
        1,
        Math.ceil(
          bytes / 3.6
        )
      )
    : 0;
}

function estimateClineUsage(
  body,
  envelope
) {
  const promptShape = {
    model:
      body?.model || null,

    messages:
      Array.isArray(body?.messages)
        ? body.messages
        : [],

    tools:
      Array.isArray(body?.tools)
        ? body.tools
        : [],

    tool_choice:
      body?.tool_choice ?? null,

    response_format:
      body?.response_format ?? null
  };

  const outputShape =
    Array.isArray(
      envelope?.choices
    )
      ? envelope.choices.map(
          choice => ({
            message:
              choice?.message ?? null,

            text:
              choice?.text ?? null,

            finish_reason:
              choice?.finish_reason ?? null
          })
        )
      : [];

  const promptTokens =
    estimateClineTokens(
      promptShape
    );

  const completionTokens =
    estimateClineTokens(
      outputShape
    );

  return {
    prompt_tokens:
      promptTokens,

    completion_tokens:
      completionTokens,

    total_tokens:
      promptTokens +
      completionTokens,

    prompt_tokens_details: {
      cached_tokens: 0
    },

    completion_tokens_details: {
      reasoning_tokens: 0
    }
  };
}
function sendOpenAI(
  res,
  body,
  command
) {
  const envelope =
    completionEnvelope({
      body,
      command
    });
  const clineUsage =
    estimateClineUsage(
      body,
      envelope
    );

  envelope.usage =
    clineUsage;

  if (
    JEV_LIVE_CONSOLE
  ) {
    console.log(
      `[CLINE_USAGE] prompt=${clineUsage.prompt_tokens} completion=${clineUsage.completion_tokens} total=${clineUsage.total_tokens} estimated=true`
    );
  }

  if (
    body?.stream ===
    true
  ) {
    const originalWrite =
      res.write.bind(
        res
      );

    let usageSent =
      false;

    res.write =
      function patchedUsageWrite(
        chunk,
        ...args
      ) {
        const text =
          Buffer.isBuffer(
            chunk
          )
            ? chunk.toString(
                "utf8"
              )
            : String(
                chunk ?? ""
              );

        if (
          !usageSent &&
          text.includes(
            "data: [DONE]"
          )
        ) {
          usageSent =
            true;

          const usageChunk = {
            id:
              envelope?.id ||
              `chatcmpl-jev-usage-${Date.now()}`,

            object:
              "chat.completion.chunk",

            created:
              envelope?.created ||
              Math.floor(
                Date.now() / 1000
              ),

            model:
              envelope?.model ||
              body?.model ||
              "jev-cline-agent",

            choices: [],

            usage:
              clineUsage
          };

          originalWrite(
            `data: ${JSON.stringify(usageChunk)}\n\n`
          );
        }

        return originalWrite(
          chunk,
          ...args
        );
      };
  }

  if (
    body?.stream ===
    true
  ) {
    res.writeHead(
      200,
      {
        "content-type":
          "text/event-stream; charset=utf-8",

        "cache-control":
          "no-cache",

        connection:
          "keep-alive"
      }
    );

    const choice =
      envelope.choices[0];

    const tc =
      choice.message.tool_calls[0];

    const first = {
      id:
        envelope.id,

      object:
        "chat.completion.chunk",

      created:
        envelope.created,

      model:
        envelope.model,

      choices: [
        {
          index:
            0,

          delta: {
            role:
              "assistant",

            tool_calls: [
              {
                index:
                  0,

                id:
                  tc.id,

                type:
                  "function",

                function: {
                  name:
                    tc.function.name,

                  arguments:
                    tc.function.arguments
                }
              }
            ]
          },

          finish_reason:
            null
        }
      ]
    };

    const last = {
      id:
        envelope.id,

      object:
        "chat.completion.chunk",

      created:
        envelope.created,

      model:
        envelope.model,

      choices: [
        {
          index:
            0,

          delta: {},

          finish_reason:
            "tool_calls"
        }
      ]
    };

    res.write(
      `data: ${JSON.stringify(first)}\n\n`
    );

    res.write(
      `data: ${JSON.stringify(last)}\n\n`
    );

    res.write(
      "data: [DONE]\n\n"
    );

    res.end();
    return;
  }

  const raw =
    JSON.stringify(
      envelope
    );

  res.writeHead(
    200,
    {
      "content-type":
        "application/json; charset=utf-8",

      "content-length":
        Buffer.byteLength(
          raw
        )
    }
  );

  res.end(
    raw
  );
}


function summarizeBridgeEvidence(value) {
  const text =
    String(value || "");

  const marker =
    "[JEV_BRIDGE] invoking_autonomy=true";

  const markerIndex =
    text.lastIndexOf(marker);

  const tail =
    markerIndex >= 0
      ? text.slice(markerIndex)
      : text;

  const interesting =
    tail
      .split(/\r?\n/)
      .filter(
        line =>
          /\[(?:JEV_BRIDGE|GENERAL_TASK|AUTONOMY|SANDBOX|SYNTH|LIVE|ROLLBACK|VALIDATION|ACCEPTANCE|BASELINE)[^\]]*\]/i.test(line) ||
          /"(?:status|reason|error)"\s*:/i.test(line) ||
          /\b(?:APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)\b/i.test(line) ||
          /\b(?:SyntaxError|ReferenceError|TypeError|Error:)\b/i.test(line)
      )
      .slice(-80)
      .join("\n");

  return interesting
    .replace(
      /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /("(?:api[_-]?key|api[_-]?secret|token|password)"\s*:\s*")[^"]*"/gi,
      '$1[REDACTED]"'
    )
    .slice(-12000);
}
function appendRequestTrace(event, data = {}) {
  try {
    const record = {
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...data
    };

    fs.appendFileSync(
      new URL(
        "./request-trace.jsonl",
        import.meta.url
      ),
      JSON.stringify(record) + "\n",
      "utf8"
    );
  }
  catch {
    // Tracing must never break routing.
  }
}
function flattenMessageText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return value;
  }

  if (
    typeof value ===
    "number" ||
    typeof value ===
    "boolean"
  ) {
    return String(value);
  }

  if (
    Array.isArray(
      value
    )
  ) {
    return value
      .map(
        item =>
          flattenMessageText(
            item
          )
      )
      .filter(Boolean)
      .join("\n");
  }

  if (
    typeof value ===
    "object"
  ) {
    return Object.values(
      value
    )
      .map(
        item =>
          flattenMessageText(
            item
          )
      )
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function mutationReportFromEvidence(evidence) {
  const text =
    String(
      evidence ||
      ""
    ).replace(
      /\\"/g,
      '"'
    );

  const statusMatch =
    text.match(
      /"status"\s*:\s*"(APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)"/i
    );

  const status =
    statusMatch
      ? statusMatch[1]
          .toUpperCase()
      : "UNKNOWN";

  const reasonMatch =
    text.match(
      /"reason"\s*:\s*"([^"\r\n]{1,1200})"/i
    );

  const reason =
    reasonMatch
      ? reasonMatch[1]
      : "";

  const changedMatch =
    text.match(
      /"changed"\s*:\s*\[([\s\S]*?)\]/i
    );

  const changed =
    changedMatch
      ? [
          ...changedMatch[1]
            .matchAll(
              /"([^"]+)"/g
            )
        ]
          .map(
            match =>
              match[1]
          )
          .slice(
            0,
            20
          )
      : [];

  const lines = [
    `JEV autonomy sonucu: ${status}.`
  ];

  if (
    status ===
    "APPLIED"
  ) {
    lines.push(
      "Candidate doÄŸrulama kapÄ±larÄ±ndan geÃ§erek Ã§alÄ±ÅŸma alanÄ±na uygulandÄ±."
    );
  }
  else if (
    status ===
    "NEEDS_VERIFICATION"
  ) {
    lines.push(
      "CanlÄ± uygulama yapÄ±lmadÄ±; deterministik doÄŸrulama gereksinimi karÅŸÄ±lanmadÄ±."
    );
  }
  else if (
    status ===
    "ROLLED_BACK"
  ) {
    lines.push(
      "DoÄŸrulama baÅŸarÄ±sÄ±z olduÄŸu iÃ§in deÄŸiÅŸiklik geri alÄ±ndÄ±."
    );
  }
  else if (
    status ===
    "REJECTED"
  ) {
    lines.push(
      "Candidate reddedildi ve canlÄ± Ã§alÄ±ÅŸma alanÄ±na uygulanmadÄ±."
    );
  }
  else if (
    status ===
    "FAILED" ||
    status ===
    "ERROR"
  ) {
    lines.push(
      "Autonomy yÃ¼rÃ¼tmesi baÅŸarÄ±sÄ±z oldu; sonuÃ§ canlÄ± uygulama olarak kabul edilmedi."
    );
  }

  if (
    reason
  ) {
    lines.push(
      `Neden: ${reason}`
    );
  }

  if (
    changed.length
  ) {
    lines.push(
      `DeÄŸiÅŸen dosyalar: ${changed.join(", ")}`
    );
  }

  lines.push(
    "Bu sonuÃ§ 4014 mutation finalizer tarafÄ±ndan sonlandÄ±rÄ±ldÄ±; legacy 4012 test parser devreye alÄ±nmadÄ±."
  );

  return lines.join("\n");
}
function diagnosticReportFromEvidence(evidence) {
  const text =
    String(evidence || "");

  const marker =
    text.match(
      /\[JEV_DIAGNOSTIC_JSON_B64\]([A-Za-z0-9+/=]+)/
    );

  if (!marker) {
    const current =
      text.match(
        /CURRENT_PYTEST_PARSED passed=(\d+) failed=(\d+)/
      );

    const baseline =
      text.match(
        /BASELINE_PYTEST_PARSED passed=(\d+) failed=(\d+)/
      );

    const lines = [
      "Salt-okunur teÅŸhis tamamlandÄ±."
    ];

    if (current) {
      lines.push(
        `Mevcut Ã§alÄ±ÅŸma aÄŸacÄ±: ${current[1]} test geÃ§ti, ${current[2]} test baÅŸarÄ±sÄ±z.`
      );
    }

    if (baseline) {
      lines.push(
        `HEAD baseline: ${baseline[1]} test geÃ§ti, ${baseline[2]} test baÅŸarÄ±sÄ±z.`
      );
    }
    else {
      lines.push(
        "HEAD baseline iÃ§in makine-okunur sonuÃ§ alÄ±namadÄ±."
      );
    }

    return lines.join("\n");
  }

  let data;

  try {
    data =
      JSON.parse(
        Buffer.from(
          marker[1],
          "base64"
        )
          .toString(
            "utf8"
          )
      );
  }
  catch {
    return "Salt-okunur teÅŸhis tamamlandÄ± ancak sonuÃ§ Ã¶zeti Ã§Ã¶zÃ¼mlenemedi.";
  }

  const lines = [
    "Salt-okunur teÅŸhis tamamlandÄ±."
  ];

  const current =
    data?.current || {};

  if (
    current.available
  ) {
    lines.push(
      `Mevcut Ã§alÄ±ÅŸma aÄŸacÄ±: ${current.passed ?? 0} test geÃ§ti, ${current.failed ?? 0} test baÅŸarÄ±sÄ±z.`
    );

    const failures =
      Array.isArray(
        current.failures
      )
        ? current.failures
        : [];

    for (const failure of failures) {
      const reason =
        failure?.reason
          ? ` â€” ${failure.reason}`
          : "";

      lines.push(
        `- ${failure?.name || "Bilinmeyen test"}${reason}`
      );
    }
  }
  else {
    lines.push(
      "Mevcut test sonucu alÄ±namadÄ±."
    );
  }

  const baseline =
    data?.baseline || {};

  if (
    baseline.available
  ) {
    lines.push(
      `HEAD baseline: ${baseline.passed ?? 0} test geÃ§ti, ${baseline.failed ?? 0} test baÅŸarÄ±sÄ±z.`
    );

    const comparison =
      data?.comparison || {};

    if (
      comparison.status ===
      "same_failures"
    ) {
      lines.push(
        "KarÅŸÄ±laÅŸtÄ±rma: mevcut baÅŸarÄ±sÄ±z testler HEAD baseline ile aynÄ±; bu hatalar mevcut Ã§alÄ±ÅŸma aÄŸacÄ±ndaki yeni deÄŸiÅŸikliklerden Ã¶nce de baseline'da bulunuyor."
      );
    }
    else if (
      comparison.status ===
      "different_failures"
    ) {
      const onlyCurrent =
        Array.isArray(
          comparison.onlyCurrent
        )
          ? comparison.onlyCurrent
          : [];

      const onlyBaseline =
        Array.isArray(
          comparison.onlyBaseline
        )
          ? comparison.onlyBaseline
          : [];

      lines.push(
        "KarÅŸÄ±laÅŸtÄ±rma: mevcut Ã§alÄ±ÅŸma aÄŸacÄ± ile HEAD baseline aynÄ± baÅŸarÄ±sÄ±zlÄ±k kÃ¼mesine sahip deÄŸil."
      );

      if (onlyCurrent.length) {
        lines.push(
          `YalnÄ±z mevcut Ã§alÄ±ÅŸma aÄŸacÄ±nda baÅŸarÄ±sÄ±z: ${onlyCurrent.join(", ")}`
        );
      }

      if (onlyBaseline.length) {
        lines.push(
          `YalnÄ±z HEAD baseline'da baÅŸarÄ±sÄ±z: ${onlyBaseline.join(", ")}`
        );
      }
    }
    else {
      lines.push(
        `KarÅŸÄ±laÅŸtÄ±rma: ${String(comparison.status || "belirsiz")}.`
      );
    }
  }
  else {
    lines.push(
      "HEAD baseline karÅŸÄ±laÅŸtÄ±rmasÄ± yapÄ±lamadÄ±."
    );
  }

  if (
    data?.gitAvailable
  ) {
    const changed =
      Array.isArray(
        data.gitChangedFiles
      )
        ? data.gitChangedFiles
        : [];

    lines.push(
      changed.length
        ? `Git diff dosyalarÄ±: ${changed.join(", ")}`
        : "Git diff: izlenen dosyalarda iÃ§erik farkÄ± yok."
    );
  }
  else {
    lines.push(
      "Git repository bilgisi alÄ±namadÄ±."
    );
  }

  lines.push(
    "Bu sonuÃ§ 4014 read-only diagnostic primitive tarafÄ±ndan sonlandÄ±rÄ±ldÄ±; legacy 4012 test sayacÄ± kullanÄ±lmadÄ±."
  );

  return lines.join("\n");
}

function sendTextOpenAI(
  res,
  body,
  content
) {
  const id =
    `chatcmpl-jev-diagnostic-${Date.now()}`;

  const created =
    Math.floor(
      Date.now() /
      1000
    );

  const model =
    body?.model ||
    "jev-cline-agent";

  if (
    body?.stream ===
    true
  ) {
    res.writeHead(
      200,
      {
        "content-type":
          "text/event-stream; charset=utf-8",
        "cache-control":
          "no-cache",
        connection:
          "keep-alive"
      }
    );

    res.write(
      `data: ${JSON.stringify({
        id,
        object:
          "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role:
                "assistant",
              content:
                String(content || "")
            },
            finish_reason:
              null
          }
        ]
      })}\n\n`
    );

    res.write(
      `data: ${JSON.stringify({
        id,
        object:
          "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              "stop"
          }
        ]
      })}\n\n`
    );

    res.write(
      "data: [DONE]\n\n"
    );

    res.end();
    return;
  }

  const envelope = {
    id,
    object:
      "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role:
            "assistant",
          content:
            String(content || "")
        },
        finish_reason:
          "stop"
      }
    ]
  };

  const raw =
    JSON.stringify(
      envelope
    );

  res.writeHead(
    200,
    {
      "content-type":
        "application/json; charset=utf-8",
      "content-length":
        Buffer.byteLength(
          raw
        )
    }
  );

  res.end(
    raw
  );
}
async function proxyRequest(
  req,
  res,
  rawBody
) {
  const target =
    new URL(
      req.url ||
      "/",
      UPSTREAM
    );

  const headers = {
    ...req.headers
  };

  delete headers.host;
  delete headers["content-length"];

  const upstream =
    await fetch(
      target,
      {
        method:
          req.method,

        headers,

        body:
          ["GET", "HEAD"]
            .includes(
              req.method ||
              "GET"
            )
            ? undefined
            : rawBody
      }
    );

  const bytes =
    Buffer.from(
      await upstream.arrayBuffer()
    );

  const responseHeaders = {};

  upstream.headers.forEach(
    (
      value,
      key
    ) => {
      if (
        key.toLowerCase() !==
          "content-length" &&
        key.toLowerCase() !==
          "transfer-encoding"
      ) {
        responseHeaders[key] =
          value;
      }
    }
  );

  responseHeaders[
    "content-length"
  ] =
    String(
      bytes.length
    );

  res.writeHead(
    upstream.status,
    responseHeaders
  );

  res.end(
    bytes
  );
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      try {
        if (
          req.method ===
            "GET" &&
          req.url ===
            "/health"
        ) {
          const raw =
            JSON.stringify({
              ok:
                true,

              port:
                PORT,

              upstream:
                UPSTREAM,

              jevConfigured:
                Boolean(
                  JEV_KEY
                )
            });

          res.writeHead(
            200,
            {
              "content-type":
                "application/json",

              "content-length":
                Buffer.byteLength(
                  raw
                )
            }
          );

          res.end(
            raw
          );

          return;
        }

        const rawBody =
          await readBody(
            req
          );

        const isChat =
          req.method ===
            "POST" &&
          String(
            req.url || ""
          )
            .includes(
              "/chat/completions"
            );

        if (
          !isChat
        ) {
          await proxyRequest(
            req,
            res,
            rawBody
          );

          return;
        }

        let body;

        try {
          body =
            JSON.parse(
              rawBody.toString(
                "utf8"
              )
            );
        }
        catch {
          await proxyRequest(
            req,
            res,
            rawBody
          );

          return;
        }

        const messages =
          Array.isArray(
            body.messages
          )
            ? body.messages
            : [];

        // Cline may serialize tool results as role=tool, role=user,
        // structured content arrays, or nested objects.
        // Scan the complete message payload before trying to infer
        // the latest conversational user prompt.
        const serializedMessages =
          JSON.stringify(
            messages
          );

        appendRequestTrace(
          "cline_request",
          {
            stream:
              body?.stream === true,

            messageCount:
              Array.isArray(messages)
                ? messages.length
                : 0,

            model:
              body?.model || null,

            hasBridgeResult:
              serializedMessages.includes(
                "[JEV_BRIDGE] invoking_autonomy=true"
              ),

            hasAcceptanceCommand:
              /Acceptance command:/i.test(
                serializedMessages
              ),

            hasLegacyTestVerify:
              serializedMessages.includes(
                "[TEST_VERIFY]"
              ),

            preview:
              flattenMessageText(
                messages
              ).slice(
                0,
                700
              )
          }
        );

        const flattenedMessages =
          flattenMessageText(
            messages
          );

        const normalizedMutationMessages =
          flattenedMessages.replace(
            /\\"/g,
            '"'
          );

        const mutationStatusMatch =
          normalizedMutationMessages.match(
            /"status"\s*:\s*"(APPLIED|NEEDS_VERIFICATION|ROLLED_BACK|REJECTED|FAILED|ERROR)"/i
          );

        const mutationPayloadPresent =
          normalizedMutationMessages.includes(
            "[JEV_BRIDGE] invoking_autonomy=true"
          ) &&
          Boolean(
            mutationStatusMatch
          );

        appendRequestTrace(
          "mutation_predicate",
          {
            bridge:
              normalizedMutationMessages.includes(
                "[JEV_BRIDGE] invoking_autonomy=true"
              ),

            workspaceMarker:
              normalizedMutationMessages.includes(
                "[JEV_BRIDGE] workspace_already_active="
              ),

            status:
              mutationStatusMatch
                ? mutationStatusMatch[1].toUpperCase()
                : null,

            matched:
              mutationPayloadPresent
          }
        );
        if (
          normalizedMutationMessages.includes(
            "[JEV_BRIDGE] invoking_autonomy=true"
          )
        ) {
          appendRequestTrace(
            "bridge_evidence",
            {
              status:
                mutationStatusMatch
                  ? mutationStatusMatch[1].toUpperCase()
                  : null,

              summary:
                summarizeBridgeEvidence(
                  normalizedMutationMessages
                )
            }
          );
        }

        if (
          mutationPayloadPresent
        ) {
          appendRequestTrace(
            "mutation_finalizer",
            {
              matched: true
            }
          );
          const report =
            mutationReportFromEvidence(
              flattenedMessages
            );

          console.log(
            `[PROXY_MUTATION_FINAL] chars=${report.length}`
          );

          sendTextOpenAI(
            res,
            body,
            report
          );

          return;
        }

        const diagnosticPayloadPresent =
          serializedMessages.includes(
            "[JEV_DIAGNOSTIC_JSON_B64]"
          ) &&
          serializedMessages.includes(
            "[JEV_READONLY_DIAGNOSTIC_DONE]"
          );

        if (
          diagnosticPayloadPresent
        ) {
          const report =
            diagnosticReportFromEvidence(
              serializedMessages
            );

          console.log(
            `[PROXY_DIAGNOSTIC_FINAL_SCAN] chars=${report.length}`
          );

          sendTextOpenAI(
            res,
            body,
            report
          );

          return;
        }

        const {
          prompt,
          after,
          diagnosticCompleted,
          alreadyRouted
        } =
          latestUserContext(
            messages
          );

        if (
          prompt &&
          diagnosticCompleted
        ) {
          const report =
            diagnosticReportFromEvidence(
              after
            );

          console.log(
            `[PROXY_DIAGNOSTIC_FINAL] chars=${report.length}`
          );

          sendTextOpenAI(
            res,
            body,
            report
          );

          return;
        }

        if (
          !prompt ||
          alreadyRouted ||
          !hasRunCommandsTool(
            body
          )
        ) {
          await proxyRequest(
            req,
            res,
            rawBody
          );

          return;
        }

        let route;

        try {
          route =
            await classify(
              prompt
            );
        }
        catch (
          error
        ) {
          console.error(
            `[PROXY_ROUTE_ERROR] ${String(error.message || error)}`
          );

          await proxyRequest(
            req,
            res,
            rawBody
          );

          return;
        }

        console.log(
          `[PROXY_ROUTE] choice=${route.choice} confidence=${route.confidence}`
        );

        if (
          route.choice ===
            "read_only_native" &&
          needsReadonlyDiagnostic(
            prompt
          )
        ) {
          console.log(
            `[PROXY_CAPABILITY_GUARD] upgrade=read_only_native->read_only_diagnostic reason=terminal_evidence_required`
          );

          route = {
            ...route,
            choice:
              "read_only_diagnostic",
            capabilityGuard:
              true
          };
        }

        if (
          route.choice ===
          "read_only_native"
        ) {
          await proxyRequest(
            req,
            res,
            rawBody
          );

          return;
        }

                if (
          JEV_LIVE_CONSOLE
        ) {
          console.log(
            `\n[USER]\n${prompt}\n`
          );
        }
const taskB64 =
          Buffer.from(
            prompt,
            "utf8"
          )
            .toString(
              "base64"
            );

        if (
          route.choice ===
          "read_only_diagnostic"
        ) {
          const command =
            `powershell -ExecutionPolicy Bypass -File "${READONLY_DIAGNOSTIC}" -TaskB64 "${taskB64}"`;

          console.log(
            `[PROXY_DIAGNOSTIC] route=${route.choice} task_chars=${prompt.length}`
          );

          sendOpenAI(
            res,
            body,
            command
          );

          return;
        }

        const taskB64Mutation =
          Buffer.from(
            prompt,
            "utf8"
          )
            .toString(
              "base64"
            );

        console.log(
          `[PROXY_DIRECT_AUTONOMY] route=${route.choice} task_chars=${prompt.length}`
        );

        await sendDirectAutonomy(
          res,
          body,
          taskB64Mutation,
          route.choice ===
            "nonbehavioral_modify"
        );

        return;
      }
      catch (
        error
      ) {
        console.error(
          `[PROXY_FATAL] ${String(error.stack || error)}`
        );

        if (
          !res.headersSent
        ) {
          const raw =
            JSON.stringify({
              error: {
                message:
                  String(
                    error.message ||
                    error
                  )
              }
            });

          res.writeHead(
            500,
            {
              "content-type":
                "application/json",

              "content-length":
                Buffer.byteLength(
                  raw
                )
            }
          );

          res.end(
            raw
          );
        }
        else {
          res.end();
        }
      }
    }
  );

server.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      "JEV CLINE ROUTER PROXY"
    );

    console.log(
      `http://127.0.0.1:${PORT}`
    );

    console.log(
      `Upstream: ${UPSTREAM}`
    );

    console.log(
      `Jev configured: ${Boolean(JEV_KEY)}`
    );

    console.log(
      "Mutation routing: ENABLED"
    );

    console.log(
      "Read-only diagnostic primitive: ENABLED"
    );

    console.log(
      "Qwen: DISABLED"
    );

    console.log(
      "Ollama: DISABLED"
    );
  }
);