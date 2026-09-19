import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { experienceContext } from "../memory/experience-store.mjs";

const PORT =
  Number(process.env.JEV_CLINE_PORT || 4012);

const JEV_URL =
  process.env.JEV_URL ||
  "https://api.typesafe.ai/v1/systemone";

const JEV_KEY =
  process.env.TYPESAFE_API_KEY || "";

const MODEL_ID =
  "jev-cline-agent";

const WORKSPACE_ROOT =
  process.env.JEV_WORKSPACE_ROOT ||
  process.cwd();

let JEV_CALLS = 0;

function fetchJevViaPowerShell(url, init) {
  return new Promise((resolve, reject) => {
    const script = [
      "$payload = [Console]::In.ReadToEnd()",
      "$key = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','Process')",
      "$response = Invoke-RestMethod -Uri $env:JEV_TARGET_URL -Method Post -Headers @{ Authorization = ('Bearer ' + $key) } -ContentType 'application/json' -Body $payload -TimeoutSec 60",
      "$response | ConvertTo-Json -Depth 100 -Compress"
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, JEV_TARGET_URL: url },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`PowerShell JEV transport failed: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(new Response(stdout, { status: 200, headers: { "content-type": "application/json" } }));
    });
    child.stdin.end(String(init?.body || ""));
  });
}

async function fetchJev(url, init) {
  const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await globalThis.fetch(url, init);
      if (!transientStatuses.has(response.status) || attempt === 3) return response;
      try { await response.arrayBuffer(); } catch {}
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    } catch (error) {
      lastError = error;
      if (attempt === 1 && process.platform === "win32") {
        try { return await fetchJevViaPowerShell(url, init); } catch (fallbackError) { lastError = fallbackError; }
      }
      if (attempt === 3) throw lastError;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError || new Error("Jev request failed");
}

// ============================================================
// BASIC HTTP
// ============================================================

async function readJson(req) {
  let raw = "";

  for await (const chunk of req) {
    raw += chunk;
  }

  return raw
    ? JSON.parse(raw)
    : {};
}

function sendResponse(
  res,
  status,
  data
) {
  // ----------------------------------------------------------
  // OpenAI SSE mode
  // ----------------------------------------------------------

  if (
    res.__openaiStream === true &&
    status === 200 &&
    data?.object === "chat.completion"
  ) {
    const choice =
      data?.choices?.[0] || {};

    const message =
      choice?.message || {};

    const toolCalls =
      Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

    const id =
      data.id ||
      `chatcmpl-jev-${Date.now()}`;

    const created =
      data.created ||
      Math.floor(Date.now() / 1000);

    res.writeHead(
      200,
      {
        "content-type":
          "text/event-stream; charset=utf-8",

        "cache-control":
          "no-cache",

        "connection":
          "keep-alive"
      }
    );

    const emit = (chunk) => {
      res.write(
        `data: ${JSON.stringify(chunk)}\n\n`
      );
    };

    const delta = {
      role: "assistant"
    };

    if (toolCalls.length > 0) {
      delta.tool_calls =
        toolCalls.map(
          (tc, index) => ({
            index,

            id:
              tc.id ||
              `call_jev_${Date.now()}_${index}`,

            type:
              "function",

            function: {
              name:
                tc.function?.name || "",

              arguments:
                tc.function?.arguments || "{}"
            }
          })
        );
    }
    else {
      delta.content =
        String(
          message.content || ""
        );
    }

    emit({
      id,
      object:
        "chat.completion.chunk",

      created,
      model:
        MODEL_ID,

      choices: [
        {
          index: 0,
          delta,
          finish_reason: null
        }
      ]
    });

    emit({
      id,
      object:
        "chat.completion.chunk",

      created,
      model:
        MODEL_ID,

      choices: [
        {
          index: 0,
          delta: {},

          finish_reason:
            choice.finish_reason ||
            (
              toolCalls.length > 0
                ? "tool_calls"
                : "stop"
            )
        }
      ]
    });

    res.write(
      "data: [DONE]\n\n"
    );

    res.end();
    return;
  }

  const raw =
    JSON.stringify(data);

  res.writeHead(
    status,
    {
      "content-type":
        "application/json; charset=utf-8",

      "content-length":
        Buffer.byteLength(raw)
    }
  );

  res.end(raw);
}

// ============================================================
// OPENAI RESPONSES
// ============================================================

function toolCallResponse(
  name,
  args
) {
  return {
    id:
      `chatcmpl-jev-${Date.now()}`,

    object:
      "chat.completion",

    created:
      Math.floor(Date.now() / 1000),

    model:
      MODEL_ID,

    choices: [
      {
        index: 0,

        message: {
          role:
            "assistant",

          content:
            null,

          tool_calls: [
            {
              id:
                `call_jev_${Date.now()}`,

              type:
                "function",

              function: {
                name,

                arguments:
                  JSON.stringify(args)
              }
            }
          ]
        },

        finish_reason:
          "tool_calls"
      }
    ],

    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function textResponse(
  content
) {
  return {
    id:
      `chatcmpl-jev-${Date.now()}`,

    object:
      "chat.completion",

    created:
      Math.floor(Date.now() / 1000),

    model:
      MODEL_ID,

    choices: [
      {
        index: 0,

        message: {
          role:
            "assistant",

          content
        },

        finish_reason:
          "stop"
      }
    ],

    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

// ============================================================
// MESSAGE HELPERS
// ============================================================

function textOf(content) {
  if (
    typeof content === "string"
  ) {
    return content;
  }

  if (
    Array.isArray(content)
  ) {
    return content
      .map(part => {
        if (
          typeof part === "string"
        ) {
          return part;
        }

        return (
          typeof part?.text === "string"
            ? part.text
            : ""
        );
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function latestUserIndex(
  messages
) {
  for (
    let i = messages.length - 1;
    i >= 0;
    i--
  ) {
    if (
      messages[i]?.role === "user"
    ) {
      return i;
    }
  }

  return -1;
}

function findTool(
  body,
  name
) {
  const tools =
    Array.isArray(body.tools)
      ? body.tools
      : [];

  return tools.find(tool => {
    const toolName =
      tool?.function?.name ||
      tool?.name;

    return toolName === name;
  });
}

// ============================================================
// CANONICAL TOOL SIGNATURE
// ============================================================

function canonicalize(value) {
  if (
    Array.isArray(value)
  ) {
    return value.map(
      canonicalize
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const out = {};

    for (
      const key of
      Object.keys(value).sort()
    ) {
      out[key] =
        canonicalize(
          value[key]
        );
    }

    return out;
  }

  return value;
}

function toolSignature(
  name,
  args
) {
  return (
    `${name}:` +
    JSON.stringify(
      canonicalize(args)
    )
  );
}

function countRunCommandCalls(
  messages,
  command
) {
  let count = 0;

  for (
    const message of
    messages
  ) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray(
        message.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      message.tool_calls
    ) {
      if (
        call?.function?.name !==
        "run_commands"
      ) {
        continue;
      }

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        continue;
      }

      const commands =
        Array.isArray(
          args?.commands
        )
          ? args.commands
          : [];

      if (
        commands.includes(
          command
        )
      ) {
        count++;
      }
    }
  }

  return count;
}

function latestToolResultForRunCommand(
  messages,
  command
) {
  for (
    let i = messages.length - 1;
    i >= 1;
    i--
  ) {
    const toolMessage =
      messages[i];

    const assistantMessage =
      messages[i - 1];

    if (
      toolMessage?.role !== "tool" ||
      assistantMessage?.role !== "assistant" ||
      !Array.isArray(
        assistantMessage.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      assistantMessage.tool_calls
    ) {
      if (
        call?.function?.name !==
        "run_commands"
      ) {
        continue;
      }

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        continue;
      }

      const commands =
        Array.isArray(
          args?.commands
        )
          ? args.commands
          : [];

      if (
        commands.includes(
          command
        )
      ) {
        return textOf(
          toolMessage.content || ""
        );
      }
    }
  }

  return "";
}

function extractPytestRequirements(
  evidence
) {
  const normalized =
    normalizeReadEvidence(
      evidence
    );

  return normalized
    .split(/\r?\n/)
    .map(line =>
      line.trim()
    )
    .filter(line =>
      /^pytest(?:$|[-_]|[<>=!~])/i
        .test(line)
    );
}

function quoteShellArgument(
  value
) {
  return (
    '"' +
    String(value)
      .replace(
        /"/g,
        '\\"'
      ) +
    '"'
  );
}
function countReadCallsForPath(
  messages,
  targetPath
) {
  let count = 0;

  const normalizedTarget =
    path
      .normalize(
        targetPath
      )
      .toLowerCase();

  for (
    const message of
    messages
  ) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray(
        message.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      message.tool_calls
    ) {
      if (
        call?.function?.name !==
        "read_files"
      ) {
        continue;
      }

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        continue;
      }

      const files =
        Array.isArray(
          args?.files
        )
          ? args.files
          : [];

      if (
        files.some(file =>
          path
            .normalize(
              file?.path || ""
            )
            .toLowerCase() ===
          normalizedTarget
        )
      ) {
        count++;
      }
    }
  }

  return count;
}
function wasToolCallExecuted(
  messages,
  name,
  args
) {
  const signature =
    toolSignature(
      name,
      args
    );

  return executedToolSignatures(
    messages
  ).has(
    signature
  );
}
function executedToolSignatures(
  messages
) {
  const set =
    new Set();

  for (const message of messages) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray(
        message.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      message.tool_calls
    ) {
      const name =
        call?.function?.name;

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        args = {};
      }

      if (name) {
        set.add(
          toolSignature(
            name,
            args
          )
        );
      }
    }
  }

  return set;
}

// ============================================================
// SAFE WORKSPACE PATHS
// ============================================================

function safeResolve(
  candidate
) {
  if (!candidate) {
    return null;
  }

  const cleaned =
    candidate
      .replace(
        /^[`"'(]+/,
        ""
      )
      .replace(
        /[`"',;:.)]+$/,
        ""
      );

  const resolved =
    path.isAbsolute(cleaned)
      ? path.normalize(cleaned)
      : path.resolve(
          WORKSPACE_ROOT,
          cleaned
        );

  const root =
    path
      .resolve(WORKSPACE_ROOT)
      .toLowerCase();

  const target =
    resolved.toLowerCase();

  if (
    target === root ||
    target.startsWith(
      root +
      path.sep.toLowerCase()
    )
  ) {
    return resolved;
  }

  return null;
}

// ============================================================
// USER REQUEST → CANDIDATE FILES
// ============================================================

function extractInsertRequest(
  text
) {
  if (
    !/\bekle\b|\binsert\b/i.test(text)
  ) {
    return null;
  }

  const files =
    extractFiles(
      text
    );

  if (
    files.length !== 1
  ) {
    return null;
  }

  const anchors =
    [
      ...text.matchAll(
        /`([^`\r\n]+)`/g
      )
    ]
      .map(
        match =>
          match[1]
      )
      .filter(Boolean);

  if (
    anchors.length < 1
  ) {
    return null;
  }

  const block =
    text.match(
      /```(?:[\w.+-]+)?\s*\r?\n([\s\S]*?)```/
    );

  if (
    !block ||
    typeof block[1] !== "string"
  ) {
    return null;
  }

  let content =
    block[1].replace(
      /\r?\n$/,
      ""
    );

  if (
    !content
  ) {
    return null;
  }

  let direction = null;

  if (
    /(?:sat[ıi]r[ıi]ndan\s+)?sonra|after/i
      .test(text)
  ) {
    direction =
      "after";
  }
  else if (
    /(?:sat[ıi]r[ıi]ndan\s+)?[oö]nce|before/i
      .test(text)
  ) {
    direction =
      "before";
  }

  if (
    !direction
  ) {
    return null;
  }

  return {
    path:
      files[0],

    anchor:
      anchors[0],

    content,

    direction
  };
}

function countOccurrences(
  text,
  needle
) {
  if (
    !text ||
    !needle
  ) {
    return 0;
  }

  return (
    text
      .split(
        needle
      )
      .length - 1
  );
}
function extractCreateFileRequest(
  text
) {
  const createIntentText =
    text
      .replace(
        /```[\s\S]*?```/g,
        " "
      )
      .replace(
        /`[^`\r\n]*`/g,
        " "
      );

  if (
    !/(?:^|\s)(?:olu[sş]tur|create)(?=\s|[.,!?;:]|$)/i
      .test(
        createIntentText
      )
  ) {
    return null;
  }

  const files =
    extractFiles(
      text
    );

  if (
    files.length !== 1
  ) {
    return null;
  }

  const block =
    text.match(
      /```(?:[\w.+-]+)?\s*\r?\n([\s\S]*?)```/
    );

  if (
    !block ||
    typeof block[1] !== "string"
  ) {
    return null;
  }

  let content =
    block[1];

  // Preserve user content but remove only the code-fence
  // terminating newline if one was introduced by formatting.
  content =
    content.replace(
      /\r?\n$/,
      ""
    );

  if (
    content.length === 0
  ) {
    return null;
  }

  return {
    path:
      files[0],

    content
  };
}

function normalizeCommandEvidence(
  raw
) {
  if (
    typeof raw !== "string"
  ) {
    return "";
  }

  try {
    const parsed =
      JSON.parse(raw);

    const rows =
      Array.isArray(parsed)
        ? parsed
        : [parsed];

    return rows
      .map(row => {
        const parts = [];

        if (
          typeof row?.result === "string"
        ) {
          parts.push(
            row.result
          );
        }

        if (
          typeof row?.error === "string"
        ) {
          parts.push(
            row.error
          );
        }

        if (
          typeof row?.query === "string"
        ) {
          parts.push(
            `COMMAND: ${row.query}`
          );
        }

        if (
          typeof row?.success === "boolean"
        ) {
          parts.push(
            `SUCCESS: ${row.success}`
          );
        }

        return parts.join(
          "\n"
        );
      })
      .filter(Boolean)
      .join("\n\n");
  }
  catch {
    return raw;
  }
}
function hasRealPytestFailure(
  raw
) {
  const clean =
    String(raw || "")
      .replace(
        /\x1b\[[0-9;]*m/g,
        ""
      )
      .replace(
        /\r/g,
        ""
      );

  const runnerMissing =
    /No module named pytest/i
      .test(clean) ||
    /ModuleNotFoundError:\s*No module named ['"]pytest['"]/i
      .test(clean);

  const noTests =
    /no tests ran/i
      .test(clean) ||
    /no tests collected/i
      .test(clean) ||
    /collected\s+0\s+items/i
      .test(clean);

  if (
    runnerMissing ||
    noTests
  ) {
    return false;
  }

  return (
    /\b\d+\s+failed\b/i
      .test(clean) ||
    /\b\d+\s+errors?\b/i
      .test(clean) ||
    /^\s*FAILED\s+/mi
      .test(clean) ||
    /^\s*ERROR\s+/mi
      .test(clean) ||
    /=+\s*FAILURES\s*=+/i
      .test(clean) ||
    /=+\s*ERRORS\s*=+/i
      .test(clean)
  );
}

function wantsTransactionalAutoFix(
  text
) {
  return (
    /(?:otomatik|automatic)/i
      .test(text) &&
    /(?:d[uü]zelt|onar|fix|repair)/i
      .test(text)
  );
}

function pytestPassed(
  raw
) {
  const clean =
    String(raw || "")
      .replace(
        /\x1b\[[0-9;]*m/g,
        ""
      )
      .replace(
        /\r/g,
        ""
      );

  if (
    /No module named pytest/i
      .test(clean)
  ) {
    return false;
  }

  if (
    hasRealPytestFailure(
      clean
    )
  ) {
    return false;
  }

  return (
    /\b\d+\s+passed\b/i
      .test(clean)
  );
}

function latestToolResultForReadPath(
  messages,
  targetPath
) {
  const normalizedTarget =
    path
      .normalize(
        targetPath
      )
      .toLowerCase();

  for (
    let i = messages.length - 1;
    i >= 1;
    i--
  ) {
    const toolMessage =
      messages[i];

    const assistantMessage =
      messages[i - 1];

    if (
      toolMessage?.role !== "tool" ||
      assistantMessage?.role !== "assistant" ||
      !Array.isArray(
        assistantMessage.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      assistantMessage.tool_calls
    ) {
      if (
        call?.function?.name !==
        "read_files"
      ) {
        continue;
      }

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        continue;
      }

      const files =
        Array.isArray(
          args?.files
        )
          ? args.files
          : [];

      const match =
        files.some(
          file =>
            path
              .normalize(
                file?.path || ""
              )
              .toLowerCase() ===
            normalizedTarget
        );

      if (
        match
      ) {
        return textOf(
          toolMessage.content || ""
        );
      }
    }
  }

  return "";
}

function controlledProbeRepairSpec() {
  return {
    path:
      safeResolve(
        "test_jev_failure_probe.py"
      ),

    oldText:
      "assert 1 == 2",

    newText:
      "assert 1 == 1"
  };
}
function escapeRegExp(
  value
) {
  return String(value)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
}

function extractNameErrorSymbol(
  raw
) {
  const clean =
    String(raw || "")
      .replace(
        /\x1b\[[0-9;]*m/g,
        ""
      )
      .replace(
        /\r/g,
        ""
      );

  const match =
    clean.match(
      /NameError:\s*name\s+['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s+is\s+not\s+defined/i
    );

  return match
    ? match[1]
    : null;
}

function pythonModuleFromFile(
  file
) {
  let relative =
    path
      .relative(
        WORKSPACE_ROOT,
        file
      )
      .replace(
        /\\/g,
        "/"
      );

  if (
    !relative ||
    relative.startsWith(
      "../"
    ) ||
    !relative.endsWith(
      ".py"
    )
  ) {
    return null;
  }

  relative =
    relative.slice(
      0,
      -3
    );

  if (
    relative.endsWith(
      "/__init__"
    )
  ) {
    relative =
      relative.slice(
        0,
        -"/__init__".length
      );
  }

  if (
    !relative
  ) {
    return null;
  }

  return relative
    .split("/")
    .filter(Boolean)
    .join(".");
}

function pythonFileDefinesSymbol(
  content,
  symbol
) {
  if (
    !content ||
    !symbol
  ) {
    return false;
  }

  const escaped =
    escapeRegExp(
      symbol
    );

  const definition =
    new RegExp(
      `^\\s*(?:` +
      `class\\s+${escaped}\\b` +
      `|def\\s+${escaped}\\b` +
      `|${escaped}\\s*=` +
      `)`,
      "m"
    );

  return definition.test(
    content
  );
}

function firstStablePythonLine(
  content
) {
  const lines =
    String(content || "")
      .replace(
        /\r/g,
        ""
      )
      .split(
        "\n"
      );

  for (
    const line of
    lines
  ) {
    if (
      line.trim().length === 0
    ) {
      continue;
    }

    // First V4 provider deliberately avoids files where
    // an import cannot safely be prepended mechanically.
    if (
      line.startsWith("#!") ||
      /coding[:=]/i.test(line) ||
      /^from\s+__future__\s+import\b/
        .test(line)
    ) {
      return null;
    }

    return line;
  }

  return null;
}

function extractNameErrorFailureFile(
  raw,
  symbol
) {
  if (
    !raw ||
    !symbol
  ) {
    return null;
  }

  const clean =
    String(raw)
      .replace(
        /\x1b\[[0-9;]*m/g,
        ""
      )
      .replace(
        /\r/g,
        ""
      );

  const escapedSymbol =
    escapeRegExp(
      symbol
    );

  const lines =
    clean.split(
      "\n"
    );

  for (
    const rawLine of
    lines
  ) {
    const line =
      rawLine.trim();

    if (
      !line.startsWith(
        "FAILED "
      )
    ) {
      continue;
    }

    const regex =
      new RegExp(
        "^FAILED\\s+(.+?\\.py)::.*?\\s+-\\s+" +
        "NameError:\\s*name\\s+['\"]" +
        escapedSymbol +
        "['\"]\\s+is\\s+not\\s+defined\\s*$",
        "i"
      );

    const match =
      line.match(
        regex
      );

    if (
      !match
    ) {
      continue;
    }

    const rawPath =
      match[1].trim();

    const candidate =
      path.isAbsolute(
        rawPath
      )
        ? path.normalize(
            rawPath
          )
        : safeResolve(
            rawPath
          );

    if (
      !candidate ||
      !isProjectSourceFile(
        candidate
      )
    ) {
      console.log(
        `[NAMEERROR_TARGET] symbol=${symbol} file=rejected`
      );

      return null;
    }

    console.log(
      `[NAMEERROR_TARGET]` +
      ` symbol=${symbol}` +
      ` file=${path.relative(
        WORKSPACE_ROOT,
        candidate
      )}`
    );

    return candidate;
  }

  console.log(
    `[NAMEERROR_TARGET] symbol=${symbol} file=unknown`
  );

  return null;
}
function buildLocalImportCandidates(
  messages,
  symbol,
  failingFiles,
  discoveredFiles
) {
  if (
    !symbol
  ) {
    return [];
  }

  const failingSet =
    new Set(
      failingFiles.map(
        file =>
          path
            .normalize(file)
            .toLowerCase()
      )
    );

  const failingFile =
    failingFiles[0];

  if (
    !failingFile
  ) {
    return [];
  }

  const failingRaw =
    latestToolResultForReadPath(
      messages,
      failingFile
    );

  const failingContent =
    normalizeReadEvidence(
      failingRaw
    );

  const anchor =
    firstStablePythonLine(
      failingContent
    );

  if (
    !anchor
  ) {
    return [];
  }

  const candidates = [];

  for (
    const sourceFile of
    discoveredFiles
  ) {
    const normalizedSource =
      path
        .normalize(
          sourceFile
        )
        .toLowerCase();

    if (
      failingSet.has(
        normalizedSource
      )
    ) {
      continue;
    }

    if (
      !/\.py$/i.test(
        sourceFile
      )
    ) {
      continue;
    }

    const sourceRaw =
      latestToolResultForReadPath(
        messages,
        sourceFile
      );

    if (
      !sourceRaw
    ) {
      continue;
    }

    const sourceContent =
      normalizeReadEvidence(
        sourceRaw
      );

    if (
      !pythonFileDefinesSymbol(
        sourceContent,
        symbol
      )
    ) {
      continue;
    }

    const moduleName =
      pythonModuleFromFile(
        sourceFile
      );

    if (
      !moduleName
    ) {
      continue;
    }

    const importLine =
      `from ${moduleName} import ${symbol}`;

    if (
      failingContent.includes(
        importLine
      )
    ) {
      continue;
    }

    candidates.push({
      path:
        failingFile,

      sourceFile,

      symbol,

      moduleName,

      importLine,

      oldText:
        anchor,

      newText:
        importLine +
        "\n" +
        anchor
    });
  }

  return candidates;
}

function findAppliedLocalImportRepair(
  messages
) {
  for (
    const message of
    messages
  ) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray(
        message.tool_calls
      )
    ) {
      continue;
    }

    for (
      const call of
      message.tool_calls
    ) {
      if (
        call?.function?.name !==
        "editor"
      ) {
        continue;
      }

      let args = {};

      try {
        args =
          JSON.parse(
            call?.function?.arguments ||
            "{}"
          );
      }
      catch {
        continue;
      }

      const oldText =
        args?.old_text;

      const newText =
        args?.new_text;

      const targetPath =
        args?.path;

      if (
        typeof oldText !== "string" ||
        typeof newText !== "string" ||
        typeof targetPath !== "string"
      ) {
        continue;
      }

      const prefix =
        newText.slice(
          0,
          newText.length -
          oldText.length
        );

      const match =
        prefix.match(
          /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*)\n$/
        );

      if (
        !match ||
        !newText.endsWith(
          oldText
        )
      ) {
        continue;
      }

      return {
        path:
          targetPath,

        oldText,

        newText,

        moduleName:
          match[1],

        symbol:
          match[2],

        importLine:
          `from ${match[1]} import ${match[2]}`
      };
    }
  }

  return null;
}
function extractFailureProjectFiles(
  raw
) {
  const text =
    String(raw || "")
      .replace(
        /\x1b\[[0-9;]*m/g,
        ""
      )
      .replace(
        /\r/g,
        ""
      );

  const found =
    new Set();

  const addCandidate =
    candidate => {
      if (
        !candidate
      ) {
        return;
      }

      let resolved = null;

      if (
        /^[A-Za-z]:\\/
          .test(candidate)
      ) {
        resolved =
          path.normalize(
            candidate
          );
      }
      else {
        resolved =
          safeResolve(
            candidate
          );
      }

      if (
        resolved &&
        isProjectSourceFile(
          resolved
        )
      ) {
        found.add(
          resolved
        );
      }
    };

  // Python traceback:
  // File "C:\project\app\x.py", line 15
  for (
    const match of
    text.matchAll(
      /File\s+"([A-Za-z]:\\[^"\r\n]+?\.py)"\s*,\s*line\s+\d+/gi
    )
  ) {
    addCandidate(
      match[1]
    );
  }

  // Absolute pytest path:
  // C:\project\app\x.py:15
  for (
    const match of
    text.matchAll(
      /([A-Za-z]:\\[^"\r\n]+?\.py)(?=:\d+|::|\s|$)/gi
    )
  ) {
    addCandidate(
      match[1]
    );
  }

  // FAILED tests/test_x.py::test_name
  for (
    const match of
    text.matchAll(
      /(?:FAILED|ERROR)\s+((?:[\w.-]+[\\/])*[\w.-]+\.py)/gi
    )
  ) {
    addCandidate(
      match[1]
    );
  }

  // Relative traceback / pytest path:
  // tests/test_x.py:12
  for (
    const match of
    text.matchAll(
      /(?:^|\n)((?:[\w.-]+[\\/])*[\w.-]+\.py)(?=:\d+|::|\s|$)/gmi
    )
  ) {
    addCandidate(
      match[1]
    );
  }

  return [
    ...found
  ]
    .sort(
      (a, b) =>
        a.localeCompare(b)
    )
    .slice(
      0,
      6
    );
}

async function askJevTestFailureDiagnosis(
  userText,
  testEvidence,
  inspectedEvidence,
  candidateFiles
) {
  const relativeFiles =
    candidateFiles.map(
      file =>
        path.relative(
          WORKSPACE_ROOT,
          file
        )
    );

  const fileCriteria = {
    unknown:
      "The available evidence does not identify one specific project file as the strongest target."
  };

  relativeFiles.forEach(
    (file, index) => {
      fileCriteria[
        `file_${index + 1}`
      ] =
        `The strongest direct pytest/traceback evidence points to this project file: ${file}`;
    }
  );

  const payload = {
    model:
      "jev-latest",

    state: {
      task:
        userText,

      prior_experience:
        experienceContext(userText).slice(0, 12000),

      pytest_evidence:
        String(
          testEvidence
        ).slice(
          0,
          16000
        ),

      inspected_project_evidence:
        String(
          inspectedEvidence
        ).slice(
          0,
          16000
        ),

      candidate_files:
        relativeFiles,

      rules: [
        "Use only the supplied pytest and project-file evidence.",
        "Do not invent missing code.",
        "Do not propose or generate a patch.",
        "Classify the failure and identify the strongest evidenced scope.",
        "If evidence is insufficient choose unknown."
      ]
    },

    questions: {
      failure_class: {
        type:
          "choice",

        instructions:
          "Classify the primary observed test failure.",

        criteria: {
          assertion_failure:
            "The failure is directly caused by a failed assertion.",
          import_error:
            "The failure is an import/module loading failure.",
          syntax_error:
            "The failure is a Python syntax or indentation error.",
          name_error:
            "The failure is a NameError or unresolved Python name.",
          attribute_error:
            "The failure is an AttributeError.",
          type_error:
            "The failure is a TypeError.",
          value_error:
            "The failure is a ValueError.",
          runtime_error:
            "The failure is another explicit runtime exception.",
          unknown:
            "The primary failure class cannot be verified."
        }
      },

      fault_scope: {
        type:
          "choice",

        instructions:
          "Which scope is most directly implicated by the supplied evidence?",

        criteria: {
          test_code:
            "The direct failing location or assertion is in test code.",
          application_code:
            "The traceback directly implicates application/project source code outside the tests.",
          dependency_environment:
            "The evidence directly indicates an environment, dependency or module availability problem.",
          unknown:
            "The evidence does not establish the scope."
        }
      },

      target_file: {
        type:
          "choice",

        instructions:
          "Select the project file most directly supported by the traceback evidence.",

        criteria:
          fileCriteria
      }
    }
  };

  const started =
    Date.now();

  const response =
    await fetchJev(
      JEV_URL,
      {
        method:
          "POST",

        headers: {
          authorization:
            `Bearer ${JEV_KEY}`,

          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const ms =
    Date.now() -
    started;

  const raw =
    await response.text();

  if (
    !response.ok
  ) {
    throw new Error(
      `Jev failure diagnosis HTTP ${response.status}: ${raw.slice(0,500)}`
    );
  }

  const data =
    JSON.parse(
      raw
    );

  const selectedFile =
    answerChoice(
      data,
      "target_file"
    );

  let targetFile =
    "unknown";

  const selectedMatch =
    /^file_(\d+)$/
      .exec(
        selectedFile
      );

  if (
    selectedMatch
  ) {
    const index =
      Number(
        selectedMatch[1]
      ) - 1;

    if (
      relativeFiles[index]
    ) {
      targetFile =
        relativeFiles[index];
    }
  }

  const diagnosis = {
    failure_class:
      answerChoice(
        data,
        "failure_class"
      ),

    fault_scope:
      answerChoice(
        data,
        "fault_scope"
      ),

    target_file:
      targetFile
  };

  console.log(
    `[JEV_FAILURE_DIAGNOSIS]` +
    ` time_ms=${ms}` +
    ` ${JSON.stringify(diagnosis)}`
  );

  return diagnosis;
}
function normalizeReadEvidence(
  raw
) {
  return evidenceResultText(
    raw
  )
    .split(/\r?\n/)
    .map(line =>
      line.replace(
        /^\s*\d+\s+\|\s?/,
        ""
      )
    )
    .join("\n")
    .trim();
}
function extractExactReplaceRequest(
  text
) {
  if (
    !/de[gğ]i[sş]tir|replace/i.test(text)
  ) {
    return null;
  }

  const files =
    extractFiles(
      text
    );

  if (
    files.length !== 1
  ) {
    return null;
  }

  const codeParts =
    [
      ...text.matchAll(
        /`([^`]+)`/g
      )
    ]
      .map(
        match =>
          match[1]
      );

  if (
    codeParts.length < 2
  ) {
    return null;
  }

  const oldText =
    codeParts[0];

  const newText =
    codeParts[1];

  if (
    !oldText ||
    oldText === newText
  ) {
    return null;
  }

  return {
    path:
      files[0],

    oldText,

    newText
  };
}

function wantsTestRepair(
  text
) {
  return (
    /test.*(?:d[uü]zelt|onar|fix)/i.test(text) ||
    /pytest.*(?:eksik|kur|y[uü]kle|install|d[uü]zelt)/i.test(text) ||
    /(?:eksik|missing).*(?:ba[gğ][ıi]ml[ıi]l[ıi]k|dependency)/i.test(text) ||
    /test\s+ortam[ıi]n[ıi].*(?:d[uü]zelt|onar|fix)/i.test(text)
  );
}
function wantsTests(
  text
) {
  return (
    /\bpytest\b/i.test(text) ||
    /testleri?\s+(?:çalıştır|calistir|koş|kos)/i.test(text) ||
    /\brun\s+(?:the\s+)?tests?\b/i.test(text)
  );
}
function wantsWriteOperation(
  text
) {
  return (
    /de[gğ]i[sş]tir|replace|d[uü]zenle|edit|olu[sş]tur|create|yaz\b/i
      .test(text)
  );
}
function extractFiles(
  text
) {
  const pathCandidates =
    new Set();

  const relativePathRegex =
    /\b(?:[\w.-]+[\\/])+[\w.-]+\.(?:py|txt|json|toml|yaml|yml|md|ini|cfg|mjs|cjs|js|ts|tsx|jsx|sql)\b/gi;

  for (
    const match of
    text.matchAll(
      relativePathRegex
    )
  ) {
    pathCandidates.add(
      match[0]
    );
  }

  const simpleFileRegex =
    /\b[\w.-]+\.(?:py|txt|json|toml|yaml|yml|md|ini|cfg|mjs|cjs|js|ts|tsx|jsx|sql)\b/gi;

  for (
    const match of
    text.matchAll(
      simpleFileRegex
    )
  ) {
    const candidate =
      match[0];

    const alreadyCovered =
      [...pathCandidates]
        .some(existing =>
          existing
            .toLowerCase()
            .endsWith(
              candidate.toLowerCase()
            )
        );

    if (!alreadyCovered) {
      pathCandidates.add(
        candidate
      );
    }
  }

  return [...pathCandidates]
    .map(
      safeResolve
    )
    .filter(Boolean);
}

// ============================================================
// USER REQUEST → SEARCH TERMS
// ============================================================

function escapeRegex(
  value
) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function wantsFileTree(
  text
) {
  return (
    /dosya\s+a[gğ]ac[ıi]/i.test(text) ||
    /klas[oö]r\s+a[gğ]ac[ıi]/i.test(text) ||
    /\bfile\s+tree\b/i.test(text) ||
    /\bdirectory\s+tree\b/i.test(text)
  );
}

function treeTargetFromText(
  text
) {
  if (
    /\bapp\b/i.test(text)
  ) {
    return safeResolve(
      "app"
    );
  }

  return safeResolve(
    "."
  );
}
function extractSearchTerms(
  text
) {
  const terms =
    new Set();

  const quoted =
    /["'`]([^"'`]{2,100})["'`]/g;

  for (
    const match of
    text.matchAll(quoted)
  ) {
    const value =
      match[1].trim();

    if (
      value &&
      !value.includes("\\") &&
      !value.includes("/")
    ) {
      terms.add(value);
    }
  }

  const beforeSearch =
    /\b([A-Za-z_][A-Za-z0-9_]{2,})\s+(?:ifadesini|terimini|kelimesini)\s+(?:ara|bul)/gi;

  for (
    const match of
    text.matchAll(
      beforeSearch
    )
  ) {
    terms.add(
      match[1]
    );
  }

  const afterSearch =
    /(?:ara|bul|search)\s+([A-Za-z_][A-Za-z0-9_]{2,})/gi;

  for (
    const match of
    text.matchAll(
      afterSearch
    )
  ) {
    terms.add(
      match[1]
    );
  }

  return [...terms];
}

// ============================================================
// CURRENT TURN TOOL RESULTS
// ============================================================

function evidenceResultText(
  raw
) {
  if (
    typeof raw !== "string"
  ) {
    return "";
  }

  try {
    const parsed =
      JSON.parse(raw);

    const rows =
      Array.isArray(parsed)
        ? parsed
        : [parsed];

    return rows
      .map(row => {
        if (
          typeof row?.result === "string"
        ) {
          return row.result;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  catch {
    return raw;
  }
}

function isProjectSourceFile(
  candidate
) {
  if (
    !candidate ||
    typeof candidate !== "string"
  ) {
    return false;
  }

  // Reject malformed JSON-escaped / joined paths.
  if (
    candidate.includes("\\n") ||
    candidate.includes("\\r") ||
    /[\r\n]/.test(candidate)
  ) {
    return false;
  }

  const normalized =
    path.normalize(
      candidate
    );

  const relative =
    path.relative(
      WORKSPACE_ROOT,
      normalized
    );

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return false;
  }

  const unix =
    relative.replace(
      /\\/g,
      "/"
    );

  const lower =
    unix.toLowerCase();

  const parts =
    lower.split("/");

  const ignored =
    new Set([
      ".venv",
      ".git",
      "__pycache__",
      ".pytest_cache",
      "node_modules"
    ]);

  if (
    parts.some(
      part =>
        ignored.has(part)
    )
  ) {
    return false;
  }

  if (
    parts.includes(
      "site-packages"
    )
  ) {
    return false;
  }

  // Reject compiled/cache artifacts accidentally looking like .py.
  if (
    /\.cpython-\d+\.py$/i.test(
      lower
    )
  ) {
    return false;
  }

  return (
    /\.(py|txt|json|toml|yaml|yml|md|ini|cfg|mjs|cjs|js|ts|tsx|jsx|sql)$/i
      .test(lower)
  );
}

function discoveryEvidenceText(
  raw
) {
  if (
    typeof raw !== "string"
  ) {
    return "";
  }

  let parsed = null;

  try {
    parsed =
      JSON.parse(
        raw
      );
  }
  catch {
    return raw;
  }

  const strings = [];

  const ignoredKeys =
    new Set([
      "query",
      "queries",
      "command",
      "commands",
      "prompt",
      "arguments"
    ]);

  function walk(
    value,
    key = ""
  ) {
    if (
      value === null ||
      value === undefined
    ) {
      return;
    }

    if (
      typeof value === "string"
    ) {
      if (
        !ignoredKeys.has(
          String(key).toLowerCase()
        )
      ) {
        strings.push(
          value
        );
      }

      return;
    }

    if (
      Array.isArray(
        value
      )
    ) {
      value.forEach(
        item =>
          walk(
            item,
            key
          )
      );

      return;
    }

    if (
      typeof value === "object"
    ) {
      for (
        const [
          childKey,
          childValue
        ] of Object.entries(
          value
        )
      ) {
        if (
          ignoredKeys.has(
            String(
              childKey
            ).toLowerCase()
          )
        ) {
          continue;
        }

        walk(
          childValue,
          childKey
        );
      }
    }
  }

  walk(
    parsed
  );

  return strings.join(
    "\n"
  );
}
function searchHitFilesFromEvidence(
  messages
) {
  const results =
    currentToolResults(
      messages
    );

  const found =
    new Set();

  const hitRegex =
    /^\s*((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:py|js|ts|tsx|jsx|mjs|cjs|json|toml|yaml|yml|sql|txt|md)):\d+(?::\d+)?\s*$/gmi;

  for (
    const rawResult of
    results
  ) {
    const evidence =
      discoveryEvidenceText(
        rawResult
      );

    if (
      !evidence
    ) {
      continue;
    }

    for (
      const match of
      evidence.matchAll(
        hitRegex
      )
    ) {
      const candidate =
        safeResolve(
          match[1]
        );

      if (
        candidate &&
        isProjectSourceFile(
          candidate
        )
      ) {
        found.add(
          path.normalize(
            candidate
          )
        );
      }
    }
  }

  const files =
    [...found]
      .sort(
        (a, b) =>
          a.localeCompare(
            b
          )
      );

  console.log(
    `[SEARCH_HITS] files=${files.length}` +
    (
      files.length
        ? ` names=${files
            .map(file =>
              path.relative(
                WORKSPACE_ROOT,
                file
              )
            )
            .join(",")}`
        : ""
    )
  );

  return files;
}
function latestToolResultForNamedTool(
  messages,
  toolName
) {
  for (
    let i = messages.length - 1;
    i >= 1;
    i--
  ) {
    const toolMessage =
      messages[i];

    const assistantMessage =
      messages[i - 1];

    if (
      toolMessage?.role !== "tool" ||
      assistantMessage?.role !== "assistant" ||
      !Array.isArray(
        assistantMessage.tool_calls
      )
    ) {
      continue;
    }

    const matched =
      assistantMessage.tool_calls.some(
        call =>
          call?.function?.name ===
          toolName
      );

    if (
      matched
    ) {
      return textOf(
        toolMessage.content || ""
      );
    }
  }

  return "";
}

function searchCodebaseResultFiles(
  messages
) {
  const raw =
    latestToolResultForNamedTool(
      messages,
      "search_codebase"
    );

  if (
    !raw
  ) {
    console.log(
      "[SEARCH_RESULT_FILES] no_search_result=true"
    );

    return [];
  }

  const evidence =
    discoveryEvidenceText(
      raw
    );

  console.log(
    "[SEARCH_RESULT_RAW]"
  );

  console.log(
    evidence.slice(
      0,
      5000
    )
  );

  const found =
    new Set();

  const lines =
    evidence
      .replace(
        /\r/g,
        ""
      )
      .split(
        "\n"
      );

  for (
    const rawLine of
    lines
  ) {
    const line =
      rawLine.trim();

    if (
      !line
    ) {
      continue;
    }

    // Exact observed Cline format:
    //
    // app/repair_symbol_source.py:1:1
    // test_jev_nameerror_probe.py:2:12
    //
    const match =
      line.match(
        /^(.+\.py):(\d+):(\d+)$/
      );

    if (
      !match
    ) {
      continue;
    }

    let rawPath =
      match[1]
        .trim();

    // Normalize search result separators.
    rawPath =
      rawPath.replace(
        /[\/\\]+/g,
        path.sep
      );

    let candidate = null;

    if (
      path.isAbsolute(
        rawPath
      )
    ) {
      candidate =
        path.normalize(
          rawPath
        );
    }
    else {
      candidate =
        path.resolve(
          WORKSPACE_ROOT,
          rawPath
        );
    }

    const relative =
      path.relative(
        WORKSPACE_ROOT,
        candidate
      );

    const outsideWorkspace =
      !relative ||
      relative.startsWith(
        ".."
      ) ||
      path.isAbsolute(
        relative
      );

    if (
      outsideWorkspace
    ) {
      console.log(
        `[SEARCH_RESULT_REJECT] raw=${rawPath} reason=outside_workspace`
      );

      continue;
    }

    const parts =
      relative
        .split(
          path.sep
        )
        .map(
          part =>
            part.toLowerCase()
        );

    const blocked =
      parts.some(
        part =>
          [
            ".venv",
            ".git",
            "__pycache__",
            ".pytest_cache",
            "node_modules",
            "site-packages"
          ].includes(
            part
          )
      );

    if (
      blocked
    ) {
      console.log(
        `[SEARCH_RESULT_REJECT] raw=${rawPath} reason=blocked_path`
      );

      continue;
    }

    if (
      !candidate
        .toLowerCase()
        .endsWith(
          ".py"
        )
    ) {
      continue;
    }

    console.log(
      `[SEARCH_RESULT_ACCEPT] raw=${match[1]}` +
      ` resolved=${relative}`
    );

    found.add(
      path.normalize(
        candidate
      )
    );
  }

  const files =
    [...found]
      .sort(
        (a, b) =>
          a.localeCompare(
            b
          )
      );

  console.log(
    `[SEARCH_RESULT_FILES] files=${files.length}` +
    (
      files.length
        ? ` names=${files
            .map(file =>
              path.relative(
                WORKSPACE_ROOT,
                file
              )
            )
            .join(",")}`
        : ""
    )
  );

  return files;
}
function discoveredFilesFromEvidence(
  messages
) {
  const results =
    currentToolResults(
      messages
    );

  const found =
    new Set();

  const validExtensions =
    "(?:py|txt|json|toml|yaml|yml|md|ini|cfg|mjs|cjs|js|ts|tsx|jsx|sql)";

  function addCandidate(
    candidate
  ) {
    if (
      !candidate
    ) {
      return;
    }

    let cleaned =
      String(
        candidate
      )
        .trim()
        .replace(
          /^["'`]+|["'`,;]+$/g,
          ""
        );

    // Strip pytest/search suffix:
    // file.py:12
    // file.py:12:4
    // file.py::test_name
    cleaned =
      cleaned.replace(
        /(?::\d+(?::\d+)?)?(?:::[^\s"'`]*)?$/,
        ""
      );

    let resolved = null;

    if (
      /^[A-Za-z]:[\\/]/
        .test(
          cleaned
        )
    ) {
      resolved =
        path.normalize(
          cleaned
        );
    }
    else {
      resolved =
        safeResolve(
          cleaned
        );
    }

    if (
      resolved &&
      isProjectSourceFile(
        resolved
      )
    ) {
      found.add(
        path.normalize(
          resolved
        )
      );
    }
  }

  for (
    const rawResult of
    results
  ) {
    const evidence =
      discoveryEvidenceText(
        rawResult
      );

    if (
      !evidence
    ) {
      continue;
    }

    // --------------------------------------------------------
    // DEBUG: search/tool evidence'in gercek sekli
    // --------------------------------------------------------

    if (
      /JEV_IMPORT_VALUE|repair_symbol_source/i
        .test(
          evidence
        )
    ) {
      console.log(
        "[DISCOVERY_EVIDENCE]"
      );

      console.log(
        evidence.slice(
          0,
          5000
        )
      );
    }

    // --------------------------------------------------------
    // 1) ABSOLUTE WINDOWS PATHS
    // --------------------------------------------------------

    const absoluteRegex =
      new RegExp(
        `([A-Za-z]:[\\\\/][^\\r\\n"'<>|]*?\\.${validExtensions.slice(3,-1)})` +
        `(?=:\\d+|::|[\\s"'},\\]]|$)`,
        "gi"
      );

    let remaining =
      evidence;

    for (
      const match of
      evidence.matchAll(
        absoluteRegex
      )
    ) {
      addCandidate(
        match[1]
      );

      // Remove absolute path from relative scanning so:
      //
      // C:\Users\...\app\x.py
      //
      // cannot be re-read as:
      //
      // Users\...\app\x.py
      remaining =
        remaining.replace(
          match[0],
          " "
        );
    }

    // --------------------------------------------------------
    // 2) RELATIVE / ROOT-LEVEL PROJECT FILES
    //
    // Supports:
    // app/x.py
    // app\x.py
    // test_x.py
    // app/x.py:12
    // app/x.py:12:4
    // app/x.py::test_name
    // JSON: {"path":"app/x.py"}
    // --------------------------------------------------------

    const relativeRegex =
      new RegExp(
        `(?:^|[\\s"'({\\[,])` +
        `((?:[A-Za-z0-9_.-]+[\\\\/])*` +
        `[A-Za-z0-9_.-]+\\.${validExtensions.slice(3,-1)})` +
        `(?=:\\d+|::|[\\s"'})\\],]|$)`,
        "gim"
      );

    for (
      const match of
      remaining.matchAll(
        relativeRegex
      )
    ) {
      addCandidate(
        match[1]
      );
    }
  }

  const files =
    [...found]
      .sort(
        (a, b) =>
          a.localeCompare(
            b
          )
      );

  console.log(
    `[DISCOVERY] files=${files.length}` +
    (
      files.length
        ? ` names=${files
            .map(file =>
              path.relative(
                WORKSPACE_ROOT,
                file
              )
            )
            .join(",")}`
        : ""
    )
  );

  console.log(
    `[DISCOVERY_PATHS] ${files
      .map(file =>
        path.relative(
          WORKSPACE_ROOT,
          file
        )
      )
      .join(",")}`
  );

  return files;
}

function wantsArchitectureDiscovery(
  text
) {
  return (
    /\bmimari\b/i.test(text) ||
    /\barchitecture\b/i.test(text) ||
    /\bprojeyi\s+incele\b/i.test(text) ||
    /\bkod\s+taban[ıi]n[ıi]\s+incele\b/i.test(text) ||
    /\bcodebase\b.*\binspect\b/i.test(text) ||
    /\bproje\s+yap[ıi]s[ıi]\b/i.test(text)
  );
}

function architectureQueries(
  text
) {
  const queries =
    new Set();

  [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "src",
    "app",
    "tests",
    "test",
    "README.md",
    "Dockerfile"
  ].forEach(value => queries.add(value));

  if (/test|testler|doğrula|verify/i.test(text)) {
    ["jest", "pytest", "vitest", "npm test", "cargo test"].forEach(value => queries.add(value));
  }

  if (
    /entry\s*point|ba[sş]lang[ıi][cç]|giri[sş]\s+noktas[ıi]/i
      .test(text)
  ) {
    [
      "FastAPI",
      "uvicorn",
      "__main__",
      "create_app"
    ].forEach(
      value =>
        queries.add(value)
    );
  }

  return [...queries];
}
function wantsDiscoveredFileInspection(
  text
) {
  return (
    /\bincele\b/i.test(text) ||
    /\banaliz\b/i.test(text) ||
    /\bentry\s*point\b/i.test(text) ||
    /\bmimari\b/i.test(text) ||
    /\bhangi\s+dosya/i.test(text) ||
    /\bprojeyi\s+ke[sş]fet/i.test(text) ||
    /\bkod\s+taban[ıi]n[ıi]\s+incele/i.test(text)
  );
}
function currentToolResults(
  messages
) {
  const index =
    latestUserIndex(
      messages
    );

  const turn =
    index >= 0
      ? messages.slice(index)
      : messages;

  return turn
    .filter(
      m =>
        m?.role === "tool"
    )
    .map(
      m =>
        textOf(
          m.content || ""
        )
    )
    .filter(Boolean);
}

// ============================================================
// JEV
// ============================================================

function parseJevAnswer(
  data
) {
  const answer =
    data?.answers?.next_action ??
    data?.next_action ??
    data?.answer ??
    {};

  const choice =
    answer?.choice ??
    answer?.answer ??
    answer?.value ??
    answer?.selected ??
    null;

  const confidence =
    Number(
      answer?.confidence ??
      data?.confidence ??
      0
    );

  const readChoice = key => {
    const item = data?.answers?.[key] ?? data?.[key] ?? {};
    return item?.choice ?? item?.answer ?? item?.value ?? item?.selected ?? "unknown";
  };

  return {
    choice,
    confidence,
    reasoning: {
      taskIntent: readChoice("task_intent"),
      scopeRisk: readChoice("scope_risk"),
      verificationNeed: readChoice("verification_need")
    }
  };
}

function applyReasoningPolicy(decision, state) {
  const goal = String(state?.user_goal || "");
  const explicitReadOnly = /(?:kod|code|dosya|file).{0,60}(?:değiştirme|değişiklik yapma|değişmesin|do not change|don't change|no changes)|(?:değiştirme|değişiklik yapma|değişmesin|do not change|don't change|no changes).{0,60}(?:kod|code|dosya|file)/iu.test(goal);

  if (explicitReadOnly) {
    decision.reasoning = {
      ...decision.reasoning,
      taskIntent: "investigate",
      scopeRisk: "low",
      verificationNeed: "none"
    };
  }

  return decision;
}

async function askJev(
  state,
  actions
) {
  if (!JEV_KEY) {
    throw new Error(
      "TYPESAFE_API_KEY missing"
    );
  }

  const criteria = {};

  for (
    const action of actions
  ) {
    criteria[action.id] =
      action.criterion;
  }

  const payload = {
    model:
      "jev-latest",

    state: {
      ...state,
      reasoning_contract:
        "Decompose the request before acting. Prefer the smallest safe action, identify scope risk, and require semantic verification for behavioral changes."
    },

    questions: {
      next_action: {
        type:
          "choice",

        instructions:
          "You are the coding agent controller. Choose exactly one action from the provided criteria. If concrete actions are available, you MUST select one of them and continue autonomously. Never stop to ask the user when a safe concrete action is already available. Use actual tool evidence and never repeat completed work.",

        criteria
      },

      task_intent: {
        type: "choice",
        instructions: "Classify the user's primary development intent from the supplied task and evidence.",
        criteria: {
          investigate: "The user primarily asks to inspect, explain, diagnose, or report.",
          change: "The user asks to add, modify, refactor, or repair code.",
          verify: "The user primarily asks to run tests or validate an existing result.",
          unknown: "The evidence does not establish the intent."
        }
      },

      scope_risk: {
        type: "choice",
        instructions: "Estimate the change scope risk using only the current task and evidence.",
        criteria: {
          low: "Read-only inspection or a small isolated change with clear boundaries.",
          medium: "A bounded code change requiring tests or several related files.",
          high: "Broad, destructive, security-sensitive, dependency, deployment, or unclear change.",
          unknown: "The evidence does not establish the risk."
        }
      },

      verification_need: {
        type: "choice",
        instructions: "Choose the strongest verification requirement supported by the task.",
        criteria: {
          none: "Read-only reporting is sufficient and no state changes are requested.",
          syntax: "Only syntax or static validation is justified by the explicit request.",
          semantic: "Behavioral changes require project tests or an explicit acceptance command.",
          unknown: "The verification requirement is not clear from the evidence."
        }
      }
    }
  };

  JEV_CALLS++;

  const started =
    Date.now();

  const response =
    await fetchJev(
      JEV_URL,
      {
        method:
          "POST",

        headers: {
          authorization:
            `Bearer ${JEV_KEY}`,

          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const ms =
    Date.now() -
    started;

  const raw =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Jev HTTP ${response.status}: ${raw.slice(0,500)}`
    );
  }

  const data =
    JSON.parse(raw);

  const decision =
    applyReasoningPolicy(
      parseJevAnswer(data),
      state
    );

  console.log(
    `[JEV] call=${JEV_CALLS}` +
    ` time_ms=${ms}` +
    ` choice=${decision.choice}` +
    ` confidence=${decision.confidence}` +
    ` intent=${decision.reasoning?.taskIntent}` +
    ` risk=${decision.reasoning?.scopeRisk}` +
    ` verification=${decision.reasoning?.verificationNeed}`
  );

  if (
    !decision.choice
  ) {
    console.log(
      "[JEV_RAW]",
      raw.slice(
        0,
        3000
      )
    );

    throw new Error(
      "Jev returned no choice"
    );
  }

  return decision;
}

function answerChoice(
  data,
  key
) {
  const answer =
    data?.answers?.[key] ??
    data?.[key] ??
    {};

  return (
    answer?.choice ??
    answer?.answer ??
    answer?.value ??
    answer?.selected ??
    "unknown"
  );
}

async function askJevArchitectureSummary(
  userText,
  toolResults,
  discoveredFiles
) {
  const compactEvidence =
    toolResults
      .slice(-8)
      .map(result =>
        String(result).slice(
          0,
          5000
        )
      )
      .join("\n\n")
      .slice(
        0,
        24000
      );

  const relativeFiles =
    discoveredFiles
      .map(file =>
        path.relative(
          WORKSPACE_ROOT,
          file
        )
      )
      .sort();

  const payload = {
    model:
      "jev-latest",

    state: {
      task:
        userText,

      prior_experience:
        experienceContext(userText).slice(0, 12000),

      workspace_root:
        WORKSPACE_ROOT,

      discovered_files:
        relativeFiles,

      verified_tool_evidence:
        compactEvidence,

      rules: [
        "Use only supplied tool evidence.",
        "Do not infer implementation that was not actually found.",
        "Configuration fields do not prove that order execution code exists.",
        "If evidence is insufficient choose unknown."
      ]
    },

    questions: {
      project_structure: {
        type: "choice",
        instructions: "What project structure is directly evidenced by the supplied files?",
        criteria: {
          structured: "The evidence identifies source, tests, configuration or documentation areas.",
          partial: "Some project structure is visible but key areas remain unclear.",
          unknown: "The evidence is insufficient."
        }
      },
      test_setup: {
        type: "choice",
        instructions: "Is a test or verification setup directly evidenced?",
        criteria: {
          present: "A test command, test files or repeatable verification path is explicitly present.",
          absent: "The inspected evidence contains no test or verification setup.",
          unknown: "The evidence is insufficient."
        }
      },
      runtime_entry: {
        type: "choice",
        instructions: "Was an executable runtime entry point verified?",
        criteria: {
          found: "A main function, executable script, service entry point or equivalent was verified.",
          not_verified: "The inspected evidence does not verify an executable entry point.",
          unknown: "The evidence is insufficient."
        }
      },
      configuration_surface: {
        type: "choice",
        instructions: "Are configuration inputs and their boundaries directly evidenced?",
        criteria: {
          present: "Configuration files, environment inputs or command-line settings are explicitly present.",
          absent: "No configuration surface is evidenced.",
          unknown: "The evidence is insufficient."
        }
      },
      external_integrations: {
        type: "choice",
        instructions: "Are external services or integrations directly evidenced?",
        criteria: {
          present: "The code explicitly references external APIs, databases, queues or services.",
          absent: "No external integration is evidenced.",
          unknown: "The evidence is insufficient."
        }
      }
    }
  };

  const started =
    Date.now();

  const response =
    await fetchJev(
      JEV_URL,
      {
        method:
          "POST",

        headers: {
          authorization:
            `Bearer ${JEV_KEY}`,

          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  const ms =
    Date.now() -
    started;

  const raw =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Jev summary HTTP ${response.status}: ${raw.slice(0,500)}`
    );
  }

  const data =
    JSON.parse(raw);

  const summary = {
    project_structure: answerChoice(data, "project_structure"),
    test_setup: answerChoice(data, "test_setup"),
    runtime_entry: answerChoice(data, "runtime_entry"),
    configuration_surface: answerChoice(data, "configuration_surface"),
    external_integrations: answerChoice(data, "external_integrations")
  };

  console.log(
    `[JEV_SUMMARY] time_ms=${ms}` +
    ` ${JSON.stringify(summary)}`
  );

  return summary;
}

function formatArchitectureReport(
  summary,
  discoveredFiles,
  toolResults
) {
  const relativeFiles =
    discoveredFiles
      .map(file =>
        path.relative(
          WORKSPACE_ROOT,
          file
        )
      )
      .sort();

  const lines = [
    "Doğrulanmış genel proje özeti",
    "",
    relativeFiles.length > 0
      ? `- İncelenen proje dosyaları: ${relativeFiles.join(", ")}`
      : "- İncelenen proje dosyası bulunamadı."
  ];

  const labels = {
    project_structure: "Proje yapısı",
    test_setup: "Test/doğrulama düzeni",
    runtime_entry: "Çalıştırılabilir giriş noktası",
    configuration_surface: "Yapılandırma yüzeyi",
    external_integrations: "Harici entegrasyonlar"
  };
  for (const [key, label] of Object.entries(labels)) {
    if (summary[key] && summary[key] !== "unknown") {
      lines.push(`- ${label}: ${summary[key]}.`);
    }
  }

  if (toolResults.length > 0) {
    lines.push(`- Kanıt öğesi sayısı: ${toolResults.length}.`);
  }

  return lines.join(
    "\n"
  );
}

// ============================================================
// BUILD AVAILABLE ACTIONS
// ============================================================

function buildActions(
  body,
  userText,
  messages
) {
  const actions = [];

  const executed =
    executedToolSignatures(
      messages
    );

  const files =
    extractFiles(
      userText
    );

  const searchTerms =
    extractSearchTerms(
      userText
    );

  const hasReadFiles =
    Boolean(
      findTool(
        body,
        "read_files"
      )
    );

  const hasSearch =
    Boolean(
      findTool(
        body,
        "search_codebase"
      )
    );

  const hasRunCommands =
    Boolean(
      findTool(
        body,
        "run_commands"
      )
    );

  const hasEditor =
    Boolean(
      findTool(
        body,
        "editor"
      )
    );

  const exactReplace =
    extractExactReplaceRequest(
      userText
    );

  const createRequest =
    extractCreateFileRequest(
      userText
    );

  const insertRequest =
    extractInsertRequest(
      userText
    );

  const testRepairRequest =
    wantsTestRepair(
      userText
    );

  const testRequest =
    wantsTests(
      userText
    ) ||
    testRepairRequest;

  // ----------------------------------------------------------
  // RUN TESTS + FIX FAILURE V1
  //
  // V1 can automatically repair:
  // - missing pytest/test dependencies
  //
  // It will NOT invent code patches for failing tests yet.
  // ----------------------------------------------------------

  if (
    testRequest &&
    hasRunCommands
  ) {
    const testCommand =
      "python -m pytest -q";

    const testArgs = {
      commands: [
        testCommand
      ]
    };

    const testRunCount =
      countRunCommandCalls(
        messages,
        testCommand
      );

    const latestTestRaw =
      latestToolResultForRunCommand(
        messages,
        testCommand
      );

    const latestTestEvidence =
      normalizeCommandEvidence(
        latestTestRaw
      );

    const runnerMissing =
      /No module named pytest/i
        .test(
          latestTestEvidence
        ) ||
      /ModuleNotFoundError:\s*No module named ['"]pytest['"]/i
        .test(
          latestTestEvidence
        );

    // First test run.
    if (
      testRunCount === 0
    ) {
      actions.push({
        id:
          "run_tests",

        tool:
          "run_commands",

        args:
          testArgs,

        criterion:
          "Run the existing pytest suite and inspect the real result."
      });
    }

    // --------------------------------------------------------
    // Explicit FIX mode only.
    // --------------------------------------------------------

    else if (
      testRepairRequest &&
      runnerMissing
    ) {
      const requirementsPath =
        safeResolve(
          "requirements.txt"
        );

      const requirementsArgs = {
        files: [
          {
            path:
              requirementsPath,

            start_line:
              1,

            end_line:
              300
          }
        ]
      };

      const requirementsRead =
        executed.has(
          toolSignature(
            "read_files",
            requirementsArgs
          )
        );

      if (
        !requirementsRead &&
        hasReadFiles
      ) {
        actions.push({
          id:
            "inspect_test_requirements",

          tool:
            "read_files",

          args:
            requirementsArgs,

          criterion:
            "Pytest is missing from the active environment. Read the project's requirements.txt before installing anything and verify the declared test dependencies."
        });
      }
      else if (
        requirementsRead
      ) {
        const readEvidence =
          currentToolResults(
            messages
          )
            .map(
              evidenceResultText
            )
            .join(
              "\n"
            );

        const pytestRequirements =
          extractPytestRequirements(
            readEvidence
          );

        console.log(
          `[FIX_FAILURE]` +
          ` runner_missing=true` +
          ` pytest_requirements=${pytestRequirements.length}`
        );

        if (
          pytestRequirements.length > 0
        ) {
          const installCommand =
            "python -m pip install " +
            pytestRequirements
              .map(
                quoteShellArgument
              )
              .join(
                " "
              );

          const installCount =
            countRunCommandCalls(
              messages,
              installCommand
            );

          if (
            installCount === 0
          ) {
            actions.push({
              id:
                "install_test_dependencies",

              tool:
                "run_commands",

              args: {
                commands: [
                  installCommand
                ]
              },

              criterion:
                "The user explicitly requested repair, pytest is missing, and pytest dependencies were verified in requirements.txt. Install only those declared pytest dependencies."
            });
          }
          else if (
            testRunCount < 2
          ) {
            actions.push({
              id:
                "rerun_tests_after_repair",

              tool:
                "run_commands",

              args:
                testArgs,

              criterion:
                "The missing declared test dependencies were installed. Re-run pytest now to verify the repair."
            });
          }
        }
      }
    }
  }
  // ----------------------------------------------------------
  // FIX_FAILURE V4
  // Generic deterministic repair provider:
  //
  // Python NameError
  // -> search symbol
  // -> inspect real definitions
  // -> build local-import candidates
  // -> Jev selects candidate
  // -> pytest
  // -> keep or rollback
  // ----------------------------------------------------------

  if (
    wantsTransactionalAutoFix(
      userText
    ) &&
    testRepairRequest &&
    hasReadFiles &&
    hasSearch &&
    hasEditor &&
    hasRunCommands
  ) {
    const testCommand =
      "python -m pytest -q";

    const testRunCount =
      countRunCommandCalls(
        messages,
        testCommand
      );

    const latestTestRaw =
      latestToolResultForRunCommand(
        messages,
        testCommand
      );

    const latestTestEvidence =
      normalizeCommandEvidence(
        latestTestRaw
      );

    // ========================================================
    // If a V4 import patch has already been executed,
    // continue the transaction even if the latest pytest
    // output no longer contains the original NameError.
    // ========================================================

    const appliedRepair =
      findAppliedLocalImportRepair(
        messages
      );

    if (
      appliedRepair
    ) {
      const rollbackArgs = {
        path:
          appliedRepair.path,

        old_text:
          appliedRepair.newText,

        new_text:
          appliedRepair.oldText
      };

      const rollbackDone =
        wasToolCallExecuted(
          messages,
          "editor",
          rollbackArgs
        );

      if (
        !rollbackDone &&
        testRunCount < 2
      ) {
        actions.push({
          id:
            "rerun_tests_after_v4_patch",

          tool:
            "run_commands",

          args: {
            commands: [
              testCommand
            ]
          },

          criterion:
            "A verified local-import repair candidate was applied. Re-run the complete pytest suite before accepting the patch."
        });
      }
      else if (
        !rollbackDone &&
        testRunCount >= 2 &&
        !pytestPassed(
          latestTestEvidence
        )
      ) {
        console.log(
          "[FIX_V4_DECISION]" +
          " patched=true" +
          " tests_passed=false" +
          " action=rollback"
        );

        actions.push({
          id:
            "rollback_v4_repair",

          tool:
            "editor",

          args:
            rollbackArgs,

          criterion:
            "The complete pytest suite did not pass after the selected repair candidate. Roll back the exact patch."
        });
      }
      else if (
        rollbackDone
      ) {
        const readCount =
          countReadCallsForPath(
            messages,
            appliedRepair.path
          );

        if (
          readCount < 2
        ) {
          actions.push({
            id:
              "verify_v4_rollback",

            tool:
              "read_files",

            args: {
              files: [
                {
                  path:
                    appliedRepair.path,

                  start_line:
                    1,

                  end_line:
                    300
                }
              ]
            },

            criterion:
              "The V4 repair was rolled back. Re-read the modified file and verify restoration."
          });
        }
      }
    }

    // ========================================================
    // No patch yet: discover a NameError repair candidate.
    // ========================================================

    else if (
      hasRealPytestFailure(
        latestTestEvidence
      )
    ) {
      const symbol =
        extractNameErrorSymbol(
          latestTestEvidence
        );

      if (
        symbol
      ) {
        const allFailureFiles =
          extractFailureProjectFiles(
            latestTestEvidence
          );

        const nameErrorFile =
          extractNameErrorFailureFile(
            latestTestEvidence,
            symbol
          );

        // Never use the first arbitrary failing file.
        // No exact NameError binding = no V4 patch candidate.
        const failureFiles =
          nameErrorFile
            ? [
                nameErrorFile
              ]
            : [];

        console.log(
          `[FIX_V4_TARGET]` +
          ` symbol=${symbol}` +
          ` target=${
            nameErrorFile
              ? path.relative(
                  WORKSPACE_ROOT,
                  nameErrorFile
                )
              : "unknown"
          }` +
          ` all_failures=${allFailureFiles
            .map(file =>
              path.relative(
                WORKSPACE_ROOT,
                file
              )
            )
            .join(",")}`
        );

        const failureFilesInspected =
          failureFiles.length === 1 &&
          countReadCallsForPath(
            messages,
            failureFiles[0]
          ) > 0;

        const searchArgs = {
          queries: [
            symbol
          ]
        };

        const searchDone =
          executed.has(
            toolSignature(
              "search_codebase",
              searchArgs
            )
          );

        if (
          failureFilesInspected &&
          !searchDone
        ) {
          console.log(
            `[FIX_V4_DISCOVERY] name_error_symbol=${symbol}`
          );

          actions.push({
            id:
              "search_nameerror_symbol",

            tool:
              "search_codebase",

            args:
              searchArgs,

            criterion:
              `A verified NameError references ${symbol}. Search the actual project for definitions/usages of this exact symbol before proposing a repair.`
          });
        }
        else if (
          searchDone
        ) {
          const discovered =
            [
              ...new Set([
                ...discoveredFilesFromEvidence(
                  messages
                ),
                ...searchCodebaseResultFiles(
                  messages
                )
              ])
            ]
              .filter(
                file =>
                  /\.py$/i.test(
                    file
                  )
              )
              .sort(
                (a, b) =>
                  a.localeCompare(
                    b
                  )
              )
              .slice(
                0,
                8
              );

          console.log(
            `[FIX_V4_DISCOVERED] files=${discovered.length}` +
            (
              discovered.length
                ? ` names=${discovered
                    .map(file =>
                      path.relative(
                        WORKSPACE_ROOT,
                        file
                      )
                    )
                    .join(",")}`
                : ""
            )
          );

          const unreadSources =
            discovered.filter(
              file =>
                !failureFiles.some(
                  failureFile =>
                    path
                      .normalize(
                        failureFile
                      )
                      .toLowerCase() ===
                    path
                      .normalize(
                        file
                      )
                      .toLowerCase()
                ) &&
                countReadCallsForPath(
                  messages,
                  file
                ) === 0
            );

          if (
            unreadSources.length > 0
          ) {
            unreadSources
              .slice(
                0,
                6
              )
              .forEach(
                (file, index) => {
                  actions.push({
                    id:
                      `inspect_symbol_source_${index + 1}`,

                    tool:
                      "read_files",

                    args: {
                      files: [
                        {
                          path:
                            file,

                          start_line:
                            1,

                          end_line:
                            300
                        }
                      ]
                    },

                    criterion:
                      `Inspect ${path.relative(
                        WORKSPACE_ROOT,
                        file
                      )} because symbol search evidence referenced it while resolving NameError ${symbol}.`
                  });
                }
              );
          }
          else {
            const candidates =
              buildLocalImportCandidates(
                messages,
                symbol,
                failureFiles,
                discovered
              );

            console.log(
              `[FIX_V4_CANDIDATES]` +
              ` symbol=${symbol}` +
              ` count=${candidates.length}` +
              (
                candidates.length
                  ? ` modules=${candidates
                      .map(
                        candidate =>
                          candidate.moduleName
                      )
                      .join(",")}`
                  : ""
              )
            );

            candidates
              .slice(
                0,
                6
              )
              .forEach(
                (candidate, index) => {
                  const editorArgs = {
                    path:
                      candidate.path,

                    old_text:
                      candidate.oldText,

                    new_text:
                      candidate.newText
                  };

                  if (
                    !executed.has(
                      toolSignature(
                        "editor",
                        editorArgs
                      )
                    )
                  ) {
                    actions.push({
                      id:
                        `apply_v4_candidate_${index + 1}`,

                      tool:
                        "editor",

                      args:
                        editorArgs,

                      criterion:
                        `Repair NameError ${symbol} by importing the symbol from verified definition module ${candidate.moduleName}. The source file was inspected and contains an actual definition of ${symbol}.`
                    });
                  }
                }
              );
          }
        }
      }
    }
  }
  // ----------------------------------------------------------
  // FIX_FAILURE V3 TRANSACTIONAL PATCH
  //
  // Controlled first implementation:
  // test_jev_failure_probe.py only.
  //
  // failure
  // -> read
  // -> Jev selects patch action
  // -> pytest
  // -> success OR rollback
  // ----------------------------------------------------------

  if (
    wantsTransactionalAutoFix(
      userText
    ) &&
    testRepairRequest &&
    hasEditor &&
    hasReadFiles &&
    hasRunCommands
  ) {
    const spec =
      controlledProbeRepairSpec();

    const patchArgs = {
      path:
        spec.path,

      old_text:
        spec.oldText,

      new_text:
        spec.newText
    };

    const rollbackArgs = {
      path:
        spec.path,

      old_text:
        spec.newText,

      new_text:
        spec.oldText
    };

    const patchDone =
      wasToolCallExecuted(
        messages,
        "editor",
        patchArgs
      );

    const rollbackDone =
      wasToolCallExecuted(
        messages,
        "editor",
        rollbackArgs
      );

    const testCommand =
      "python -m pytest -q";

    const testRunCount =
      countRunCommandCalls(
        messages,
        testCommand
      );

    const latestTestRaw =
      latestToolResultForRunCommand(
        messages,
        testCommand
      );

    const latestTestEvidence =
      normalizeCommandEvidence(
        latestTestRaw
      );

    const failureFiles =
      extractFailureProjectFiles(
        latestTestEvidence
      );

    const probeReferenced =
      failureFiles.some(
        file =>
          path
            .normalize(
              file
            )
            .toLowerCase() ===
          path
            .normalize(
              spec.path
            )
            .toLowerCase()
      );

    const latestProbeReadRaw =
      latestToolResultForReadPath(
        messages,
        spec.path
      );

    const latestProbeRead =
      normalizeReadEvidence(
        latestProbeReadRaw
      );

    const oldTextVerified =
      latestProbeRead.includes(
        spec.oldText
      );

    // --------------------------------------------------------
    // Initial failure has been inspected.
    // Offer one concrete repair candidate to Jev.
    // --------------------------------------------------------

    if (
      !patchDone &&
      probeReferenced &&
      oldTextVerified
    ) {
      console.log(
        "[FIX_V3_PRECHECK]" +
        " probe_referenced=true" +
        " old_text_verified=true"
      );

      actions.push({
        id:
          "apply_probe_repair",

        tool:
          "editor",

        args:
          patchArgs,

        criterion:
          "Apply the controlled repair candidate to the disposable failure probe. The failing file and exact old text were both verified from real evidence."
      });
    }

    // --------------------------------------------------------
    // Patch was applied. Re-run complete pytest suite.
    // --------------------------------------------------------

    else if (
      patchDone &&
      !rollbackDone &&
      testRunCount < 2
    ) {
      actions.push({
        id:
          "rerun_tests_after_probe_patch",

        tool:
          "run_commands",

        args: {
          commands: [
            testCommand
          ]
        },

        criterion:
          "The controlled patch was applied. Re-run the complete pytest suite to verify whether the repair actually works."
      });
    }

    // --------------------------------------------------------
    // Second pytest run still failed -> rollback.
    // --------------------------------------------------------

    else if (
      patchDone &&
      !rollbackDone &&
      testRunCount >= 2 &&
      !pytestPassed(
        latestTestEvidence
      )
    ) {
      console.log(
        "[FIX_V3_DECISION]" +
        " patched=true" +
        " tests_passed=false" +
        " action=rollback"
      );

      actions.push({
        id:
          "rollback_probe_repair",

        tool:
          "editor",

        args:
          rollbackArgs,

        criterion:
          "The verification pytest run did not pass. Roll back the exact controlled patch so the workspace is restored."
      });
    }

    // --------------------------------------------------------
    // Verify rollback by re-reading the file.
    // --------------------------------------------------------

    else if (
      rollbackDone
    ) {
      const readCount =
        countReadCallsForPath(
          messages,
          spec.path
        );

      if (
        readCount < 2
      ) {
        actions.push({
          id:
            "verify_probe_rollback",

          tool:
            "read_files",

          args: {
            files: [
              {
                path:
                  spec.path,

                start_line:
                  1,

                end_line:
                  200
              }
            ]
          },

          criterion:
            "The candidate patch was rolled back. Re-read the probe file and verify the original text was restored."
        });
      }
    }
  }
  // ----------------------------------------------------------
  // FIX_FAILURE V2
  // Discover and inspect project files directly implicated
  // by a real pytest failure.
  // ----------------------------------------------------------

  if (
    testRepairRequest &&
    hasReadFiles
  ) {
    const latestFailureRaw =
      latestToolResultForRunCommand(
        messages,
        "python -m pytest -q"
      );

    const latestFailureEvidence =
      normalizeCommandEvidence(
        latestFailureRaw
      );

    if (
      hasRealPytestFailure(
        latestFailureEvidence
      )
    ) {
      const failureFiles =
        extractFailureProjectFiles(
          latestFailureEvidence
        );

      console.log(
        `[FAILURE_DISCOVERY] files=${failureFiles.length}` +
        (
          failureFiles.length
            ? ` names=${failureFiles
                .map(file =>
                  path.relative(
                    WORKSPACE_ROOT,
                    file
                  )
                )
                .join(",")}`
            : ""
        )
      );

      failureFiles.forEach(
        (file, index) => {
          const readArgs = {
            files: [
              {
                path:
                  file,

                start_line:
                  1,

                end_line:
                  300
              }
            ]
          };

          const signature =
            toolSignature(
              "read_files",
              readArgs
            );

          if (
            !executed.has(
              signature
            )
          ) {
            actions.push({
              id:
                `inspect_failure_${index + 1}`,

              tool:
                "read_files",

              args:
                readArgs,

              criterion:
                `Read ${path.relative(
                  WORKSPACE_ROOT,
                  file
                )} because the actual pytest failure/traceback directly references this project file. Diagnose only; do not modify it yet.`
            });
          }
        }
      );
    }
  }
  // ----------------------------------------------------------
  // INSERT CODE / TEXT
  //
  // read target
  // -> verify anchor occurs exactly once
  // -> exact editor replacement
  // -> read again
  // -> deterministic verification
  // ----------------------------------------------------------

  if (
    insertRequest &&
    hasReadFiles &&
    hasEditor
  ) {
    const readArgs = {
      files: [
        {
          path:
            insertRequest.path,

          start_line:
            1,

          end_line:
            200
        }
      ]
    };

    const replacementText =
      insertRequest.direction ===
      "after"
        ? (
            insertRequest.anchor +
            "\n" +
            insertRequest.content
          )
        : (
            insertRequest.content +
            "\n" +
            insertRequest.anchor
          );

    const editorArgs = {
      path:
        insertRequest.path,

      old_text:
        insertRequest.anchor,

      new_text:
        replacementText
    };

    const readDone =
      executed.has(
        toolSignature(
          "read_files",
          readArgs
        )
      );

    const editDone =
      executed.has(
        toolSignature(
          "editor",
          editorArgs
        )
      );

    if (
      !readDone
    ) {
      actions.push({
        id:
          "read_before_insert",

        tool:
          "read_files",

        args:
          readArgs,

        criterion:
          `Read ${insertRequest.path} before inserting anything. The exact anchor must first be verified in actual file evidence.`
      });
    }
    else if (
      !editDone
    ) {
      const evidence =
        currentToolResults(
          messages
        )
          .map(
            evidenceResultText
          )
          .join(
            "\n"
          );

      const anchorCount =
        countOccurrences(
          evidence,
          insertRequest.anchor
        );

      const contentAlreadyPresent =
        evidence.includes(
          insertRequest.content
        );

      console.log(
        `[INSERT_PRECHECK]` +
        ` anchor_count=${anchorCount}` +
        ` content_present=${contentAlreadyPresent}`
      );

      if (
        anchorCount === 1 &&
        !contentAlreadyPresent
      ) {
        actions.push({
          id:
            "apply_insert",

          tool:
            "editor",

          args:
            editorArgs,

          criterion:
            `Insert the exact user-supplied content ${insertRequest.direction} the verified unique anchor in ${insertRequest.path}.`
        });
      }
    }
    else {
      const readCount =
        countReadCallsForPath(
          messages,
          insertRequest.path
        );

      if (
        readCount < 2
      ) {
        actions.push({
          id:
            "verify_insert",

          tool:
            "read_files",

          args:
            readArgs,

          criterion:
            `Re-read ${insertRequest.path} after insertion and verify the inserted content is actually present.`
        });
      }
    }
  }
  // ----------------------------------------------------------
  // CREATE FILE
  //
  // Sequence:
  // check existence
  // -> create only if missing
  // -> read back
  // -> deterministic verification
  // ----------------------------------------------------------

  if (
    createRequest &&
    hasRunCommands &&
    hasEditor &&
    hasReadFiles
  ) {
    const escapedPath =
      createRequest.path.replace(
        /'/g,
        "''"
      );

    const checkArgs = {
      commands: [
        `if (Test-Path -LiteralPath '${escapedPath}') { 'JEV_FILE_EXISTS' } else { 'JEV_FILE_MISSING' }`
      ]
    };

    const createArgs = {
      path:
        createRequest.path,

      new_text:
        createRequest.content
    };

    const verifyArgs = {
      files: [
        {
          path:
            createRequest.path,

          start_line:
            1,

          end_line:
            200
        }
      ]
    };

    const checkDone =
      executed.has(
        toolSignature(
          "run_commands",
          checkArgs
        )
      );

    const createDone =
      executed.has(
        toolSignature(
          "editor",
          createArgs
        )
      );

    const verifyDone =
      executed.has(
        toolSignature(
          "read_files",
          verifyArgs
        )
      );

    const evidence =
      currentToolResults(
        messages
      )
        .map(
          evidenceResultText
        )
        .join(
          "\n"
        );

    if (
      !checkDone
    ) {
      actions.push({
        id:
          "check_create_target",

        tool:
          "run_commands",

        args:
          checkArgs,

        criterion:
          `Check whether ${createRequest.path} already exists before creating it. Do not overwrite an existing file.`
      });
    }
    else if (
      evidence.includes(
        "JEV_FILE_MISSING"
      ) &&
      !createDone
    ) {
      actions.push({
        id:
          "create_file",

        tool:
          "editor",

        args:
          createArgs,

        criterion:
          `Create the missing file ${createRequest.path} using exactly the content supplied by the user.`
      });
    }
    else if (
      createDone &&
      !verifyDone
    ) {
      actions.push({
        id:
          "verify_created_file",

        tool:
          "read_files",

        args:
          verifyArgs,

        criterion:
          `Read ${createRequest.path} after creation and verify the actual stored content.`
      });
    }
  }
  // ----------------------------------------------------------
  // EXACT REPLACE
  //
  // Safety:
  // - exactly one target file
  // - exact old_text/new_text supplied by user
  // - file must be read before edit
  // - edit result must be verified by reading again
  // ----------------------------------------------------------

  if (
    exactReplace &&
    hasReadFiles
  ) {
    const readArgs = {
      files: [
        {
          path:
            exactReplace.path,

          start_line:
            1,

          end_line:
            200
        }
      ]
    };

    const readSignature =
      toolSignature(
        "read_files",
        readArgs
      );

    const editorArgs = {
      path:
        exactReplace.path,

      old_text:
        exactReplace.oldText,

      new_text:
        exactReplace.newText
    };

    const editSignature =
      toolSignature(
        "editor",
        editorArgs
      );

    const readDone =
      executed.has(
        readSignature
      );

    const editDone =
      executed.has(
        editSignature
      );

    if (
      !readDone
    ) {
      actions.push({
        id:
          "read_before_edit",

        tool:
          "read_files",

        args:
          readArgs,

        criterion:
          `Read ${exactReplace.path} before editing it. ` +
          `The requested exact replacement must be verified against real file contents first.`
      });
    }
    else if (
      !editDone &&
      hasEditor
    ) {
      const evidence =
        currentToolResults(
          messages
        )
          .map(
            normalizeReadEvidence
          )
          .join(
            "\n"
          );

      const oldTextVerified =
        evidence.includes(
          exactReplace.oldText
        );

      console.log(
        `[EDIT_PRECHECK] old_text_verified=${oldTextVerified}`
      );

      if (
        oldTextVerified
      ) {
        actions.push({
          id:
            "apply_exact_replace",

          tool:
            "editor",

          args:
            editorArgs,

          criterion:
            `Apply the user's exact requested replacement in ${exactReplace.path}. ` +
            `The old text was verified in actual file evidence.`
        });
      }
    }
    else if (
      editDone
    ) {
      const verifyArgs = {
        files: [
          {
            path:
              exactReplace.path,

            start_line:
              1,

            end_line:
              200
          }
        ]
      };

      const toolCalls =
        messages.filter(
          m =>
            m?.role === "assistant" &&
            Array.isArray(
              m.tool_calls
            )
        );

      const readCount =
        toolCalls
          .flatMap(
            m =>
              m.tool_calls
          )
          .filter(
            tc =>
              tc?.function?.name ===
              "read_files"
          )
          .length;

      if (
        readCount < 2
      ) {
        actions.push({
          id:
            "verify_exact_replace",

          tool:
            "read_files",

          args:
            verifyArgs,

          criterion:
            `Re-read ${exactReplace.path} after the edit and verify the requested new text is actually present.`
        });
      }
    }
  }
  // ----------------------------------------------------------
  // LIST_TREE candidate
  // ----------------------------------------------------------

  if (
    hasRunCommands &&
    (
      !testRequest &&
      (
        wantsFileTree(userText) ||
        wantsArchitectureDiscovery(userText)
      )
    )
  ) {
    const treeTarget =
      treeTargetFromText(
        userText
      );

    if (treeTarget) {
      const escapedTarget =
        treeTarget.replace(
          /"/g,
          '""'
        );

      const command =
        `Get-ChildItem -LiteralPath "${escapedTarget}" -Recurse -File ` +
        `| Where-Object { $_.FullName -notlike '*\\.venv\\*' -and $_.FullName -notlike '*\\.git\\*' -and $_.FullName -notlike '*\\__pycache__\\*' -and $_.FullName -notlike '*\\.pytest_cache\\*' } ` +
        `| Sort-Object FullName ` +
        `| ForEach-Object { $_.FullName }`;

      const args = {
        commands: [
          command
        ]
      };

      const signature =
        toolSignature(
          "run_commands",
          args
        );

      if (
        !executed.has(
          signature
        )
      ) {
        actions.push({
          id:
            "list_tree",

          tool:
            "run_commands",

          args,

          criterion:
            `List the actual file tree under ${treeTarget}. ` +
            `Choose this when the user asked to discover the real project or app file structure.`
        });
      }
    }
  }
  // ----------------------------------------------------------
  // DISCOVERED FILE READ candidates
  // Tree/search evidence can create new read actions.
  // ----------------------------------------------------------

  if (
    hasReadFiles &&
    wantsDiscoveredFileInspection(
      userText
    )
  ) {
    const discovered =
      discoveredFilesFromEvidence(
        messages
      );

    discovered
      .filter(file =>
        /\.(py|js|ts|mjs|cjs|json|toml|yaml|yml)$/i
          .test(file)
      )
      .slice(0, 12)
      .forEach(
        (
          file,
          index
        ) => {
          const args = {
            files: [
              {
                path:
                  file,

                start_line:
                  1,

                end_line:
                  200
              }
            ]
          };

          const signature =
            toolSignature(
              "read_files",
              args
            );

          if (
            executed.has(
              signature
            )
          ) {
            return;
          }

          const relative =
            path.relative(
              WORKSPACE_ROOT,
              file
            );

          actions.push({
            id:
              `inspect_discovered_${index + 1}`,

            tool:
              "read_files",

            args,

            criterion:
              `Inspect discovered project file ${relative}. ` +
              `Choose this when its actual contents are relevant to the user's requested codebase inspection and have not been read yet.`
          });
        }
      );
  }
  // ----------------------------------------------------------
  // READ_FILE candidates
  // ----------------------------------------------------------

  if (
    hasReadFiles &&
    !exactReplace &&
    !createRequest &&
    !insertRequest &&
    !testRequest
  ) {
    files.forEach(
      (
        file,
        index
      ) => {
        const args = {
          files: [
            {
              path:
                file,

              start_line:
                1,

              end_line:
                200
            }
          ]
        };

        const signature =
          toolSignature(
            "read_files",
            args
          );

        if (
          executed.has(
            signature
          )
        ) {
          return;
        }

        actions.push({
          id:
            `read_file_${index + 1}`,

          tool:
            "read_files",

          args,

          criterion:
            `Read explicitly requested file ${file}. Choose this when its actual contents are still needed.`
        });
      }
    );
  }

  // ----------------------------------------------------------
  // AUTOMATIC ARCHITECTURE DISCOVERY SEARCH
  // ----------------------------------------------------------

  if (
    hasSearch &&
    wantsArchitectureDiscovery(
      userText
    )
  ) {
    const discoveryQueries =
      architectureQueries(
        userText
      );

    if (
      discoveryQueries.length > 0
    ) {
      const args = {
        queries:
          discoveryQueries
      };

      const signature =
        toolSignature(
          "search_codebase",
          args
        );

      if (
        !executed.has(
          signature
        )
      ) {
        actions.push({
          id:
            "discover_architecture",

          tool:
            "search_codebase",

          args,

        criterion:
            "Search the actual codebase for generic project-structure and runtime signals. Use only discovered evidence before making conclusions."
        });
      }
    }
  }
  // ----------------------------------------------------------
  // SEARCH_CODEBASE candidates
  // ----------------------------------------------------------

  if (
    hasSearch &&
    !exactReplace &&
    !createRequest &&
    !insertRequest &&
    !testRequest
  ) {
    searchTerms.forEach(
      (
        term,
        index
      ) => {
        const args = {
          queries: [
            escapeRegex(
              term
            )
          ]
        };

        const signature =
          toolSignature(
            "search_codebase",
            args
          );

        if (
          executed.has(
            signature
          )
        ) {
          return;
        }

        actions.push({
          id:
            `search_code_${index + 1}`,

          tool:
            "search_codebase",

          args,

          criterion:
            `Search the codebase for the explicitly requested term "${term}". Choose this when its real occurrences are still unknown.`
        });
      }
    );
  }

  return actions;
}

// ============================================================
// MAIN AGENT LOOP
// ============================================================

async function handleChat(
  req,
  res,
  body
) {
  const messages =
    Array.isArray(
      body.messages
    )
      ? body.messages
      : [];

  const userIndex =
    latestUserIndex(
      messages
    );

  const user =
    userIndex >= 0
      ? messages[userIndex]
      : null;

  const userText =
    textOf(
      user?.content || ""
    );

  const lastMessage =
    messages.length > 0
      ? messages[
          messages.length - 1
        ]
      : null;

  const phase =
    lastMessage?.role === "tool"
      ? "evaluate"
      : "route";

  const toolResults =
    currentToolResults(
      messages
    );

  console.log("");
  console.log(
    `[CLINE] phase=${phase}` +
    ` messages=${messages.length}` +
    ` tools=${Array.isArray(body.tools) ? body.tools.length : 0}`
  );

  console.log(
    `[USER] ${userText.slice(0,500)}`
  );

  const actions =
    buildActions(
      body,
      userText,
      messages
    );

  console.log(
    `[ACTIONS] pending=${actions.length}` +
    (
      actions.length
        ? ` names=${actions.map(a => a.id).join(",")}`
        : ""
    )
  );

  // ==========================================================
  // PENDING TOOL ACTIONS EXIST
  // ==========================================================

  if (
    actions.length > 0
  ) {
    // Pending concrete actions exist.
    // Jev MUST choose one of them; asking the user is not allowed here.
    const jevActions = [
      ...actions
    ];

    const decision =
      await askJev(
        {
          phase,

          user_goal:
            userText,

          workspace_root:
            WORKSPACE_ROOT,

          completed_tool_calls:
            [...executedToolSignatures(messages)],

          current_tool_results:
            toolResults.slice(-3),

          discovered_files:
            discoveredFilesFromEvidence(
              messages
            ).map(file =>
              path.relative(
                WORKSPACE_ROOT,
                file
              )
            ),

          pending_actions:
            actions.map(
              action => ({
                id:
                  action.id,

                tool:
                  action.tool,

                target:
                  action?.args?.files?.[0]?.path ||
                  action?.args?.queries?.[0] ||
                  action?.args?.commands?.[0] ||
                  null
              })
            )
        },

        jevActions
      );

    let selected =
      actions.find(
        action =>
          action.id ===
          decision.choice
      );

    if (!selected) {
      selected =
        actions[0];

      console.log(
        `[JEV_FALLBACK] invalid_choice=${decision.choice}` +
        ` fallback=${selected?.id || "none"}`
      );
    }

    if (selected) {
      console.log(
        `[ACTION] ${selected.tool}` +
        ` ${JSON.stringify(selected.args)}`
      );

      return sendResponse(
        res,
        200,
        toolCallResponse(
          selected.tool,
          selected.args
        )
      );
    }

    throw new Error(
      "Pending safe actions exist but no action could be selected."
    );
  }

  // ==========================================================
  // FIX_FAILURE V4 FINAL TRANSACTION RESULT
  // ==========================================================

  if (
    wantsTransactionalAutoFix(
      userText
    ) &&
    actions.length === 0
  ) {
    const appliedRepair =
      findAppliedLocalImportRepair(
        messages
      );

    if (
      appliedRepair
    ) {
      const rollbackArgs = {
        path:
          appliedRepair.path,

        old_text:
          appliedRepair.newText,

        new_text:
          appliedRepair.oldText
      };

      const rollbackDone =
        wasToolCallExecuted(
          messages,
          "editor",
          rollbackArgs
        );

      const testRunCount =
        countRunCommandCalls(
          messages,
          "python -m pytest -q"
        );

      const latestTestRaw =
        latestToolResultForRunCommand(
          messages,
          "python -m pytest -q"
        );

      const latestTestEvidence =
        normalizeCommandEvidence(
          latestTestRaw
        );

      if (
        !rollbackDone &&
        testRunCount >= 2 &&
        pytestPassed(
          latestTestEvidence
        )
      ) {
        console.log(
          "[FIX_V4]" +
          " success=true" +
          " rollback=false" +
          ` symbol=${appliedRepair.symbol}` +
          ` module=${appliedRepair.moduleName}`
        );

        return sendResponse(
          res,
          200,
          textResponse(
            `FIX_FAILURE V4 başarılı: ${appliedRepair.symbol} için ${appliedRepair.moduleName} modülünden doğrulanmış import patch'i uygulandı ve tüm pytest testleri geçti.`
          )
        );
      }

      if (
        rollbackDone
      ) {
        const latestReadRaw =
          latestToolResultForReadPath(
            messages,
            appliedRepair.path
          );

        const latestRead =
          normalizeReadEvidence(
            latestReadRaw
          );

        const restored =
          !latestRead.includes(
            appliedRepair.importLine
          ) &&
          latestRead.includes(
            appliedRepair.oldText
          );

        console.log(
          `[FIX_V4]` +
          ` success=false` +
          ` rollback=true` +
          ` restored=${restored}`
        );

        return sendResponse(
          res,
          200,
          textResponse(
            restored
              ? "FIX_FAILURE V4 patch'i tüm testleri geçemedi; değişiklik geri alındı ve dosyanın eski hali doğrulandı."
              : "FIX_FAILURE V4 rollback çağrıldı ancak dosyanın eski hali tekrar okumada doğrulanamadı."
          )
        );
      }
    }
  }
  // ==========================================================
  // FIX_FAILURE V3 FINAL TRANSACTION RESULT
  // ==========================================================

  if (
    wantsTransactionalAutoFix(
      userText
    ) &&
    actions.length === 0
  ) {
    const spec =
      controlledProbeRepairSpec();

    const patchArgs = {
      path:
        spec.path,

      old_text:
        spec.oldText,

      new_text:
        spec.newText
    };

    const rollbackArgs = {
      path:
        spec.path,

      old_text:
        spec.newText,

      new_text:
        spec.oldText
    };

    const patchDone =
      wasToolCallExecuted(
        messages,
        "editor",
        patchArgs
      );

    const rollbackDone =
      wasToolCallExecuted(
        messages,
        "editor",
        rollbackArgs
      );

    const testRunCount =
      countRunCommandCalls(
        messages,
        "python -m pytest -q"
      );

    const latestTestRaw =
      latestToolResultForRunCommand(
        messages,
        "python -m pytest -q"
      );

    const latestTestEvidence =
      normalizeCommandEvidence(
        latestTestRaw
      );

    if (
      patchDone &&
      !rollbackDone &&
      testRunCount >= 2 &&
      pytestPassed(
        latestTestEvidence
      )
    ) {
      console.log(
        "[FIX_V3]" +
        " success=true" +
        " rollback=false"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          "FIX_FAILURE V3 başarılı: kontrollü patch uygulandı ve pytest doğrulamasından geçti."
        )
      );
    }

    if (
      rollbackDone
    ) {
      const latestReadRaw =
        latestToolResultForReadPath(
          messages,
          spec.path
        );

      const latestRead =
        normalizeReadEvidence(
          latestReadRaw
        );

      const restored =
        latestRead.includes(
          spec.oldText
        );

      console.log(
        `[FIX_V3] success=false rollback=true restored=${restored}`
      );

      return sendResponse(
        res,
        200,
        textResponse(
          restored
            ? "Patch testleri geçemedi; değişiklik otomatik olarak geri alındı ve dosya doğrulandı."
            : "Patch testleri geçemedi; rollback çağrıldı ancak dosyanın eski hali tekrar okumada doğrulanamadı."
        )
      );
    }
  }
  // ==========================================================
  // FIX_FAILURE V2 FINAL DIAGNOSIS
  // ==========================================================

  if (
    wantsTestRepair(
      userText
    ) &&
    actions.length === 0
  ) {
    const latestFailureRaw =
      latestToolResultForRunCommand(
        messages,
        "python -m pytest -q"
      );

    const latestFailureEvidence =
      normalizeCommandEvidence(
        latestFailureRaw
      );

    if (
      hasRealPytestFailure(
        latestFailureEvidence
      )
    ) {
      const candidateFiles =
        extractFailureProjectFiles(
          latestFailureEvidence
        );

      const inspectedEvidence =
        toolResults
          .map(
            evidenceResultText
          )
          .join(
            "\n\n"
          );

      const diagnosis =
        await askJevTestFailureDiagnosis(
          userText,
          latestFailureEvidence,
          inspectedEvidence,
          candidateFiles
        );

      const classLabels = {
        assertion_failure:
          "Assertion failure",
        import_error:
          "Import/module hatası",
        syntax_error:
          "Syntax/indentation hatası",
        name_error:
          "NameError",
        attribute_error:
          "AttributeError",
        type_error:
          "TypeError",
        value_error:
          "ValueError",
        runtime_error:
          "Runtime exception",
        unknown:
          "Belirlenemedi"
      };

      const scopeLabels = {
        test_code:
          "Test kodu",
        application_code:
          "Uygulama kaynak kodu",
        dependency_environment:
          "Bağımlılık / çalışma ortamı",
        unknown:
          "Belirlenemedi"
      };

      const report = [
        "Test başarısızlığı doğrulandı.",
        "",
        `- Hata sınıfı: ${classLabels[
          diagnosis.failure_class
        ] || diagnosis.failure_class}`,
        `- Hata kapsamı: ${scopeLabels[
          diagnosis.fault_scope
        ] || diagnosis.fault_scope}`,
        `- En ilgili dosya: ${diagnosis.target_file}`,
        "",
        "FIX_FAILURE V2 yalnız teşhis yaptı; proje dosyaları değiştirilmedi."
      ].join(
        "\n"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          report
        )
      );
    }
  }
  // ==========================================================
  // TEST FINAL VERIFICATION
  // ==========================================================

  if (
    wantsTests(
      userText
    ) &&
    actions.length === 0 &&
    toolResults.length > 0
  ) {
    const latestPytestRaw =
      latestToolResultForRunCommand(
        messages,
        "python -m pytest -q"
      );

    const evidence =
      normalizeCommandEvidence(
        latestPytestRaw
      );

    const clean =
      evidence
        .replace(
          /\x1b\[[0-9;]*m/g,
          ""
        )
        .replace(
          /\r/g,
          ""
        );

    console.log(
      "[TEST_EVIDENCE]"
    );

    console.log(
      clean.slice(
        0,
        4000
      )
    );

    const runnerMissing =
      /No module named pytest/i.test(clean) ||
      /ModuleNotFoundError:\s*No module named ['"]pytest['"]/i.test(clean) ||
      /pytest(?:\.exe)?:\s*(?:command not found|not recognized)/i.test(clean);

    const noTests =
      !runnerMissing &&
      (
        /no tests ran/i.test(clean) ||
        /no tests collected/i.test(clean) ||
        /collected\s+0\s+items/i.test(clean) ||
        /\b0\s+tests?\b/i.test(clean) ||
        /\b0\s+items?\s+collected\b/i.test(clean)
      );

    const failed =
      !runnerMissing &&
      !noTests &&
      (
        /(?:^|\s)\d+\s+failed\b/i.test(clean) ||
        /(?:^|\s)\d+\s+error(?:s)?\b/i.test(clean) ||
        /\bFAILED\b/.test(clean)
      );

    const passedMatch =
      clean.match(
        /(\d+)\s+passed\b/i
      );

    const passed =
      passedMatch
        ? Number(
            passedMatch[1]
          )
        : 0;

    const failedMatch =
      clean.match(
        /(\d+)\s+failed\b/i
      );

    const failedCount =
      failedMatch
        ? Number(
            failedMatch[1]
          )
        : 0;

    console.log(
      `[TEST_VERIFY]` +
      ` runner_missing=${runnerMissing}` +
      ` no_tests=${noTests}` +
      ` passed=${passed}` +
      ` failed=${failedCount}`
    );

    if (
      runnerMissing
    ) {
      return sendResponse(
        res,
        200,
        textResponse(
          wantsTestRepair(
            userText
          )
            ? "Test ortamı onarılmaya çalışıldı ancak aktif sanal ortamda pytest hâlâ kullanılamıyor."
            : "Testler çalıştırılamadı: mevcut proje sanal ortamında pytest kurulu değil."
        )
      );
    }

    if (
      noTests
    ) {
      return sendResponse(
        res,
        200,
        textResponse(
          "Pytest çalıştı ancak projede çalıştırılacak test bulunamadı."
        )
      );
    }

    if (
      failed
    ) {
      return sendResponse(
        res,
        200,
        textResponse(
          `Testler tamamlandı: ${passed} geçti, ${failedCount} başarısız.`
        )
      );
    }

    return sendResponse(
      res,
      200,
      textResponse(
        passed > 0
          ? `Testler başarılı: ${passed} test geçti.`
          : "Pytest tamamlandı; sonuç çıktısı alındı ancak geçme sayısı belirlenemedi."
      )
    );
  }
  // ==========================================================
  // INSERT FINAL VERIFICATION
  // ==========================================================

  const finalInsertRequest =
    extractInsertRequest(
      userText
    );

  if (
    finalInsertRequest &&
    actions.length === 0 &&
    toolResults.length > 0
  ) {
    const replacementText =
      finalInsertRequest.direction ===
      "after"
        ? (
            finalInsertRequest.anchor +
            "\n" +
            finalInsertRequest.content
          )
        : (
            finalInsertRequest.content +
            "\n" +
            finalInsertRequest.anchor
          );

    const editorArgs = {
      path:
        finalInsertRequest.path,

      old_text:
        finalInsertRequest.anchor,

      new_text:
        replacementText
    };

    const editWasExecuted =
      wasToolCallExecuted(
        messages,
        "editor",
        editorArgs
      );

    if (
      !editWasExecuted
    ) {
      const evidence =
        toolResults
          .map(
            normalizeReadEvidence
          )
          .join(
            "\n"
          );

      const contentAlreadyPresent =
        evidence.includes(
          finalInsertRequest.content
        );

      const anchorCount =
        countOccurrences(
          evidence,
          finalInsertRequest.anchor
        );

      if (
        contentAlreadyPresent
      ) {
        console.log(
          "[INSERT_VERIFY] success=true already_present=true"
        );

        return sendResponse(
          res,
          200,
          textResponse(
            `çerik zaten mevcut; tekrar eklenmedi ve doğrulandı: ${path.relative(
              WORKSPACE_ROOT,
              finalInsertRequest.path
            )}`
          )
        );
      }

      console.log(
        `[INSERT_VERIFY]` +
        ` edit=false` +
        ` anchor_count=${anchorCount}` +
        ` content_present=false`
      );

      return sendResponse(
        res,
        200,
        textResponse(
          anchorCount === 0
            ? "Ekleme yapılmadı: belirtilen anchor dosyada bulunamadı."
            : anchorCount > 1
              ? "Ekleme yapılmadı: belirtilen anchor dosyada benzersiz değil."
              : "Ekleme işlemi uygulanamadı."
        )
      );
    }

    const verifiedEvidence =
      toolResults
        .map(
          normalizeReadEvidence
        )
        .join(
          "\n"
        );

    const success =
      verifiedEvidence.includes(
        finalInsertRequest.content
      );

    console.log(
      `[INSERT_VERIFY] success=${success}`
    );

    return sendResponse(
      res,
      200,
      textResponse(
        success
          ? `çerik eklendi ve doğrulandı: ${path.relative(
              WORKSPACE_ROOT,
              finalInsertRequest.path
            )}`
          : "Ekleme işlemi yapıldı ancak yeni içerik tekrar okumada doğrulanamadı."
      )
    );
  }
  // ==========================================================
  // CREATE FILE FINAL VERIFICATION
  // ==========================================================

  const finalCreateRequest =
    extractCreateFileRequest(
      userText
    );

  if (
    finalCreateRequest &&
    actions.length === 0 &&
    toolResults.length > 0
  ) {
    const createArgs = {
      path:
        finalCreateRequest.path,

      new_text:
        finalCreateRequest.content
    };

    const createWasExecuted =
      wasToolCallExecuted(
        messages,
        "editor",
        createArgs
      );

    const evidence =
      toolResults
        .map(
          evidenceResultText
        )
        .join(
          "\n"
        );

    if (
      !createWasExecuted &&
      evidence.includes(
        "JEV_FILE_EXISTS"
      )
    ) {
      console.log(
        "[CREATE_VERIFY] exists=true created=false"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          `Dosya zaten mevcut olduğu için üzerine yazılmadı: ${path.relative(
            WORKSPACE_ROOT,
            finalCreateRequest.path
          )}`
        )
      );
    }

    if (
      !createWasExecuted
    ) {
      console.log(
        "[CREATE_VERIFY] created=false"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          "Dosya oluşturma işlemi doğrulanamadı."
        )
      );
    }

    const normalizedEvidence =
      toolResults
        .map(
          normalizeReadEvidence
        )
        .join(
          "\n"
        );

    const expected =
      finalCreateRequest.content
        .trim();

    const success =
      normalizedEvidence.includes(
        expected
      );

    console.log(
      `[CREATE_VERIFY] success=${success}`
    );

    return sendResponse(
      res,
      200,
      textResponse(
        success
          ? `Dosya oluşturuldu ve doğrulandı: ${path.relative(
              WORKSPACE_ROOT,
              finalCreateRequest.path
            )}`
          : "Dosya oluşturuldu ancak içerik tekrar okumada doğrulanamadı."
      )
    );
  }
  // ==========================================================
  // EXACT EDIT FINAL VERIFICATION
  // ==========================================================

  const finalExactReplace =
    extractExactReplaceRequest(
      userText
    );

  if (
    finalExactReplace &&
    actions.length === 0 &&
    toolResults.length > 0
  ) {
    const finalEditorArgs = {
      path:
        finalExactReplace.path,

      old_text:
        finalExactReplace.oldText,

      new_text:
        finalExactReplace.newText
    };

    const editWasExecuted =
      wasToolCallExecuted(
        messages,
        "editor",
        finalEditorArgs
      );

    if (
      !editWasExecuted
    ) {
      console.log(
        "[EDIT_VERIFY] edit_executed=false"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          "stenen eski metin dosyada doğrulanamadığı için değişiklik uygulanmadı."
        )
      );
    }

    const evidence =
      toolResults
        .map(
          normalizeReadEvidence
        )
        .join(
          "\n"
        );

    const success =
      evidence.includes(
        finalExactReplace.newText
      );

    if (
      success
    ) {
      console.log(
        "[EDIT_VERIFY] success=true"
      );

      return sendResponse(
        res,
        200,
        textResponse(
          `Değişiklik doğrulandı: ${path.relative(
            WORKSPACE_ROOT,
            finalExactReplace.path
          )}`
        )
      );
    }

    console.log(
      "[EDIT_VERIFY] success=false"
    );

    return sendResponse(
      res,
      200,
      textResponse(
        "Edit işlemi tamamlanmış görünse de yeni metin dosyada doğrulanamadı."
      )
    );
  }
  // ==========================================================
  // NO PENDING ACTIONS + WE HAVE EVIDENCE → FINISH
  // ==========================================================

  if (
    toolResults.length > 0
  ) {
    const decision =
      await askJev(
        {
          phase:
            "evaluate",

          user_goal:
            userText,

          workspace_root:
            WORKSPACE_ROOT,

          evidence:
            toolResults.slice(-5),

          pending_actions:
            []
        },

        [
          {
            id:
              "finish_report",

            criterion:
              "All currently available concrete actions have been completed and actual tool evidence exists. Finish the task now."
          }
        ]
      );

    if (
      decision.choice !==
      "finish_report"
    ) {
      console.log(
        `[JEV_FINISH_FALLBACK] invalid=${decision.choice}`
      );
    }

    console.log(
      "[ACTION] finish_report"
    );

    if (
      wantsArchitectureDiscovery(
        userText
      )
    ) {
      const discovered =
        discoveredFilesFromEvidence(
          messages
        );

      const summary =
        await askJevArchitectureSummary(
          userText,
          toolResults,
          discovered
        );

      const report =
        formatArchitectureReport(
          summary,
          discovered,
          toolResults
        );

      return sendResponse(
        res,
        200,
        textResponse(
          report
        )
      );
    }

    return sendResponse(
      res,
      200,
      textResponse(
        "Görev tamamlandı.\n\n" +
        toolResults.join(
          "\n\n"
        )
      )
    );
  }

  // ==========================================================
  // REQUEST COULD NOT YET BE PARSED
  // ==========================================================

  console.log(
    "[ACTION] unsupported_request"
  );

  return sendResponse(
    res,
    200,
    textResponse(
      "Bu Jev-native sürüm şu anda açıkça belirtilmiş dosyaları okuyabilir ve açıkça belirtilmiş kod terimlerini arayabilir. Sonraki agent primitive henüz eklenmedi."
    )
  );
}

// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "127.0.0.1"}`
          );

        if (
          req.method === "GET" &&
          url.pathname === "/health"
        ) {
          return sendResponse(
            res,
            200,
            {
              ok: true,

              service:
                "jev-cline-agent",

              mode:
                "jev-native-general-read-search",

              port:
                PORT,

              workspaceRoot:
                WORKSPACE_ROOT,

              jevConfigured:
                Boolean(JEV_KEY),

              jevCalls:
                JEV_CALLS,

              qwenEnabled:
                false,

              ollamaEnabled:
                false,

              model:
                MODEL_ID
            }
          );
        }

        if (
          req.method === "GET" &&
          url.pathname === "/v1/models"
        ) {
          return sendResponse(
            res,
            200,
            {
              object:
                "list",

              data: [
                {
                  id:
                    MODEL_ID,

                  object:
                    "model",

                  owned_by:
                    "jev-native"
                }
              ]
            }
          );
        }

        if (
          req.method === "POST" &&
          url.pathname ===
            "/v1/chat/completions"
        ) {
          const body =
            await readJson(
              req
            );

          res.__openaiStream =
            body?.stream === true;

          console.log(
            `[OPENAI] stream=${res.__openaiStream}`
          );

          return await handleChat(
            req,
            res,
            body
          );
        }

        return sendResponse(
          res,
          404,
          {
            error: {
              message:
                "Not found"
            }
          }
        );
      }
      catch (error) {
        console.error(
          "[ROUTER]",
          error?.stack ||
          error
        );

        return sendResponse(
          res,
          500,
          {
            error: {
              message:
                error?.message ||
                "Internal error"
            }
          }
        );
      }
    }
  );

server.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log("");
    console.log(
      "JEV NATIVE GENERAL AGENT"
    );

    console.log(
      `http://127.0.0.1:${PORT}`
    );

    console.log(
      `Workspace: ${WORKSPACE_ROOT}`
    );

    console.log(
      `Jev configured: ${Boolean(JEV_KEY)}`
    );

    console.log(
      "Capabilities: FIX_FAILURE_V4_CANDIDATES + RUN_TESTS + INSERT_CODE + CREATE_FILE + EXACT_REPLACE + LIST_TREE + AUTO_SEARCH_DISCOVERY + DYNAMIC_DISCOVERY + READ_FILE + SEARCH_CODEBASE"
    );

    console.log(
      "Qwen: DISABLED"
    );

    console.log(
      "Ollama: DISABLED"
    );

    console.log("");
  }
);



























