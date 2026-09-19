import path from "node:path";

function safeRelativeFile(value) {
  const text =
    String(value || "")
      .trim()
      .replace(/\\/g, "/");

  if (
    !/^[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,10}$/i.test(text)
  ) {
    return null;
  }

  if (
    path.isAbsolute(text) ||
    text.split("/").includes("..")
  ) {
    return null;
  }

  return text;
}

function safeIdentifier(value) {
  const text =
    String(value || "").trim();

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)
    ? text
    : null;
}

function safeDottedKey(value) {
  const text =
    String(value || "").trim();

  if (!text) return null;

  const parts =
    text.split(".");

  return parts.every(
    part =>
      /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(part)
  )
    ? text
    : null;
}

function safePrimitiveToken(value) {
  const text =
    String(value || "")
      .trim()
      .replace(/[.,;!?]+$/g, "");

  return /^[A-Za-z0-9_.:-]{1,200}$/.test(text)
    ? text
    : null;
}

function b64(value) {
  return Buffer.from(
    String(value),
    "utf8"
  ).toString(
    "base64"
  );
}

function jsStringFromB64(value) {
  return `Buffer.from('${b64(value)}','base64').toString('utf8')`;
}

function findAnyPath(task) {
  const match =
    String(task || "").match(
      /\b([A-Za-z0-9_.\/\\-]+\.[A-Za-z0-9]{1,10})\b/i
    );

  return match
    ? safeRelativeFile(match[1])
    : null;
}

function findJsPath(task) {
  const file =
    findAnyPath(task);

  return file &&
    /\.(?:mjs|js|cjs)$/i.test(file)
      ? file
      : null;
}

function findPythonPath(task) {
  const file =
    findAnyPath(task);

  return file &&
    /\.py$/i.test(file)
      ? file
      : null;
}

function findJsonPath(task) {
  const file =
    findAnyPath(task);

  return file &&
    /\.json$/i.test(file)
      ? file
      : null;
}

function findTextPath(task) {
  const file =
    findAnyPath(task);

  return file &&
    /\.(?:md|txt|yaml|yml|toml|ini|cfg|conf)$/i.test(file)
      ? file
      : null;
}

