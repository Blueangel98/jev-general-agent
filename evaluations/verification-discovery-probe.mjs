import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectVerificationSupport } from "../autonomy/context-builder.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-verification-discovery-"));

try {
  const pythonRoot = path.join(root, "python");
  const javascriptRoot = path.join(root, "javascript");
  const packageRoot = path.join(root, "package");

  fs.mkdirSync(pythonRoot, { recursive: true });
  fs.mkdirSync(javascriptRoot, { recursive: true });
  fs.mkdirSync(packageRoot, { recursive: true });

  fs.writeFileSync(path.join(pythonRoot, "app.py"), "def add(a, b): return a + b\n");
  fs.writeFileSync(path.join(javascriptRoot, "app.mjs"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ scripts: { build: "node --check app.mjs" } }));
  fs.writeFileSync(path.join(packageRoot, "app.mjs"), "export const answer = 42;\n");

  const python = detectVerificationSupport(pythonRoot);
  const javascript = detectVerificationSupport(javascriptRoot);
  const packageScripts = detectVerificationSupport(packageRoot);
  const pass =
    python.length === 1 && python[0] === "python -m compileall -q ." &&
    javascript.length === 1 && javascript[0] === 'node --check "app.mjs"' &&
    packageScripts.length === 1 && packageScripts[0] === "npm run build";

  console.log(JSON.stringify({ pass, python, javascript, packageScripts }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
