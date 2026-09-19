import { deriveSafeAcceptance } from "./acceptance-deriver.mjs";

const tasks = [
  "config/acceptance-probe.json dosyasÄ±nÄ± oluÅŸtur. Ä°Ã§indeki status deÄŸerini JEV_JSON_ACCEPTANCE_OK yap. DeÄŸiÅŸikliÄŸi test et ve yalnÄ±z doÄŸrulanÄ±rsa uygula.",
  "config/acceptance-probe.json dosyasÃ„Â±nÃ„Â± oluÃ…Å¸tur. Ã„Â°ÃƒÂ§indeki status deÃ„Å¸erini JEV_JSON_ACCEPTANCE_OK yap. DeÃ„Å¸iÃ…Å¸ikliÃ„Å¸i test et ve yalnÃ„Â±z doÃ„Å¸rulanÃ„Â±rsa uygula.",
  "Create config/acceptance-probe.json and set field status to JEV_JSON_ACCEPTANCE_OK.",
  "Create config/acceptance-probe.json and set field status to JEV_JSON_ACCEPTANCE_OK!",
  "Create config/acceptance-probe.json and set field status to JEV_JSON_ACCEPTANCE_OK"
];

const results =
  tasks.map(
    task => {
      const derived =
        deriveSafeAcceptance({ task });

      return {
        derived:
          derived.derived === true,

        kind:
          derived.kind || null,

        file:
          derived.file || null,

        key:
          derived.symbol || null,

        expected:
          derived.expected || null
      };
    }
  );

const pass =
  results.every(
    result =>
      result.derived &&
      result.kind === "json_key_equals_primitive" &&
      result.file === "config/acceptance-probe.json" &&
      result.key === "status" &&
      result.expected === "JEV_JSON_ACCEPTANCE_OK"
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

process.exit(pass ? 0 : 1);