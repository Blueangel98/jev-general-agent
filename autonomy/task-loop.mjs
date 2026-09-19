import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fileURLToPath
} from "node:url";

import {
  generatePatchPlan
} from "../synthesis/provider.mjs";

import {
  validatePlan
} from "../synthesis/schema.mjs";

import {
  applyOperations,
  evaluateCandidate,
  runValidation
} from "./sandbox-runner.mjs";

import {
  selectCandidate
} from "./jev-selector.mjs";
import { recordExperience } from "../memory/experience-store.mjs";

const ROOT =
  path.dirname(
    path.dirname(
      fileURLToPath(
        import.meta.url
      )
    )
  );

const WORKSPACE_CONFIG =
  path.join(
    ROOT,
    "config",
    "workspace.json"
  );

const HISTORY =
  path.join(
    ROOT,
    "memory",
    "autonomy-history.jsonl"
  );

function readJson(file) {
  return JSON.parse(
    fs.readFileSync(
      file,
      "utf8"
    )
      .replace(
        /^\uFEFF/,
        ""
      )
  );
}

function history(record) {
  fs.appendFileSync(
    HISTORY,
    JSON.stringify({
      timestamp:
        new Date()
          .toISOString(),

      ...record
    }) + "\n",
    "utf8"
  );
}

function repoContext(
  workspace,
  files = []
) {
  return files
    .slice(
      0,
      24
    )
    .flatMap(
      relative => {
        const absolute =
          path.resolve(
            workspace,
            relative
          );

        const rel =
          path.relative(
            workspace,
            absolute
          );

        if (
          rel.startsWith(
            ".."
          ) ||
          path.isAbsolute(
            rel
          ) ||
          !fs.existsSync(
            absolute
          ) ||
          !fs.statSync(
            absolute
          ).isFile()
        ) {
          return [];
        }

        return [
          `FILE: ${rel}\n${fs.readFileSync(absolute, "utf8").slice(0, 40000)}`
        ];
      }
    )
    .join(
      "\n\n"
    );
}

function failurePaths(
  reports
) {
  const found =
    new Set();

  for (
    const report of
    reports
  ) {
    const text =
      [
        report?.error || "",
        ...(
          report?.syntax || []
        )
          .map(
            x =>
              `${x.stderr || ""}\n${x.stdout || ""}`
          ),
        ...(
          report?.projectTests || []
        )
          .map(
            x =>
              `${x.stderr || ""}\n${x.stdout || ""}`
          ),
        ...(
          report?.acceptance || []
        )
          .map(
            x =>
              `${x.stderr || ""}\n${x.stdout || ""}`
          )
      ]
        .join(
          "\n"
        );

    const patterns = [
      /create_file target already exists:\s*([^\r\n]+)/gi,
      /exact_replace target missing:\s*([^\r\n]+)/gi,
      /exact_replace expected \d+ match(?:es)? but found \d+:\s*([^\r\n]+)/gi
    ];

    for (
      const regex of
      patterns
    ) {
      for (
        const match of
        text.matchAll(
          regex
        )
      ) {
        if (
          match[1]
        ) {
          found.add(
            match[1]
              .trim()
              .replace(
                /\\/g,
                "/"
              )
          );
        }
      }
    }
  }

  return [
    ...found
  ];
}

