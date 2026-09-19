const JEV_URL = process.env.JEV_URL || "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";
const JEV_KEY = process.env.TYPESAFE_API_KEY || "";

function clip(v, n = 16000) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length <= n ? s : s.slice(0, n) + "\n...[truncated]";
}

export async function selectCandidate({ task, candidates, reports }) {
  if (!JEV_KEY) throw new Error("TYPESAFE_API_KEY is not configured");

  const passing = reports.filter(r => r.pass);
  if (!passing.length) {
    return {
      decision: "reject",
      candidateId: null,
      confidence: 1,
      probabilities: { reject: 1 },
      deterministic: true
    };
  }

  const byId = new Map(candidates.map(c => [c.id, c]));
  const optionToId = new Map();
  const criteria = {};

  passing.forEach((r, i) => {
    const key = `candidate_${i + 1}`;
    optionToId.set(key, r.candidateId);
    const c = byId.get(r.candidateId);
    criteria[key] = clip({
      candidateId: r.candidateId,
      summary: c?.summary || "",
      rationale: c?.rationale || "",
      operations: c?.operations || [],
      sandbox: {
        syntax: r.syntax,
        projectTests: r.projectTests,
        acceptance: r.acceptance
      }
    });
  });

  criteria.reject =
    "Reject all candidates if none is adequately supported by the task, evidence, constraints, or sandbox results.";

  const state = {
    task,
    rule:
      "Only candidates that passed deterministic sandbox checks are shown. Choose the most direct minimal candidate. Reject if evidence is insufficient or scope is excessive.",
    candidates: passing.map(r => {
      const c = byId.get(r.candidateId);
      return {
        id: r.candidateId,
        summary: c?.summary || "",
        rationale: c?.rationale || "",
        operations: c?.operations || [],
        sandboxPass: true
      };
    })
  };

  const started = Date.now();
  const response = await fetch(JEV_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${JEV_KEY}`
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state,
      questions: {
        selection: {
          type: "choice",
          instructions:
            "Choose the best verified candidate for the development task, or reject all candidates.",
          criteria
        }
      }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Jev HTTP ${response.status}: ${raw.slice(0, 1000)}`);
  }

  const parsed = JSON.parse(raw);
  const answer = parsed?.answers?.selection;

  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("Invalid Jev choice response");
  }

  if (answer.choice === "reject") {
    return {
      decision: "reject",
      candidateId: null,
      choice: answer.choice,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities || {},
      latencyMs: Date.now() - started,
      model: parsed.model || null
    };
  }

  const candidateId = optionToId.get(answer.choice);
  if (!candidateId) throw new Error(`Jev selected unknown option: ${answer.choice}`);

  return {
    decision: "apply",
    candidateId,
    choice: answer.choice,
    confidence: answer.confidence ?? null,
    probabilities: answer.probabilities || {},
    latencyMs: Date.now() - started,
    model: parsed.model || null
  };
}