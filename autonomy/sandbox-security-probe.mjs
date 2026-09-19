import {
  sanitizedValidationEnv,
  validationSecurityStatus
} from "./sandbox-runner.mjs";

const dummy = {
  PATH:
    process.env.PATH ||
    process.env.Path ||
    "C:\\Windows\\System32",

  USERPROFILE:
    process.env.USERPROFILE ||
    "C:\\Users\\probe",

  TYPESAFE_API_KEY:
    "DO_NOT_LEAK_TYPESAFE",

  JEV_SYNTH_API_KEY:
    "DO_NOT_LEAK_SYNTH",

  OPENAI_API_KEY:
    "DO_NOT_LEAK_OPENAI",

  TEST_PASSWORD:
    "DO_NOT_LEAK_PASSWORD",

  NORMAL_PROJECT_FLAG:
    "SAFE_VALUE"
};

const result =
  sanitizedValidationEnv(
    dummy
  );

const status =
  validationSecurityStatus(
    dummy
  );

const assertions = [
  result.env.TYPESAFE_API_KEY === undefined,
  result.env.JEV_SYNTH_API_KEY === undefined,
  result.env.OPENAI_API_KEY === undefined,
  result.env.TEST_PASSWORD === undefined,
  result.env.NORMAL_PROJECT_FLAG === "SAFE_VALUE",
  result.env.JEV_VALIDATION_ENV_SANITIZED === "1",
  Boolean(result.env.PATH),
  status.removedCount >= 4,
  status.pathPreserved === true
];

if (
  !assertions.every(
    Boolean
  )
) {
  console.error(
    JSON.stringify(
      {
        pass:
          false,

        status
      },
      null,
      2
    )
  );

  process.exit(
    1
  );
}

console.log(
  JSON.stringify(
    {
      pass:
        true,

      envSecretsScrubbed:
        true,

      normalEnvPreserved:
        true,

      pathPreserved:
        true,

      markerPresent:
        true,

      removedCount:
        status.removedCount
    },
    null,
    2
  )
);