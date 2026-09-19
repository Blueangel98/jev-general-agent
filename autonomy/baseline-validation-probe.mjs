import {
  compareProjectTestResults,
  pytestFailureIds
} from "./sandbox-runner.mjs";

const baseline = {
  command: "python -m pytest -q -p no:cacheprovider",
  pass: false,
  status: 1,
  stdout: [
    ".FF",
    "FAILED test_old_a.py::test_a - assert 2 == 3",
    "FAILED test_old_b.py::test_b - NameError: x",
    "2 failed, 1 passed in 0.20s"
  ].join("\n"),
  stderr: ""
};

const unchanged = {
  ...baseline,
  stdout: [
    ".FF",
    "FAILED test_old_a.py::test_a - assert 2 == 3",
    "FAILED test_old_b.py::test_b - NameError: x",
    "2 failed, 1 passed in 0.19s"
  ].join("\n")
};

const improved = {
  ...baseline,
  stdout: [
    "..F",
    "FAILED test_old_a.py::test_a - assert 2 == 3",
    "1 failed, 2 passed in 0.18s"
  ].join("\n")
};

const regressed = {
  ...baseline,
  stdout: [
    ".FFF",
    "FAILED test_old_a.py::test_a - assert 2 == 3",
    "FAILED test_old_b.py::test_b - NameError: x",
    "FAILED test_new.py::test_new - AssertionError",
    "3 failed, 1 passed in 0.21s"
  ].join("\n")
};

const same = compareProjectTestResults(unchanged, baseline);
const better = compareProjectTestResults(improved, baseline);
const worse = compareProjectTestResults(regressed, baseline);

const pass =
  same.pass === true &&
  better.pass === true &&
  worse.pass === false &&
  same.newFailures.length === 0 &&
  better.resolvedFailures.includes("test_old_b.py::test_b") &&
  worse.newFailures.includes("test_new.py::test_new") &&
  pytestFailureIds(baseline).length === 2;

console.log(JSON.stringify({
  pass,
  unchanged: {
    pass: same.pass,
    newFailures: same.newFailures
  },
  improved: {
    pass: better.pass,
    resolvedFailures: better.resolvedFailures
  },
  regressed: {
    pass: worse.pass,
    newFailures: worse.newFailures
  }
}, null, 2));

process.exit(pass ? 0 : 1);