function findFunctionName(task) {
  const text =
    String(task || "");

  const patterns = [
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+fonksiyonunun\b/i,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s+fonksiyonu\b/i,
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/i,
    /\bexport(?:ed)?\s+(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\b/i
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (match) {
      const value =
        safeIdentifier(match[1]);

      if (value) return value;
    }
  }

  return null;
}

function findExpectedToken(task) {
  const text =
    String(task || "");

  const patterns = [
    /(?:deÄŸeri|degeri|Ã§Ä±ktÄ±sÄ±|ciktisi|return(?:s| value)?|dÃ¶ndÃ¼rdÃ¼ÄŸÃ¼ deÄŸer|dondurdugu deger)\s+(?:olarak\s+)?["'`]?([A-Za-z0-9_.:-]{1,200})["'`]?\s+(?:yap|olsun|olacak|olarak deÄŸiÅŸtir|olarak degistir)/i,
    /(?:to|equals?|be)\s+["'`]?([A-Za-z0-9_.:-]{1,200})["'`]?(?:\s|$)/i,
    /\b(JEV_[A-Z0-9_]{2,200})\b/
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (match) {
      const value =
        safePrimitiveToken(match[1]);

      if (value) return value;
    }
  }

  return null;
}

function findJsonExpected(task) {
  const text =
    String(task || "");

  const patterns = [
    /(?:deÄŸerini|degerini|alanÄ±nÄ±|alanini|value)\s+(?:olarak\s+)?["'`]?([A-Za-z0-9_.:-]{1,200})["'`]?\s+(?:yap|olsun|olarak deÄŸiÅŸtir|olarak degistir|set)/i,
    /(?:to|=)\s+["'`]?([A-Za-z0-9_.:-]{1,200})["'`]?(?:\s|$)/i,
    /\b(JEV_[A-Z0-9_]{2,200})\b/
  ];

  for (const pattern of patterns) {
    const match =
      text.match(pattern);

    if (match) {
      const value =
        safePrimitiveToken(match[1]);

      if (value) return value;
    }
  }

  return null;
}

const JSON_KEY_STOPWORDS = new Set([
  "dosya",
  "dosyasi",
  "dosyasini",
  "dosyas",
  "n",
  "olustur",
  "olu",
  "tur",
  "icindeki",
  "indeki",
  "degerini",
  "degeri",
  "de",
  "erini",
  "alanini",
  "alan",
  "value",
  "key",
  "field",
  "property",
  "create",
  "file",
  "set",
  "make",
  "change",
  "test",
  "only",
  "apply",
  "yap",
  "uygula"
]);

function findJsonKey(
  task,
  file,
  expected
) {
  const text =
    String(task || "");

  const withoutFile =
    file
      ? text.replace(
          new RegExp(
            file.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            ),
            "i"
          ),
          " "
        )
      : text;

  const directPatterns = [
    /(?:[Ä°IÄ±i]Ã§indeki|[Ä°IÄ±i]cindeki)\s+["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)["'`]?\s+(?:deÄŸerini|degerini|alanÄ±nÄ±|alanini|key(?:'s)? value)/i,
    /\b([A-Za-z_$][A-Za-z0-9_$.-]*)\s+(?:deÄŸerini|degerini|alanÄ±nÄ±|alanini)\b/i,
    /\b(?:key|field|property)\s+["'`]?([A-Za-z_$][A-Za-z0-9_$.-]*)["'`]?/i
  ];

  for (const pattern of directPatterns) {
    const match =
      withoutFile.match(pattern);

    if (match) {
      const value =
        safeDottedKey(match[1]);

      if (value) return value;
    }
  }

  if (!expected) {
    return null;
  }

  const expectedIndex =
    withoutFile.indexOf(expected);

  const beforeExpected =
    expectedIndex >= 0
      ? withoutFile.slice(0, expectedIndex)
      : withoutFile;

  const tokens =
    beforeExpected.match(
      /\b[A-Za-z_$][A-Za-z0-9_$-]*\b/g
    ) || [];

  const candidates =
    tokens.filter(token => {
      const lower =
        token.toLowerCase();

      return (
        !JSON_KEY_STOPWORDS.has(lower) &&
        !/^jev_/i.test(token) &&
        token.length >= 2
      );
    });

  if (!candidates.length) {
    return null;
  }

  const last =
    candidates[
      candidates.length - 1
    ];

  return safeDottedKey(last);
}

function findQuotedExpectedText(task) {
  const text =
    String(task || "");

  const matches =
    [
      ...text.matchAll(
        /["'`]([^"'`\r\n]{1,300})["'`]/g
      )
    ];

  if (!matches.length) {
    return null;
  }

  const value =
    matches[
      matches.length - 1
    ][1];

  if (
    /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)
  ) {
    return null;
  }

  return value;
}

function jsFunctionAcceptance(task) {
  const file =
    findJsPath(task);

  const exportName =
    findFunctionName(task);

  const expected =
    findExpectedToken(task);

  if (
    !file ||
    !exportName ||
    !expected
  ) {
    return null;
  }

  const modulePath =
    "./" + file;

  const expectedExpr =
    jsStringFromB64(expected);

  return {
    derived: true,
    kind: "js_export_zero_arg_returns_primitive",
    file,
    symbol: exportName,
    expected,
    command:
      `node -e "import('${modulePath}').then(m=>{if(typeof m['${exportName}']!=='function')process.exit(2);const e=${expectedExpr};Promise.resolve(m['${exportName}']()).then(v=>process.exit(String(v)===e?0:3)).catch(()=>process.exit(4));}).catch(()=>process.exit(5))"`
  };
}

function pythonFunctionAcceptance(task) {
  const file =
    findPythonPath(task);

  const functionName =
    findFunctionName(task);

  const expected =
    findExpectedToken(task);

  if (
    !file ||
    !functionName ||
    !expected
  ) {
    return null;
  }

  const fileB64 =
    b64(file);

  const expectedB64 =
    b64(expected);

  const py =
    [
      "import base64,importlib.util,sys",
      `p=base64.b64decode('${fileB64}').decode('utf-8')`,
      "s=importlib.util.spec_from_file_location('jev_accept_module',p)",
      "m=importlib.util.module_from_spec(s)",
      "s.loader.exec_module(m)",
      `f=getattr(m,'${functionName}',None)`,
      "sys.exit(2) if not callable(f) else None",
      "v=f()",
      `e=base64.b64decode('${expectedB64}').decode('utf-8')`,
      "sys.exit(0 if str(v)==e else 3)"
    ].join(";");

  return {
    derived: true,
    kind: "python_zero_arg_function_returns_primitive",
    file,
    symbol: functionName,
    expected,
    command: `python -c "${py}"`
  };
}

function jsonValueAcceptance(task) {
  const file =
    findJsonPath(task);

  const expected =
    findJsonExpected(task);

  const key =
    file
      ? findJsonKey(
          task,
          file,
          expected
        )
      : null;

  if (
    !file ||
    !key ||
    !expected
  ) {
    return null;
  }

  const fileExpr =
    jsStringFromB64(file);

  const keyExpr =
    jsStringFromB64(key);

  const expectedExpr =
    jsStringFromB64(expected);

  const command =
    `node -e "const fs=require('fs');const f=${fileExpr};const k=${keyExpr}.split('.');const e=${expectedExpr};let v=JSON.parse(fs.readFileSync(f,'utf8').replace(/^\\uFEFF/,''));for(const p of k){if(v==null||!Object.prototype.hasOwnProperty.call(v,p))process.exit(2);v=v[p];}process.exit(String(v)===e?0:3)"`;

  return {
    derived: true,
    kind: "json_key_equals_primitive",
    file,
    symbol: key,
    expected,
    command
  };
}

function textContainsAcceptance(task) {
  const file =
    findTextPath(task);

  const expected =
    findQuotedExpectedText(task);

  if (
    !file ||
    !expected
  ) {
    return null;
  }

  const fileExpr =
    jsStringFromB64(file);

  const expectedExpr =
    jsStringFromB64(expected);

  const command =
    `node -e "const fs=require('fs');const f=${fileExpr};const e=${expectedExpr};const s=fs.readFileSync(f,'utf8');process.exit(s.includes(e)?0:3)"`;

  return {
    derived: true,
    kind: "text_file_contains_exact_text",
    file,
    expected,
    command
  };
}

export function deriveSafeAcceptance({
  task
}) {
  const strategies = [
    jsFunctionAcceptance,
    pythonFunctionAcceptance,
    jsonValueAcceptance,
    textContainsAcceptance
  ];

  for (const strategy of strategies) {
    const result =
      strategy(task);

    if (result?.derived) {
      return result;
    }
  }

  return {
    derived: false,
    reason:
      "No supported deterministic acceptance pattern matched"
  };
}