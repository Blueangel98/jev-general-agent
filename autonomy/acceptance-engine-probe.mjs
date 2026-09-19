import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deriveSafeAcceptance } from "./acceptance-deriver.mjs";

function run(cwd, command) {
  const r =
    spawnSync(
      command,
      {
        cwd,
        shell:
          true,

        encoding:
          "utf8",

        windowsHide:
          true,

        timeout:
          30000
      }
    );

  return {
    pass:
      r.status === 0 &&
      !r.error,

    status:
      r.status,

    stdout:
      String(
        r.stdout ||
        ""
      ),

    stderr:
      String(
        r.stderr ||
        ""
      ),

    error:
      r.error
        ? String(
            r.error.message ||
            r.error
          )
        : null
  };
}

const root =
  fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "jev-acceptance-v6-"
    )
  );

try {
  fs.mkdirSync(
    path.join(
      root,
      "skills"
    ),
    {
      recursive:
        true
    }
  );

  fs.writeFileSync(
    path.join(
      root,
      "skills",
      "probe.mjs"
    ),
    "export function probeSkill(){ return 'JS_OK'; }\n",
    "utf8"
  );

  fs.mkdirSync(
    path.join(
      root,
      "python"
    ),
    {
      recursive:
        true
    }
  );

  fs.writeFileSync(
    path.join(
      root,
      "python",
      "probe.py"
    ),
    "def probe_value():\n    return 'PY_OK'\n",
    "utf8"
  );

  fs.mkdirSync(
    path.join(
      root,
      "config"
    ),
    {
      recursive:
        true
    }
  );

  fs.writeFileSync(
    path.join(
      root,
      "config",
      "probe.json"
    ),
    JSON.stringify(
      {
        enabled:
          true,

        nested: {
          mode:
            "SAFE"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(
      root,
      "README.md"
    ),
    "# Probe\n\n## Architecture\n",
    "utf8"
  );

  const cases = [
    {
      name:
        "js",

      task:
        "skills/probe.mjs iÃ§indeki probeSkill fonksiyonunun dÃ¶ndÃ¼rdÃ¼ÄŸÃ¼ deÄŸeri JS_OK yap.",

      expectedKind:
        "js_export_zero_arg_returns_primitive"
    },
    {
      name:
        "python",

      task:
        "python/probe.py iÃ§indeki probe_value fonksiyonunun dÃ¶ndÃ¼rdÃ¼ÄŸÃ¼ deÄŸeri PY_OK yap.",

      expectedKind:
        "python_zero_arg_function_returns_primitive"
    },
    {
      name:
        "json",

      task:
        "config/probe.json iÃ§indeki enabled deÄŸerini true yap.",

      expectedKind:
        "json_key_equals_primitive"
    },
    {
      name:
        "text",

      task:
        "README.md dosyasÄ±na 'Architecture' metnini ekle.",

      expectedKind:
        "text_file_contains_exact_text"
    }
  ];

  const results = [];

  for (const item of cases) {
    const derived =
      deriveSafeAcceptance({
        task:
          item.task
      });

    if (
      !derived.derived ||
      derived.kind !==
        item.expectedKind
    ) {
      results.push({
        name:
          item.name,

        pass:
          false,

        stage:
          "derive",

        derived
      });

      continue;
    }

    const executed =
      run(
        root,
        derived.command
      );

    results.push({
      name:
        item.name,

      kind:
        derived.kind,

      pass:
        executed.pass,

      status:
        executed.status,

      stderr:
        executed.stderr
          .slice(
            -1000
          )
    });
  }

  const pass =
    results.every(
      item =>
        item.pass
    );

  console.log(
    JSON.stringify(
      {
        pass,
        results
      },
      null,
      2
    )
  );

  process.exit(
    pass
      ? 0
      : 1
  );
}
finally {
  fs.rmSync(
    root,
    {
      recursive:
        true,

      force:
        true
    }
  );
}