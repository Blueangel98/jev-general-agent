function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .trim();
}

function containsShellControl(command) {
  return (
    /[;&|><`]/.test(command) ||
    /\$\(/.test(command) ||
    /\$\{/.test(command) ||
    command.includes("\n")
  );
}

function isSafePytestCommand(command) {
  const value =
    normalizeWhitespace(command);

  if (
    !value ||
    value.length > 500 ||
    containsShellControl(value)
  ) {
    return false;
  }

  if (
    !/^python(?:\.exe)?\s+-m\s+pytest(?:\s|$)/i.test(
      value
    )
  ) {
    return false;
  }

  const tokens =
    value.split(/\s+/);

  if (
    tokens.length < 3
  ) {
    return false;
  }

  const first =
    tokens[0].toLowerCase();

  if (
    first !== "python" &&
    first !== "python.exe"
  ) {
    return false;
  }

  if (
    tokens[1] !== "-m" ||
    tokens[2].toLowerCase() !== "pytest"
  ) {
    return false;
  }

  for (
    let i = 3;
    i < tokens.length;
    i++
  ) {
    const token =
      tokens[i];

    if (
      !/^[A-Za-z0-9_./\\:\-=]+$/.test(
        token
      )
    ) {
      return false;
    }

    if (
      token === "-p"
    ) {
      const next =
        tokens[i + 1] || "";

      if (
        !/^no:[A-Za-z0-9_.-]+$/.test(
          next
        )
      ) {
        return false;
      }

      i++;
    }
  }

  return true;
}

function commandAfterLabel(task, startIndex) {
  const source =
    String(task || "");

  const tail =
    source.slice(
      startIndex
    );

  const lineEndCandidates = [
    tail.indexOf("\r"),
    tail.indexOf("\n")
  ]
    .filter(
      value =>
        value >= 0
    );

  let end =
    lineEndCandidates.length
      ? Math.min(
          ...lineEndCandidates
        )
      : tail.length;

  const sentenceBoundary =
    tail.search(
      /\.\s+(?=[A-ZÃ‡ÄÄ°Ã–ÅÃœ])/u
    );

  if (
    sentenceBoundary >= 0
  ) {
    end =
      Math.min(
        end,
        sentenceBoundary
      );
  }

  return normalizeWhitespace(
    tail.slice(
      0,
      end
    )
  );
}

export function extractExplicitAcceptanceCommands(
  task
) {
  const source =
    String(task || "");

  const label =
    /Acceptance command\s*:\s*/gi;

  const commands = [];
  const rejected = [];

  let match;

  while (
    (
      match =
        label.exec(source)
    ) !== null
  ) {
    const command =
      commandAfterLabel(
        source,
        match.index +
          match[0].length
      );

    if (
      isSafePytestCommand(
        command
      )
    ) {
      commands.push(
        command
      );
    }
    else {
      rejected.push(
        command
      );
    }
  }

  return {
    found:
      commands.length > 0 ||
      rejected.length > 0,

    commands:
      [...new Set(commands)],

    rejected
  };
}

export {
  isSafePytestCommand
};