function failureEvidence(
  workspace,
  reports
) {
  const paths =
    failurePaths(
      reports
    );

  const files = [];

  for (
    const relative of
    paths
  ) {
    const absolute =
      path.resolve(
        workspace,
        relative
      );

    const check =
      path.relative(
        workspace,
        absolute
      );

    if (
      check.startsWith(
        ".."
      ) ||
      path.isAbsolute(
        check
      ) ||
      !fs.existsSync(
        absolute
      ) ||
      !fs.statSync(
        absolute
      ).isFile()
    ) {
      continue;
    }

    files.push(
      `CURRENT FILE AFTER SANDBOX FAILURE: ${relative}\n${fs.readFileSync(absolute, "utf8").slice(0, 40000)}`
    );
  }

  const compactReports =
    reports.map(
      report => ({
        candidateId:
          report.candidateId,

        pass:
          report.pass,

        error:
          report.error || null,

        syntax:
          report.syntax,

        projectTests:
          report.projectTests,

        acceptance:
          report.acceptance
      })
    );

  return [
    "PREVIOUS CANDIDATES FAILED DETERMINISTIC SANDBOX VERIFICATION.",
    "Repair the patch proposal. Do not repeat the same invalid operation.",
    "If an error says create_file target already exists, use exact_replace against the exact current file content supplied below.",
    "",
    JSON.stringify(
      compactReports,
      null,
      2
    ),
    "",
    ...files
  ].join(
    "\n"
  );
}

function backupTargets(
  workspace,
  candidate
) {
  const root =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "jev-live-backup-"
      )
    );

  const records = [];

  for (
    const operation of
    candidate.operations
  ) {
    const relative =
      operation.path
        .replace(
          /\\/g,
          "/"
        );

    const absolute =
      path.resolve(
        workspace,
        relative
      );

    const check =
      path.relative(
        workspace,
        absolute
      );

    if (
      check.startsWith(
        ".."
      ) ||
      path.isAbsolute(
        check
      )
    ) {
      throw new Error(
        `Unsafe live target: ${relative}`
      );
    }

    const exists =
      fs.existsSync(
        absolute
      );

    const backup =
      path.join(
        root,
        String(
          records.length
        )
      );

    if (
      exists
    ) {
      fs.copyFileSync(
        absolute,
        backup
      );
    }

    records.push({
      relative,
      absolute,
      exists,
      backup:
        exists
          ? backup
          : null
    });
  }

  return {
    root,
    records
  };
}

function rollback(
  backup
) {
  for (
    const record of
    backup.records
  ) {
    if (
      record.exists
    ) {
      fs.mkdirSync(
        path.dirname(
          record.absolute
        ),
        {
          recursive:
            true
        }
      );

      fs.copyFileSync(
        record.backup,
        record.absolute
      );
    }
    else {
      fs.rmSync(
        record.absolute,
        {
          force:
            true
        }
      );
    }
  }

  fs.rmSync(
    backup.root,
    {
      recursive:
        true,

      force:
        true
    }
  );
}

function discard(
  backup
) {
  fs.rmSync(
    backup.root,
    {
      recursive:
        true,

      force:
        true
    }
  );
}

