import fs from "node:fs";
import path from "node:path";

const BLOCKED = new Set([
  ".git","node_modules",".venv","venv","__pycache__",".pytest_cache",
  ".mypy_cache",".ruff_cache","dist","build",".next","coverage",
  "logs","snapshots"
]);

const TEXT_EXT = new Set([
  ".js",".mjs",".cjs",".ts",".tsx",".jsx",".py",".json",".toml",".yaml",".yml",
  ".md",".txt",".ini",".cfg",".sql",".java",".kt",".kts",".gradle",".properties",
  ".xml",".html",".css",".scss",".sh",".ps1"
]);

const IMPORTANT = [
  "README.md","package.json","pyproject.toml","requirements.txt","pytest.ini",
  "setup.cfg","tsconfig.json","vite.config.js","vite.config.ts",
  "build.gradle","build.gradle.kts","settings.gradle","settings.gradle.kts",
  "gradle.properties"
];

function tokens(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9_./-]{3,}/g) || []
  )]
    .filter(
      token =>
        ![
          "the","and","for","with","this","that","dosyasÄ±na","dosyasini",
          "fonksiyonunun","Ã§Ä±ktÄ±sÄ±nÄ±","ciktisini","yap","ekle","deÄŸiÅŸtir",
          "degistir","projedeki","projede"
        ].includes(
          token
        )
    )
    .slice(
      0,
      100
    );
}

function walk(root, dir = root, out = []) {
  for (
    const entry of
    fs.readdirSync(
      dir,
      {
        withFileTypes:
          true
      }
    )
  ) {
    if (
      BLOCKED.has(
        entry.name.toLowerCase()
      )
    ) {
      continue;
    }

    const abs =
      path.join(
        dir,
        entry.name
      );

    const rel =
      path.relative(
        root,
        abs
      )
        .replace(
          /\\/g,
          "/"
        );

    if (
      entry.isDirectory()
    ) {
      walk(
        root,
        abs,
        out
      );

      continue;
    }

    if (
      !entry.isFile()
    ) {
      continue;
    }

    if (
      !TEXT_EXT.has(
        path.extname(
          entry.name
        ).toLowerCase()
      )
    ) {
      continue;
    }

    try {
      const size =
        fs.statSync(
          abs
        ).size;

      if (
        size >
        500000
      ) {
        continue;
      }

      out.push({
        rel,
        abs,
        size
      });
    }
    catch {
      // ignored
    }
  }

  return out;
}

function analyzeFile(
  file,
  taskTokens
) {
  const name =
    file.rel.toLowerCase();

  let content =
    "";

  try {
    content =
      fs.readFileSync(
        file.abs,
        "utf8"
      )
        .slice(
          0,
          50000
        )
        .toLowerCase();
  }
  catch {
    // ignored
  }

  let score =
    IMPORTANT.some(
      x =>
        name.endsWith(
          x.toLowerCase()
        )
    )
      ? 40
      : 0;

  let strongMatch =
    false;

  for (
    const token of
    taskTokens
  ) {
    if (
      name.includes(
        token
      )
    ) {
      score +=
        150;

      strongMatch =
        true;
    }

    if (
      content.includes(
        token
      )
    ) {
      score +=
        80;

      strongMatch =
        true;
    }
  }

  return {
    ...file,
    score,
    strongMatch
  };
}

