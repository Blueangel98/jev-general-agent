import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { applyOperations, runValidation } from "../autonomy/sandbox-runner.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-core-regression-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jev-core-outside-"));

try {
  fs.writeFileSync(path.join(root, "ok.mjs"), "export const ok = true;\n", "utf8");

  const noEvidence = runValidation(root, ["ok.mjs"], {
    autoProjectTests: false,
    acceptanceCommands: ["node -e \"process.exit(0)\""]
  });
  assert.equal(noEvidence.pass, false, "empty successful command must not validate");

  const noChecks = runValidation(root, ["notes.md"], {
    autoProjectTests: false,
    acceptanceCommands: []
  });
  assert.equal(noChecks.pass, false, "no verification checks must not validate");

  assert.throws(() => applyOperations(root, {
    id: "traversal",
    operations: [{ type: "create_file", path: "../outside.txt", content: "no" }]
  }), /Unsafe relative path/);

  let symlinkChecked = false;
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), "junction");
    symlinkChecked = true;
    assert.throws(() => applyOperations(root, {
      id: "junction",
      operations: [{ type: "create_file", path: "escape/pwned.txt", content: "no" }]
    }), /outside workspace/);
  } catch (error) {
    if (symlinkChecked) throw error;
  }

  console.log(JSON.stringify({
    pass: true,
    emptyOutputRejected: true,
    noChecksRejected: true,
    traversalRejected: true,
    symlinkEscapeChecked: symlinkChecked
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
