import {
  extractExplicitAcceptanceCommands
} from "./explicit-acceptance.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const good =
  extractExplicitAcceptanceCommands(
    "app/system_status.py oluÅŸtur. Acceptance command: python -m pytest -q test_system_status.py -p no:cacheprovider. Mevcut eski pytest hatalarÄ±nÄ± baseline kabul et."
  );

assert(
  good.commands.length === 1,
  "expected one safe command"
);

assert(
  good.commands[0] ===
    "python -m pytest -q test_system_status.py -p no:cacheprovider",
  `unexpected command: ${good.commands[0]}`
);

assert(
  good.rejected.length === 0,
  "safe command was rejected"
);

const dangerous =
  extractExplicitAcceptanceCommands(
    "Acceptance command: python -m pytest -q test_ok.py; Remove-Item C:\\temp\\x"
  );

assert(
  dangerous.commands.length === 0,
  "dangerous command was accepted"
);

assert(
  dangerous.rejected.length === 1,
  "dangerous command should be rejected"
);

const unsupported =
  extractExplicitAcceptanceCommands(
    "Acceptance command: npm test"
  );

assert(
  unsupported.commands.length === 0,
  "unsupported command was accepted"
);

const absent =
  extractExplicitAcceptanceCommands(
    "Run the relevant tests."
  );

assert(
  absent.found === false,
  "false explicit-acceptance detection"
);

console.log(
  JSON.stringify(
    {
      pass: true,
      safe: good.commands,
      dangerousRejected:
        dangerous.rejected.length === 1,
      unsupportedRejected:
        unsupported.rejected.length === 1,
      absentDetected:
        absent.found
    },
    null,
    2
  )
);