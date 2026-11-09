// Print a one-line Markdown summary of a JUnit XML report (for $GITHUB_STEP_SUMMARY).
// Usage: node scripts/ci/junit-summary.cjs <junit.xml> <label>
const fs = require("node:fs");
const [file, label = "tests"] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.log(`### ${label}: no JUnit report produced`);
  process.exit(0);
}
const xml = fs.readFileSync(file, "utf8");
const count = (re) => (xml.match(re) || []).length;
console.log(`### ${label}: ${count(/<testcase /g)} run, ${count(/<failure/g)} failed, ${count(/<skipped/g)} skipped`);
