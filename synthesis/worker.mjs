import fs from "node:fs";
import path from "node:path";
import {
  generatePatchPlan,
  synthesisConfigured,
  synthesisConfig
} from "./provider.mjs";

import {
  validatePlan
} from "./schema.mjs";

const command =
  process.argv[2] ||
  "status";

function readText(file) {
  return fs.readFileSync(
    path.resolve(file),
    "utf8"
  );
}

if (
  command === "status"
) {
  const config =
    synthesisConfig();

  console.log(
    JSON.stringify(
      {
        configured:
          synthesisConfigured(),

        baseUrl:
          config.baseUrl
            ? "[configured]"
            : "",

        model:
          config.model || "",

        apiKey:
          config.apiKey
            ? "[configured]"
            : ""
      },
      null,
      2
    )
  );

  process.exit(0);
}

if (
  command !== "propose"
) {
  throw new Error(
    `Unknown synthesis command: ${command}`
  );
}

const taskFile =
  process.argv[3];

const contextFile =
  process.argv[4];

if (
  !taskFile
) {
  throw new Error(
    "Usage: node synthesis/worker.mjs propose <task-file> [context-file]"
  );
}

const task =
  readText(
    taskFile
  );

const context =
  contextFile
    ? readText(
        contextFile
      )
    : "";

const result =
  await generatePatchPlan({
    task,
    context
  });

const validated =
  validatePlan(
    result.plan
  );

console.log(
  JSON.stringify(
    {
      latencyMs:
        result.latencyMs,

      ...validated
    },
    null,
    2
  )
);