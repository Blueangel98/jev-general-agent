import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deriveSafeAcceptance } from "./acceptance-deriver.mjs";

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "jev-json-tr-probe-")
);

try {
  fs.mkdirSync(
    path.join(root, "config"),
    { recursive: true }
  );

  fs.writeFileSync(
    path.join(root, "config", "acceptance-probe.json"),
    JSON.stringify(
      { status: "JEV_JSON_ACCEPTANCE_OK" },
      null,
      2
    ),
    "utf8"
  );

  const task =
    "config/acceptance-probe.json dosyasÄ±nÄ± oluÅŸtur. Ä°Ã§indeki status deÄŸerini JEV_JSON_ACCEPTANCE_OK yap. DeÄŸiÅŸikliÄŸi test et ve yalnÄ±z doÄŸrulanÄ±rsa uygula.";

  const derived =
    deriveSafeAcceptance({ task });

  if (
    !derived?.derived ||
    derived.kind !== "json_key_equals_primitive" ||
    derived.file !== "config/acceptance-probe.json" ||
    derived.symbol !== "status" ||
    derived.expected !== "JEV_JSON_ACCEPTANCE_OK"
  ) {
    console.error(
      JSON.stringify(
        {
          pass: false,
          stage: "derive",
          derived
        },
        null,
        2
      )
    );

    process.exit(1);
  }

  const r = spawnSync(
    derived.command,
    {
      cwd: root,
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000
    }
  );

  const pass =
    r.status === 0 &&
    !r.error;

  console.log(
    JSON.stringify(
      {
        pass,
        kind: derived.kind,
        file: derived.file,
        key: derived.symbol,
        expected: derived.expected,
        status: r.status,
        stderr: String(r.stderr || "")
      },
      null,
      2
    )
  );

  process.exit(pass ? 0 : 1);
}
finally {
  fs.rmSync(
    root,
    {
      recursive: true,
      force: true
    }
  );
}