import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateCandidate,
  normalizeRelativePath
} from "../synthesis/schema.mjs";

const BLOCKED = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "logs",
  "snapshots"
]);

const LIVE_PROTECTED = new Set([
  "supervisor.mjs",
  "runtime/stable-agent.mjs",
  "runtime/active-agent.mjs"
]);

const EXPLICIT_SECRET_ENV = new Set([
  "TYPESAFE_API_KEY",
  "JEV_SYNTH_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "HF_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "DATABASE_URL"
]);

const SECRET_NAME_PATTERN =
  /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|SESSION[_-]?TOKEN|CONNECTION[_-]?STRING|DATABASE[_-]?URL|COOKIE)/i;

function inside(root, target) {
  const r =
    path.relative(
      root,
      target
    );

  return (
    r === "" ||
    (
      !r.startsWith("..") &&
      !path.isAbsolute(r)
    )
  );
}

function realPathInside(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const rootKey = rootAbs.toLowerCase();
  const targetKey = targetAbs.toLowerCase();
  if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${path.sep}`)) {
    return false;
  }

  let nearest = targetAbs;
  while (!fs.existsSync(nearest) && path.dirname(nearest) !== nearest) {
    nearest = path.dirname(nearest);
  }

  try {
    const realRoot = fs.realpathSync.native(rootAbs).toLowerCase();
    const realNearest = fs.realpathSync.native(nearest).toLowerCase();
    return realNearest === realRoot || realNearest.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function resolveTarget(root, rel) {
  const normalized =
    normalizeRelativePath(
      rel
    );

  const absolute =
    path.resolve(
      root,
      normalized
    );

  if (
    !inside(
      root,
      absolute
    )
  ) {
    throw new Error(
      `Path escaped workspace: ${rel}`
    );
  }

  if (!realPathInside(root, absolute)) {
    throw new Error(`Path resolves outside workspace: ${rel}`);
  }

  return {
    normalized,
    absolute
  };
}

function countExact(source, needle) {
  return needle
    ? source.split(needle).length - 1
    : 0;
}

export function sanitizedValidationEnv(
  source = process.env
) {
  const env = {};
  const removed = [];

  for (
    const [
      key,
      value
    ] of Object.entries(
      source || {}
    )
  ) {
    if (
      EXPLICIT_SECRET_ENV.has(
        key
      ) ||
      SECRET_NAME_PATTERN.test(
        key
      )
    ) {
      removed.push(
        key
      );

      continue;
    }

    env[key] =
      value;
  }

  env.JEV_VALIDATION_ENV_SANITIZED =
    "1";

  env.PYTHONDONTWRITEBYTECODE =
    "1";

  return {
    env,
    removed:
      removed.sort()
  };
}

export function validationSecurityStatus(
  source = process.env
) {
  const result =
    sanitizedValidationEnv(
      source
    );

  return {
    sanitized:
      true,

    removedCount:
      result.removed.length,

    removedNames:
      result.removed,

    pathPreserved:
      typeof result.env.PATH === "string" ||
      typeof result.env.Path === "string",

    marker:
      result.env.JEV_VALIDATION_ENV_SANITIZED
  };
}

export function applyOperations(
  root,
  rawCandidate,
  {
    live = false
  } = {}
) {
  const candidate =
    validateCandidate(
      rawCandidate
    );

  const changed = [];

  for (
    const op of
    candidate.operations
  ) {
    const {
      normalized,
      absolute
    } =
      resolveTarget(
        root,
        op.path
      );

    if (
      live &&
      LIVE_PROTECTED.has(
        normalized.toLowerCase()
      )
    ) {
      throw new Error(
        `Direct live modification is forbidden: ${normalized}`
      );
    }

    fs.mkdirSync(
      path.dirname(
        absolute
      ),
      {
        recursive:
          true
      }
    );

    if (
      op.type ===
      "create_file"
    ) {
      if (
        fs.existsSync(
          absolute
        )
      ) {
        throw new Error(
          `create_file target already exists: ${normalized}`
        );
      }

      fs.writeFileSync(
        absolute,
        op.content,
        "utf8"
      );

      changed.push(
        normalized
      );

      continue;
    }

    if (
      op.type ===
      "exact_replace"
    ) {
      if (
        !fs.existsSync(
          absolute
        )
      ) {
        throw new Error(
          `exact_replace target missing: ${normalized}`
        );
      }

      const source =
        fs.readFileSync(
          absolute,
          "utf8"
        );

      const count =
        countExact(
          source,
          op.old_text
        );

      if (
        count !==
        1
      ) {
        throw new Error(
          `exact_replace expected 1 match but found ${count}: ${normalized}`
        );
      }

      fs.writeFileSync(
        absolute,
        source.replace(
          op.old_text,
          op.new_text
        ),
        "utf8"
      );

      changed.push(
        normalized
      );
    }
  }

  return {
    candidate,
    changed:
      [
        ...new Set(
          changed
        )
      ]
  };
}

function runCommand(
  cwd,
  command,
  timeoutMs = 120000,
  { allowEmpty = false } = {}
) {
  const security =
    sanitizedValidationEnv(
      process.env
    );

  const r =
    spawnSync(
      command,
      {
        cwd,
        shell:
          true,

        encoding:
          "utf8",

        timeout:
          timeoutMs,

        maxBuffer:
          10 *
          1024 *
          1024,

        windowsHide:
          true,

        env:
          security.env
      }
    );

  return {
    command,

    pass:
      r.status === 0 &&
      !r.error &&
      (allowEmpty || `${r.stdout || ""}${r.stderr || ""}`.trim().length > 0),

    status:
      r.status,

    stdout:
      String(
        r.stdout ||
        ""
      )
        .slice(
          -20000
        ),

    stderr:
      String(
        r.stderr ||
        ""
      )
        .slice(
          -20000
        ),

    error:
      r.error
        ? String(
            r.error.message ||
            r.error
          )
        : null,

    evidencePresent:
      `${r.stdout || ""}${r.stderr || ""}`.trim().length > 0,

    environment:
      {
        sanitized:
          true,

        removedCount:
          security.removed.length
      }
  };
}

function syntaxChecks(
  root,
  changed
) {
  const out = [];

  for (
    const rel of
    changed
  ) {
    const abs =
      path.join(
        root,
        rel
      );

    const ext =
      path.extname(
        rel
      )
        .toLowerCase();

    if (
      [
        ".js",
        ".mjs",
        ".cjs"
      ]
        .includes(
          ext
        )
    ) {
      out.push(
        runCommand(
          root,
          `"${process.execPath}" --check "${abs}"`,
          120000,
          { allowEmpty: true }
        )
      );
    }
    else if (
      ext ===
      ".py"
    ) {
      out.push(
        runCommand(
          root,
          `python -m py_compile "${abs}"`,
          120000,
          { allowEmpty: true }
        )
      );
    }
    else if (
      ext ===
      ".json"
    ) {
      try {
        JSON.parse(
          fs.readFileSync(
            abs,
            "utf8"
          )
            .replace(
              /^\uFEFF/,
              ""
            )
        );

        out.push({
          command:
            `JSON.parse ${rel}`,

          pass:
            true,

          status:
            0,

          stdout:
            "",

          stderr:
            "",

          error:
            null,

          environment: {
            sanitized:
              true,

            removedCount:
              validationSecurityStatus()
                .removedCount
          }
        });
      }
      catch (
        error
      ) {
        out.push({
          command:
            `JSON.parse ${rel}`,

          pass:
            false,

          status:
            1,

          stdout:
            "",

          stderr:
            String(
              error.message ||
              error
            ),

          error:
            String(
              error.message ||
              error
            ),

          environment: {
            sanitized:
              true,

            removedCount:
              validationSecurityStatus()
                .removedCount
          }
        });
      }
    }
  }

  return out;
}

function detectTests(root) {
  const commands = [];

  const pkgFile =
    path.join(
      root,
      "package.json"
    );

  if (
    fs.existsSync(
      pkgFile
    )
  ) {
    try {
      const pkg =
        JSON.parse(
          fs.readFileSync(
            pkgFile,
            "utf8"
          )
            .replace(
              /^\uFEFF/,
              ""
            )
        );

      const script =
        pkg
          ?.scripts
          ?.test;

      if (
        typeof script ===
          "string" &&
        script.trim() &&
        !/no test specified/i.test(
          script
        )
      ) {
        commands.push(
          "npm test"
        );
      }
    }
    catch {
      // ignored
    }
  }

  if (
    [
      "pytest.ini",
      "pyproject.toml",
      "setup.cfg",
      "tests"
    ]
      .some(
        name =>
          fs.existsSync(
            path.join(
              root,
              name
            )
          )
      ) ||
    fs.readdirSync(
      root,
      {
        withFileTypes:
          true
      }
    )
      .some(
        entry =>
          entry.isFile() &&
          /^test_.*\.py$/i.test(
            entry.name
          )
      )
  ) {
    commands.push(
      "python -m pytest -q -p no:cacheprovider"
    );
  }

  if (
    fs.existsSync(
      path.join(
        root,
        "gradlew.bat"
      )
    )
  ) {
    commands.push(
      "gradlew.bat test"
    );
  }
  else if (
    fs.existsSync(
      path.join(
        root,
        "gradlew"
      )
    )
  ) {
    commands.push(
      "./gradlew test"
    );
  }

  return commands;
}

function combinedOutput(result) {
  return [
    result?.stdout || "",
    result?.stderr || ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function pytestFailureIds(
  result
) {
  const text =
    combinedOutput(
      result
    );

  const ids = [];

  for (
    const line of
    text.split(
      /\r?\n/
    )
  ) {
    const match =
      line.match(
        /^FAILED\s+([^\s]+)(?:\s+-\s+.*)?$/
      );

    if (
      match
    ) {
      ids.push(
        match[1]
      );
    }
  }

  return [
    ...new Set(
      ids
    )
  ]
    .sort();
}

function isPytestCommand(command) {
  return /\bpytest\b/i.test(
    String(command || "")
  );
}

export function compareProjectTestResults(
  after,
  baseline
) {
  if (
    !baseline
  ) {
    return {
      ...after,

      baselineAware:
        false,

      regressionPass:
        after.pass,

      pass:
        after.pass
    };
  }

  if (
    baseline.pass
  ) {
    return {
      ...after,

      baselineAware:
        true,

      baselinePassed:
        true,

      regressionPass:
        after.pass,

      pass:
        after.pass
    };
  }

  if (
    isPytestCommand(
      after.command
    ) &&
    isPytestCommand(
      baseline.command
    )
  ) {
    const baselineFailures =
      pytestFailureIds(
        baseline
      );

    const currentFailures =
      pytestFailureIds(
        after
      );

    if (
      baselineFailures.length >
        0
    ) {
      const baselineSet =
        new Set(
          baselineFailures
        );

      const currentSet =
        new Set(
          currentFailures
        );

      const newFailures =
        currentFailures.filter(
          id =>
            !baselineSet.has(
              id
            )
        );

      const resolvedFailures =
        baselineFailures.filter(
          id =>
            !currentSet.has(
              id
            )
        );

      const regressionPass =
        newFailures.length ===
        0;

      return {
        ...after,

        baselineAware:
          true,

        baselinePassed:
          false,

        baselineFailures,

        currentFailures,

        newFailures,

        resolvedFailures,

        regressionPass,

        pass:
          regressionPass
      };
    }
  }

  // Conservative fallback for non-pytest failing baselines:
  // an unparseable pre-existing failure never excuses a new failure.
  return {
    ...after,

    baselineAware:
      true,

    baselinePassed:
      false,

    regressionPass:
      after.pass,

    pass:
      after.pass
  };
}

function runProjectTests(
  root,
  timeoutMs
) {
  return detectTests(
    root
  )
    .map(
      command =>
        runCommand(
          root,
          command,
          timeoutMs
        )
    );
}

function compareProjectTests(
  after,
  baseline
) {
  const baselineByCommand =
    new Map(
      (
        Array.isArray(
          baseline
        )
          ? baseline
          : []
      )
        .map(
          result => [
            result.command,
            result
          ]
        )
    );

  return after.map(
    result =>
      compareProjectTestResults(
        result,
        baselineByCommand.get(
          result.command
        )
      )
  );
}

function copyWorkspace(
  workspace,
  sandbox
) {
  fs.cpSync(
    workspace,
    sandbox,
    {
      recursive:
        true,

      force:
        true,

      filter:
        source => {
          const rel =
            path.relative(
              workspace,
              source
            );

          if (
            !rel
          ) {
            return true;
          }

          const parts =
            rel
              .split(
                path.sep
              )
              .map(
                value =>
                  value.toLowerCase()
              );

          return !parts.some(
            value =>
              BLOCKED.has(
                value
              )
          );
        }
    }
  );
}

export function runValidation(
  root,
  changed,
  {
    acceptanceCommands = [],
    autoProjectTests = true,
    timeoutMs = 120000,
    baselineProjectTests = [],
    allowSyntaxOnly = false
  } = {}
) {
  const syntax =
    syntaxChecks(
      root,
      changed
    );

  const rawProjectTests =
    autoProjectTests
      ? runProjectTests(
          root,
          timeoutMs
        )
      : [];

  const projectTests =
    compareProjectTests(
      rawProjectTests,
      baselineProjectTests
    );

  const acceptance =
    acceptanceCommands
      .map(
        command => {
          const allowEmpty = /(?:python\s+-m\s+compileall\b|node\s+--check\b|tsc\s+--noEmit\b)/i.test(command);
          return runCommand(
            root,
            command,
            timeoutMs,
            { allowEmpty }
          );
        }
      );

  const security =
    validationSecurityStatus();

  const checks = [
    ...syntax,
    ...projectTests,
    ...acceptance
  ];
  const hasSemanticCheck = projectTests.length > 0 || acceptance.length > 0;

  return {
    syntax,
    projectTests,
    acceptance,

    baseline: {
      projectTests:
        baselineProjectTests,

      aware:
        baselineProjectTests.length >
        0
    },

    security: {
      validationEnvSanitized:
        true,

      removedCount:
        security.removedCount,

      pathPreserved:
        security.pathPreserved
    },

    pass:
      checks.length > 0 &&
      checks.every(result => result.pass) &&
      (allowSyntaxOnly || hasSemanticCheck),

    verificationEvidence: {
      checkCount: checks.length,
      semanticCheck: hasSemanticCheck,
      syntaxOnlyAllowed: allowSyntaxOnly
    }
  };
}

export function evaluateCandidate({
  workspace,
  candidate,
  acceptanceCommands = [],
  autoProjectTests = true,
  timeoutMs = 120000,
  allowSyntaxOnly = false
}) {
  const sandbox =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "jev-sandbox-"
      )
    );

  try {
    copyWorkspace(
      workspace,
      sandbox
    );

    const baselineProjectTests =
      autoProjectTests
        ? runProjectTests(
            sandbox,
            timeoutMs
          )
        : [];

    const applied =
      applyOperations(
        sandbox,
        candidate
      );

    const validation =
      runValidation(
        sandbox,
        applied.changed,
        {
          acceptanceCommands,
          autoProjectTests,
          timeoutMs,
          baselineProjectTests,
          allowSyntaxOnly
        }
      );

    return {
      candidateId:
        applied.candidate.id,

      pass:
        validation.pass,

      changed:
        applied.changed,

      syntax:
        validation.syntax,

      projectTests:
        validation.projectTests,

      acceptance:
        validation.acceptance,

      baselineProjectTests,

      baselineAware:
        baselineProjectTests.length >
        0,

      security:
        validation.security
    };
  }
  catch (
    error
  ) {
    return {
      candidateId:
        candidate?.id ||
        null,

      pass:
        false,

      changed:
        [],

      syntax:
        [],

      projectTests:
        [],

      acceptance:
        [],

      baselineProjectTests:
        [],

      baselineAware:
        false,

      security: {
        validationEnvSanitized:
          true
      },

      error:
        String(
          error.stack ||
          error
        )
    };
  }
  finally {
    fs.rmSync(
      sandbox,
      {
        recursive:
          true,

        force:
          true
      }
    );
  }
}
