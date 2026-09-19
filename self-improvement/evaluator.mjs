import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  spawnSync
} from "node:child_process";
import {
  fileURLToPath
} from "node:url";

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

const STATE_FILE =
  path.join(
    ROOT,
    "self-improvement",
    "state.json"
  );

const SUPERVISOR =
  path.join(
    ROOT,
    "supervisor.mjs"
  );

const STABLE =
  path.join(
    ROOT,
    "runtime",
    "stable-agent.mjs"
  );

export function sha256(file) {
  return crypto
    .createHash(
      "sha256"
    )
    .update(
      fs.readFileSync(
        file
      )
    )
    .digest(
      "hex"
    );
}

function readState() {
  if (
    !fs.existsSync(
      STATE_FILE
    )
  ) {
    return {};
  }

  const raw =
    fs.readFileSync(
      STATE_FILE,
      "utf8"
    )
      .replace(
        /^\uFEFF/,
        ""
      );

  return JSON.parse(
    raw
  );
}

function checkSyntax(file) {
  const result =
    spawnSync(
      process.execPath,
      [
        "--check",
        file
      ],
      {
        encoding:
          "utf8"
      }
    );

  return {
    pass:
      result.status === 0,

    output:
      String(
        result.stderr ||
        result.stdout ||
        ""
      ).trim()
  };
}

export function evaluateCandidate(
  candidate
) {
  const checks = [];

  if (
    !fs.existsSync(
      candidate
    )
  ) {
    return {
      pass:
        false,

      checks: [
        {
          name:
            "candidate_exists",
          pass:
            false
        }
      ]
    };
  }

  const state =
    readState();

  const text =
    fs.readFileSync(
      candidate,
      "utf8"
    );

  const syntax =
    checkSyntax(
      candidate
    );

  checks.push({
    name:
      "syntax",

    pass:
      syntax.pass,

    detail:
      syntax.output
  });

  const markers = [
    "JEV_URL",
    "/v1/systemone",
    "Qwen: DISABLED",
    "Ollama: DISABLED",
    "read_files",
    "search_codebase",
    "editor",
    "run_commands"
  ];

  for (
    const marker of
    markers
  ) {
    checks.push({
      name:
        `marker:${marker}`,

      pass:
        text.includes(
          marker
        )
    });
  }

  checks.push({
    name:
      "rollback_logic",

    pass:
      /rollback/i.test(
        text
      )
  });

  checks.push({
    name:
      "ollama_endpoint_absent",

    pass:
      !/127\.0\.0\.1:11434|\/api\/generate|\/api\/chat/i
        .test(
          text
        )
  });

  if (
    state.baselineStableHash
  ) {
    checks.push({
      name:
        "stable_unchanged",

      pass:
        sha256(
          STABLE
        ) ===
        state.baselineStableHash
    });
  }

  if (
    state.baselineSupervisorHash
  ) {
    checks.push({
      name:
        "supervisor_unchanged",

      pass:
        sha256(
          SUPERVISOR
        ) ===
        state.baselineSupervisorHash
    });
  }

  return {
    pass:
      checks.every(
        check =>
          check.pass
      ),

    checks,

    candidateHash:
      sha256(
        candidate
      ),

    stableHash:
      sha256(
        STABLE
      ),

    supervisorHash:
      sha256(
        SUPERVISOR
      )
  };
}