async function main() {
  const specFile =
    process.argv[2];

  if (
    !specFile
  ) {
    throw new Error(
      "Usage: node autonomy/task-loop.mjs <task-spec.json>"
    );
  }

  const spec =
    readJson(
      path.resolve(
        specFile
      )
    );

  if (
    typeof spec.task !== "string" ||
    !spec.task.trim()
  ) {
    throw new Error(
      "Task spec requires task"
    );
  }

  const configuredWorkspace = readJson(WORKSPACE_CONFIG).path || "";
  const workspaceValue = spec.workspace || process.env.JEV_WORKSPACE_ROOT || configuredWorkspace;
  if (!workspaceValue) {
    throw new Error("Task spec requires workspace or JEV_WORKSPACE_ROOT");
  }
  const workspace = path.resolve(workspaceValue);

  if (
    !fs.existsSync(
      workspace
    )
  ) {
    throw new Error(
      `Workspace missing: ${workspace}`
    );
  }

  const baseContext = [
    String(
      spec.context || ""
    ),

    repoContext(
      workspace,
      Array.isArray(
        spec.contextFiles
      )
        ? spec.contextFiles
        : []
    )
  ]
    .filter(
      Boolean
    )
    .join(
      "\n\n"
    );

  const maxCandidates =
    Math.max(
      1,
      Math.min(
        Number(
          spec.maxCandidates ||
          3
        ),
        5
      )
    );

  const maxRounds =
    Math.max(
      1,
      Math.min(
        Number(
          spec.maxSynthesisRounds ||
          3
        ),
        4
      )
    );

  let feedback =
    "";

  let candidates =
    [];

  let reports =
    [];

  for (
    let round = 1;
    round <= maxRounds;
    round++
  ) {
    console.log(
      `[AUTONOMY] synthesis round=${round}/${maxRounds}`
    );

    const generated =
      await generatePatchPlan({
        task:
          spec.task,

        context:
          [
            baseContext,
            feedback
          ]
            .filter(
              Boolean
            )
            .join(
              "\n\n"
            )
      });

    const plan =
      validatePlan(
        generated.plan
      );

    candidates =
      plan.candidates
        .slice(
          0,
          maxCandidates
        );

    if (
      candidates.length === 0
    ) {
      throw new Error(
        "Synthesis produced no candidates"
      );
    }

    console.log(
      `[AUTONOMY] candidates=${candidates.length} synthesis_ms=${generated.latencyMs} provider_attempts=${generated.attempts || 1}`
    );

    reports =
      candidates.map(
        candidate => {
          const report =
            evaluateCandidate({
              workspace,
              candidate,

              acceptanceCommands:
                Array.isArray(
                  spec.acceptanceCommands
                )
                  ? spec.acceptanceCommands
                  : [],

              autoProjectTests:
                spec.autoProjectTests !==
                false,

              timeoutMs:
                Number(
                  spec.timeoutMs ||
                  120000
                ),

              allowSyntaxOnly:
                spec.allowSyntaxOnly === true
            });

          console.log(
            `[SANDBOX] round=${round} candidate=${candidate.id} pass=${report.pass}`
          );

          return report;
        }
      );

    if (
      reports.some(
        report =>
          report.pass
      )
    ) {
      break;
    }

    if (
      round <
      maxRounds
    ) {
      feedback =
        failureEvidence(
          workspace,
          reports
        );

      console.log(
        `[AUTONOMY] no passing candidate; resynthesis scheduled feedback_bytes=${feedback.length}`
      );
    }
  }

  if (
    !reports.some(
      report =>
        report.pass
    )
  ) {
    history({
      task:
        spec.task,

      result:
        "rejected_no_passing_candidate",

      reports
    });
    recordExperience({
      task: spec.task,
      outcome: "rejected_no_passing_candidate",
      failure: "No candidate passed deterministic sandbox verification",
      verification: reports
    });

    console.log(
      JSON.stringify(
        {
          status:
            "REJECTED",

          reason:
            "No candidate passed sandbox after resynthesis",

          reports
        },
        null,
        2
      )
    );

    process.exitCode =
      2;

    return;
  }

  const selection =
    await selectCandidate({
      task:
        spec.task,

      candidates,
      reports
    });

  console.log(
    `[JEV_SELECT] decision=${selection.decision} candidate=${selection.candidateId || "none"} confidence=${selection.confidence}`
  );

  if (
    selection.decision !==
    "apply"
  ) {
    history({
      task:
        spec.task,

      result:
        "rejected_by_jev",

      selection,
      reports
    });
    recordExperience({
      task: spec.task,
      outcome: "rejected_by_jev",
      failure: selection.reason || "JEV rejected candidate",
      verification: reports
    });

    console.log(
      JSON.stringify(
        {
          status:
            "REJECTED_BY_JEV",

          selection,
          reports
        },
        null,
        2
      )
    );

    return;
  }

  const selected =
    candidates.find(
      candidate =>
        candidate.id ===
        selection.candidateId
    );

  if (
    !selected
  ) {
    throw new Error(
      "Selected candidate not found"
    );
  }

  const backup =
    backupTargets(
      workspace,
      selected
    );

  try {
    const selectedReport =
      reports.find(
        report =>
          report.candidateId ===
          selected.id
      );
    const applied = applyOperations(workspace, selected, { live: true });
const verification = runValidation(workspace, applied.changed, {
          acceptanceCommands:
            Array.isArray(
              spec.acceptanceCommands
            )
              ? spec.acceptanceCommands
              : [],

          autoProjectTests:
            spec.autoProjectTests !==
            false,

          timeoutMs:
            Number(
              spec.timeoutMs ||
              120000
            ),
  baselineProjectTests:
    Array.isArray(selectedReport?.baselineProjectTests)
      ? selectedReport.baselineProjectTests
      : [],
  allowSyntaxOnly: spec.allowSyntaxOnly === true
});

    if (
      !verification.pass
    ) {
      rollback(
        backup
      );

      history({
        task:
          spec.task,

        result:
          "rolled_back_real_verification_failed",

        candidateId:
          selected.id,

        selection,
        verification
      });
      recordExperience({
        task: spec.task,
        outcome: "rolled_back",
        changed: applied.changed,
        verification
      });

      console.log(
        JSON.stringify(
          {
            status:
              "ROLLED_BACK",

            candidateId:
              selected.id,

            selection,
            verification
          },
          null,
          2
        )
      );

      process.exitCode =
        3;

      return;
    }

    discard(
      backup
    );

    history({
      task:
        spec.task,

      result:
        "applied",

      candidateId:
        selected.id,

      selection,
      changed:
        applied.changed,

      verification
    });
    recordExperience({
      task: spec.task,
      outcome: "applied",
      changed: applied.changed,
      verification
    });

    console.log(
      JSON.stringify(
        {
          status:
            "APPLIED",

          candidateId:
            selected.id,

          changed:
            applied.changed,

          selection,
          verification
        },
        null,
        2
      )
    );
  }
  catch (
    error
  ) {
    rollback(
      backup
    );

    history({
      task:
        spec.task,

      result:
        "rolled_back_exception",

      candidateId:
        selected.id,

      error:
        String(
          error.stack ||
          error
        )
    });
    recordExperience({
      task: spec.task,
      outcome: "rolled_back_exception",
      failure: String(error?.message || error)
    });

    throw error;
  }
}

