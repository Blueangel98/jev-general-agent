import path from "node:path";

const PROTECTED = new Set([
  "supervisor.mjs",
  "runtime/stable-agent.mjs"
]);

export function normalizeRelativePath(value) {
  if (typeof value !== "string") {
    throw new Error("operation.path must be string");
  }

  const normalized =
    value
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "");

  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      `Unsafe relative path: ${value}`
    );
  }

  return normalized;
}

export function isProtectedPath(value) {
  const normalized =
    normalizeRelativePath(value)
      .toLowerCase();

  return [...PROTECTED]
    .some(
      item =>
        normalized === item.toLowerCase()
    );
}

export function validateOperation(operation) {
  if (
    !operation ||
    typeof operation !== "object"
  ) {
    throw new Error(
      "Invalid operation"
    );
  }

  const type =
    operation.type;

  if (
    ![
      "create_file",
      "exact_replace"
    ].includes(type)
  ) {
    throw new Error(
      `Unsupported operation: ${type}`
    );
  }

  const relativePath =
    normalizeRelativePath(
      operation.path
    );

  if (
    isProtectedPath(
      relativePath
    )
  ) {
    throw new Error(
      `Protected path rejected: ${relativePath}`
    );
  }

  if (
    type === "create_file"
  ) {
    if (
      typeof operation.content !== "string"
    ) {
      throw new Error(
        "create_file requires content"
      );
    }
  }

  if (
    type === "exact_replace"
  ) {
    if (
      typeof operation.old_text !== "string" ||
      typeof operation.new_text !== "string"
    ) {
      throw new Error(
        "exact_replace requires old_text/new_text"
      );
    }

    if (
      operation.old_text.length === 0
    ) {
      throw new Error(
        "exact_replace old_text cannot be empty"
      );
    }
  }

  return {
    ...operation,
    path:
      relativePath
  };
}

export function validateCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object"
  ) {
    throw new Error(
      "Invalid candidate"
    );
  }

  if (
    !Array.isArray(candidate.operations)
  ) {
    throw new Error(
      "Candidate requires an operations array"
    );
  }

  return {
    id:
      String(
        candidate.id ||
        `candidate-${Date.now()}`
      ),

    summary:
      String(
        candidate.summary || ""
      ),

    rationale:
      String(
        candidate.rationale || ""
      ),

    operations:
      candidate.operations.map(
        validateOperation
      )
  };
}

export function validatePlan(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    !Array.isArray(plan.candidates)
  ) {
    throw new Error(
      "Plan requires candidates array"
    );
  }

  return {
    candidates:
      plan.candidates.map(
        validateCandidate
      )
  };
}
