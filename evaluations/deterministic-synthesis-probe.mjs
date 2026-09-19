import { deterministicPatchPlan } from "../synthesis/deterministic-engine.mjs";

const context = [
  "FILE: app.py",
  "def add(left, right):",
  "    return left + right",
  "",
  "FILE: config/probe.json",
  "{\n  \"status\": \"OLD\"\n}\n"
].join("\n");

const functionPlan = deterministicPatchPlan({
  task: "app.py içindeki add fonksiyonunun döndürdüğü değeri PY_OK yap.",
  context
});

const jsonPlan = deterministicPatchPlan({
  task: "config/probe.json içindeki status alanını JEV_JSON_OK yap.",
  context
});

const pass =
  functionPlan?.candidates?.[0]?.operations?.[0]?.new_text === '    return "PY_OK"' &&
  jsonPlan?.candidates?.[0]?.operations?.[0]?.new_text?.includes("JEV_JSON_OK");

console.log(JSON.stringify({
  pass,
  functionCandidate: functionPlan?.candidates?.[0]?.id || null,
  jsonCandidate: jsonPlan?.candidates?.[0]?.id || null
}, null, 2));

process.exitCode = pass ? 0 : 1;
