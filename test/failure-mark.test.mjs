// Regression test: a FAILED turn must raise a red mark, never the badge count.
//
// Before this, a failed turn was counted like any completion: it raised the
// numeric badge, which then meant "unread result" and "something broke" at the
// same time, and there was no result to read.
//
// The real module is loaded with extra exports appended, against a THROWAWAY
// data dir so it cannot touch the live %LOCALAPPDATA%\DshBadgeNotify state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "badge-err-test-"));
process.env.LOCALAPPDATA = tmpData;
process.env.APPDATA = tmpData;

const src = fs.readFileSync(
  process.env.BADGE_MODULE || new URL("../lib/index.js", import.meta.url),
  "utf8",
);
const EXPORTS = ["markFailed", "markCompleted", "setClientState", "failed", "completed", "snapshotState", "describeFailure", "pruneFailed"]
  .filter((n) => new RegExp(`(function|const|let)\\s+${n}\\b`).test(src));
const modPath = path.join(tmpData, "index.testable.mjs");
fs.writeFileSync(modPath, src + `\nexport { ${EXPORTS.join(", ")} };\n`, "utf8");
const m = await import("file://" + modPath.replace(/\\/g, "/"));

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  (" + detail + ")" : ""}`) }
}

const MAIN = "session-aaaa1111-2222-3333-4444-555566667777";
const MAIN2 = "session-bbbb1111-2222-3333-4444-555566667777";
const CHILD = "26f47c1e-a0b5-4169-96a7-f3fafbbd5e3f";

console.log("1) a failure is a red mark, NOT a counted completion");
m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
const marked = m.markFailed(MAIN, new Error("codearts: <html>502 Bad Gateway</html>"));
check("markFailed returns true", marked === true);
check("the count did NOT rise", m.snapshotState().completed.count === 0);
check("the failure is reported separately", m.snapshotState().failed.count === 1);
check("failed item names the session", m.snapshotState().failed.items[0].sessionId === MAIN);
check("failed item carries the error text",
  /502 Bad Gateway/.test(m.snapshotState().failed.items[0].text),
  m.snapshotState().failed.items[0].text);

console.log("\n2) a child/background run is not marked");
check("markFailed(child) returns false", m.markFailed(CHILD, "boom") === false);
check("child is absent from failed", m.failed.has(CHILD) === false);

console.log("\n3) a failure while you are watching is not marked");
m.setClientState([MAIN2], [MAIN, MAIN2, CHILD], "ready");
check("markFailed on the open session returns false", m.markFailed(MAIN2, "boom") === false);
check("only the first failure remains", m.snapshotState().failed.count === 1);

console.log("\n4) opening the failed session clears its red mark");
m.setClientState([MAIN], [MAIN, MAIN2, CHILD], "ready");
check("failed count drops to 0", m.snapshotState().failed.count === 0);

console.log("\n5) a later successful turn also clears it");
// The session must be off-screen for the failure to be markable (rule 3).
m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
m.markFailed(MAIN, "first failure");
check("mark re-raised", m.snapshotState().failed.count === 1);
m.markCompleted(MAIN);
check("successful completion clears the failure", m.snapshotState().failed.count === 0);
check("and it counts as a completion", m.snapshotState().completed.count === 1);

console.log("\n6) repeated failures in one session collapse to one mark");
m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
m.markFailed(MAIN, "first");
m.markFailed(MAIN, "second");
check("still one failure", m.snapshotState().failed.count === 1);
check("newest text wins", m.snapshotState().failed.items[0].text === "second");

console.log("\n7) error text extraction");
const cases = [
  [new Error("boom"), "boom"],
  ["plain string", "plain string"],
  [{ message: "obj message" }, "obj message"],
  [{ error: "nested" }, "nested"],
  [null, ""],
];
for (const [input, want] of cases) {
  const got = m.describeFailure ? m.describeFailure(input) : "";
  check(`describeFailure(${JSON.stringify(input)})`, got === want, got);
}
check("very long text is trimmed to 160 chars", (() => {
  m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
  m.markFailed(MAIN, "y".repeat(500));
  const text = m.snapshotState().failed.items[0].text;
  return text.length <= 160 && text.endsWith("...");
})());

console.log("\n8) a failure does NOT expire on a timer");
// The mark must keep reminding you until you deal with it: only opening the
// session or a later successful turn clears it.
check("no pruneFailed() exists (no timer-based expiry)",
  typeof m.pruneFailed !== "function");
check("the module source declares no failure TTL",
  !/failedTtlMs/.test(src));
m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
m.markFailed(MAIN, "still broken");
check("a fresh failure is marked", m.snapshotState().failed.count === 1);
// Simulate the passage of time: the snapshot must still report it.
const far = Date.now() + 365 * 24 * 3600 * 1000;
const realNow = Date.now;
Date.now = () => far;
try {
  m.snapshotState();
  check("still reported after a simulated year", m.snapshotState().failed.count === 1,
    String(m.snapshotState().failed.count));
} finally {
  Date.now = realNow;
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
fs.rmSync(tmpData, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);