try {
  await main();
}
catch (
  error
) {
  const errorText =
    String(
      error?.stack ||
      error
    );

  const retryableSynthesisFailure =
    /LOCAL_SYNTHESIS_UNSUPPORTED|Synthesis provider is not configured|AbortError|aborted|timeout|timed out|ResourceExhausted|HTTP\s*(?:429|500|502|503|504)|status[=: ]+(?:429|500|502|503|504)/i
      .test(
        errorText
      );

  if (
    !retryableSynthesisFailure
  ) {
    throw error;
  }

  let task =
    null;

  try {
    const specPath =
      process.argv[2];

    if (
      specPath &&
      fs.existsSync(
        specPath
      )
    ) {
      const failedSpec =
        readJson(
          specPath
        );

      task =
        typeof failedSpec?.task ===
        "string"
          ? failedSpec.task
          : null;
    }
  }
  catch {
    task =
      null;
  }

  const unsupportedLocalSynthesis =
    /LOCAL_SYNTHESIS_UNSUPPORTED|Local deterministic synthesis does not support/i.test(errorText);

  history({
    task,

    result:
      unsupportedLocalSynthesis
        ? "synthesis_unsupported"
        : "synthesis_unavailable",

    stage:
      "synthesis",

    retryable:
      !unsupportedLocalSynthesis,

    error:
      errorText
  });
  recordExperience({
    task,
    outcome: unsupportedLocalSynthesis
      ? "synthesis_unsupported"
      : "synthesis_unavailable",
    failure: errorText
  });

  console.log(
    "[AUTONOMY] synthesis_terminal_status=NEEDS_VERIFICATION"
  );

  console.log(
    JSON.stringify(
      {
        status:
          "NEEDS_VERIFICATION",

        stage:
          "synthesis",

        retryable:
          !unsupportedLocalSynthesis,

        reason:
          unsupportedLocalSynthesis
            ? "This task requires free-form multi-file code generation, which the configured local deterministic JEV mode does not support. No live apply was performed."
            : "Synthesis provider is unavailable or timed out. No live apply was performed."
      },
      null,
      2
    )
  );

  process.exitCode =
    4;
}
