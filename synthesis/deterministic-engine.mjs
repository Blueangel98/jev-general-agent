function sourceFiles(context) {
  const files = [];
  const pattern = /(?:^|\n)FILE:\s*([^\r\n]+)\r?\n([\s\S]*?)(?=\r?\n\r?\nFILE:\s*|$)/g;
  for (const match of String(context || "").matchAll(pattern)) {
    files.push({ path: match[1].trim().replace(/\\/g, "/"), content: match[2] });
  }
  return files;
}

function taskFile(task) {
  return String(task || "").match(/\b([A-Za-z0-9_.\\/-]+\.(?:py|js|mjs|cjs|json))\b/i)?.[1]?.replace(/\\/g, "/") || null;
}

function taskFunction(task) {
  const text = String(task || "");
  const patterns = [
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/i,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+fonksiyon(?:unun|u)?\b/i,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+function\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function expectedToken(task) {
  const text = String(task || "");
  const marker = text.match(/\b(?:JEV|JS|PY|TS|OK|EXPECTED)[A-Z0-9_:-]{2,}\b/);
  if (marker) return marker[0];
  const quoted = text.match(/["'`]([^"'`\r\n]{1,120})["'`]/);
  return quoted?.[1] || null;
}

function stringLiteral(value, language) {
  return language === "python" ? JSON.stringify(value) : JSON.stringify(value);
}

function functionReturnCandidate(task, context) {
  const file = taskFile(task);
  const name = taskFunction(task);
  const expected = expectedToken(task);
  if (!file || !name || !expected) return null;

  const source = sourceFiles(context).find(item => item.path === file || item.path.endsWith(`/${file}`));
  if (!source) return null;

  const isPython = /\.py$/i.test(source.path);
  let oldText = "";
  let newText = "";

  if (isPython) {
    const block = source.content.match(new RegExp(`def\\s+${name}\\s*\\([^\\n]*\\):[\\s\\S]*?(?=\\n\\S|$)`));
    const returnLine = block?.[0].match(/^[ \t]*return\s+[^\r\n]+/m)?.[0];
    if (!returnLine) return null;
    oldText = returnLine;
    newText = returnLine.replace(/return\s+[^\r\n]+$/, `return ${stringLiteral(expected, "python")}`);
  } else {
    const block = source.content.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\}`));
    const returnLine = block?.[0].match(/^[ \t]*return\s+[^\r\n]+/m)?.[0];
    if (!returnLine) return null;
    oldText = returnLine;
    newText = returnLine.replace(/return\s+[^\r\n]+$/, `return ${stringLiteral(expected, "javascript")};`);
  }

  if (oldText === newText) return null;
  return {
    id: "deterministic-function-return",
    summary: `Set ${name} in ${file} to return the requested value.`,
    rationale: "The task names one function and the exact current return line was found in the supplied workspace evidence.",
    operations: [{ type: "exact_replace", path: source.path, old_text: oldText, new_text: newText }]
  };
}

function jsonValueCandidate(task, context) {
  const file = taskFile(task);
  if (!file || !/\.json$/i.test(file)) return null;
  const source = sourceFiles(context).find(item => item.path === file || item.path.endsWith(`/${file}`));
  if (!source) return null;
  const expected = expectedToken(task);
  if (!expected) return null;
  const key = String(task).match(/\b(?:key|field|alanı|alanÄ±nÄ±|alanini|alanını)\s+["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)|\b([A-Za-z_$][A-Za-z0-9_$.-]*)\s+(?:alanı|alanÄ±nÄ±|alanini|alanını)\b/i)?.[1] || String(task).match(/\b([A-Za-z_$][A-Za-z0-9_$.-]*)\s+(?:alanı|alanÄ±nÄ±|alanini|alanını)\b/i)?.[1];
  if (!key) return null;

  let value;
  try { value = JSON.parse(source.content.replace(/^\uFEFF/, "")); } catch { return null; }
  const parts = key.split(".");
  let cursor = value;
  for (let index = 0; index < parts.length - 1; index++) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = cursor[parts[index]];
  }
  if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, parts.at(-1))) return null;
  cursor[parts.at(-1)] = expected === "true" ? true : expected === "false" ? false : expected;
  return {
    id: "deterministic-json-value",
    summary: `Set ${key} in ${file} to the requested value.`,
    rationale: "The JSON file, field, and requested primitive were verified from the task and workspace evidence.",
    operations: [{ type: "exact_replace", path: source.path, old_text: source.content, new_text: JSON.stringify(value, null, 2) + "\n" }]
  };
}

export function deterministicPatchPlan({ task, context }) {
  const candidate = functionReturnCandidate(task, context) || jsonValueCandidate(task, context);
  return candidate ? { candidates: [candidate] } : null;
}
