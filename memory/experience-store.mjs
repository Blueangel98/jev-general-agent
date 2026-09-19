import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = path.join(ROOT, "memory", "task-experiences.jsonl");

function redact(value) {
  return String(value || "")
    .replace(/([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 5000);
}

function terms(value) {
  return new Set(redact(value).toLowerCase().match(/[a-z0-9_ğüşöçıİĞÜŞÖÇ]{3,}/gi) || []);
}

function readAll() {
  if (!fs.existsSync(STORE)) return [];
  return fs.readFileSync(STORE, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function recordExperience(record) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const task = redact(record.task).trim();
  const normalized = {
    id: crypto.createHash("sha256").update(`${task}|${Date.now()}`).digest("hex").slice(0, 16),
    timestamp: new Date().toISOString(),
    task,
    outcome: String(record.outcome || "unknown"),
    changed: Array.isArray(record.changed) ? record.changed.slice(0, 40) : [],
    verification: record.verification == null
      ? null
      : redact(JSON.stringify(record.verification)).slice(0, 12000),
    failure: redact(record.failure || "")
  };
  fs.appendFileSync(STORE, JSON.stringify(normalized) + "\n", "utf8");
  return normalized;
}

export function relatedExperiences(task, limit = 5) {
  const wanted = terms(task);
  if (wanted.size === 0) return [];
  return readAll()
    .map(item => ({ item, score: [...wanted].filter(term => terms(item.task).has(term)).length }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.timestamp).localeCompare(String(a.item.timestamp)))
    .slice(0, limit)
    .map(row => ({ ...row.item, relevance: row.score }));
}

export function experienceContext(task, limit = 5) {
  const matches = relatedExperiences(task, limit);
  if (matches.length === 0) return "";
  return [
    "RELEVANT PAST TASK EXPERIENCES (evidence only; verify against current files):",
    ...matches.map(item => JSON.stringify({
      task: item.task,
      outcome: item.outcome,
      changed: item.changed,
      verification: item.verification,
      failure: item.failure,
      relevance: item.relevance
    }))
  ].join("\n");
}

export { STORE as EXPERIENCE_STORE };