function packageRunner(root) {
  if (
    fs.existsSync(path.join(root, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(root, "pnpm-workspace.yaml"))
  ) {
    return "pnpm run";
  }

  if (
    fs.existsSync(path.join(root, "yarn.lock"))
  ) {
    return "yarn";
  }

  if (
    fs.existsSync(path.join(root, "bun.lockb")) ||
    fs.existsSync(path.join(root, "bun.lock"))
  ) {
    return "bun run";
  }

  return "npm run";
}

function projectSourceFiles(root) {
  return walk(root)
    .filter(file =>
      /\.(?:js|mjs|cjs|py)$/i.test(file.rel)
    )
    .map(file => file.rel.replace(/\\/g, "/"));
}

function javascriptSmokeCommand(root) {
  const files = projectSourceFiles(root)
    .filter(file => /\.(?:js|mjs|cjs)$/i.test(file))
    .slice(0, 80);

  if (!files.length) return null;

  return files
    .map(file => `node --check "${file.replace(/"/g, '""')}"`)
    .join(" && ");
}

export function detectVerificationSupport(root) {
  const detected = [];

  const pkgFile =
    path.join(
      root,
      "package.json"
    );

  if (
    fs.existsSync(
      pkgFile
    )
  ) {
    try {
      const pkg =
        JSON.parse(
          fs.readFileSync(
            pkgFile,
            "utf8"
          )
            .replace(
              /^\uFEFF/,
              ""
            )
        );

      const scripts = pkg?.scripts || {};
      const runner = packageRunner(root);
      const testScript = scripts.test;

      if (
        typeof testScript === "string" &&
        testScript.trim() &&
        !/no test specified/i.test(testScript)
      ) {
        detected.push(`${runner === "npm run" ? "npm test" : `${runner} test`}`);
      }

      if (!detected.length) {
        for (const name of ["build", "typecheck", "lint", "check", "verify"]) {
          if (typeof scripts[name] === "string" && scripts[name].trim()) {
            detected.push(`${runner} ${name}`);
            break;
          }
        }
      }
    }
    catch {
      // ignored
    }
  }

  if (
    [
      "pytest.ini",
      "pyproject.toml",
      "setup.cfg",
      "tests"
    ]
      .some(
        x =>
          fs.existsSync(
            path.join(
              root,
              x
            )
          )
      )
  ) {
    detected.push(
      "python -m pytest -q"
    );
  }

  if (
    fs.existsSync(
      path.join(
        root,
        "gradlew.bat"
      )
    )
  ) {
    detected.push(
      "gradlew.bat test"
    );
  }
  else if (
    fs.existsSync(
      path.join(
        root,
        "gradlew"
      )
    )
  ) {
    detected.push(
      "./gradlew test"
    );
  }

  if (
    detected.length === 0 &&
    fs.existsSync(path.join(root, "pom.xml"))
  ) {
    detected.push("mvn test");
  }

  if (
    detected.length === 0 &&
    fs.existsSync(path.join(root, "Cargo.toml"))
  ) {
    detected.push("cargo test");
  }

  if (
    detected.length === 0 &&
    fs.existsSync(path.join(root, "go.mod"))
  ) {
    detected.push("go test ./...");
  }

  if (
    detected.length === 0 &&
    projectSourceFiles(root).some(file => /\.py$/i.test(file))
  ) {
    detected.push("python -m compileall -q .");
  }

  if (
    detected.length === 0 &&
    !fs.existsSync(path.join(root, "tsconfig.json"))
  ) {
    const javascriptSmoke = javascriptSmokeCommand(root);
    if (javascriptSmoke) detected.push(javascriptSmoke);
  }

  return detected;
}

export function buildContext({
  workspace,
  task,
  maxFiles = 16
}) {
  const files =
    walk(
      workspace
    );

  const taskTokens =
    tokens(
      task
    );

  const ranked =
    files
      .map(
        file =>
          analyzeFile(
            file,
            taskTokens
          )
      )
      .sort(
        (
          a,
          b
        ) =>
          Number(
            b.strongMatch
          ) -
          Number(
            a.strongMatch
          ) ||
          b.score -
          a.score ||
          a.rel.localeCompare(
            b.rel
          )
      );

  const selected =
    ranked
      .slice(
        0,
        maxFiles
      )
      .map(
        file =>
          file.rel
      );

  const tree =
    files
      .map(
        file =>
          file.rel
      )
      .sort()
      .slice(
        0,
        500
      );

  return {
    contextFiles:
      selected,

    context: [
      "AUTO DISCOVERED PROJECT TREE:",
      ...tree.map(
        x =>
          `- ${x}`
      ),
      "",
      `Selected context files: ${selected.join(", ")}`
    ].join(
      "\n"
    ),

    verificationCommands:
      detectVerificationSupport(
        workspace
      ),

    totalFiles:
      files.length
  };
}
