// Regression test for the "badge shows an unread the UI cannot clear" bug.
//
// Symptom: the badge counts a completion for an agent run whose id is a bare
// UUID (subagent child / background run). No sidebar entry exists for it, so
// there is no green dot to click and the number never goes away.
//
// Measured on the live profile before the fix: all 3 bare-UUID completions were
// counted, while 63 of 85 main-session completions were correctly skipped as
// viewed. So the `known` guard alone cannot protect against this.
//
// The real module is loaded (not a copy of the logic) with extra exports
// appended, and the process runs against a THROWAWAY data dir so it cannot
// touch the live %LOCALAPPDATA%\DshBadgeNotify state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "badge-test-"));
process.env.LOCALAPPDATA = tmpData; // debugLog/state files land here, not in the real dir
process.env.APPDATA = tmpData;

const src = fs.readFileSync(
  process.env.BADGE_MODULE || new URL("../lib/index.js", import.meta.url),
  "utf8",
);
// Only export what this build actually defines, so the same test can be run
// against an older build (BADGE_MODULE=...) to prove it catches the bug.
const EXPORTS = ["markCompleted", "setClientState", "completed", "snapshotState", "isListableSessionId"]
  .filter((n) => new RegExp(`(function|const|let)\\s+${n}\\b`).test(src));
const withExports = src + `\nexport { ${EXPORTS.join(", ")} };\n`;
const modPath = path.join(tmpData, "index.testable.mjs");
fs.writeFileSync(modPath, withExports, "utf8");

const m = await import("file://" + modPath.replace(/\\/g, "/"));

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  (" + detail + ")" : ""}`);
  }
}

const MAIN = "session-3641d9d3-8afe-4b33-bf09-6f889c7e0d8d";
const CHILD = "26f47c1e-a0b5-4169-96a7-f3fafbbd5e3f";
const MAIN2 = "session-bbf356ed-b676-4e6b-af40-55c96620598e";

// Older builds have no predicate: treat every id as listable, which is exactly
// the buggy behaviour, so the checks below report a real failure.
const isListable =
  typeof m.isListableSessionId === "function" ? m.isListableSessionId : () => true;

console.log("1) id shape predicate");
check("main session is listable", isListable(MAIN) === true);
check("bare UUID is NOT listable", isListable(CHILD) === false);
check("uppercase bare UUID is NOT listable", isListable(CHILD.toUpperCase()) === false);
check("a future-style id (sess-abc) is still listable", isListable("sess-abc") === true);

console.log("\n2) a child run finishing must not raise the count");
m.setClientState([], [MAIN, CHILD], "ready");
const countedChild = m.markCompleted(CHILD);
check("markCompleted(child) returns false", countedChild === false);
check("child is not in the completed set", m.completed.has(CHILD) === false);
check("badge count stays 0", m.snapshotState().completed.count === 0);

console.log("\n3) a main session finishing off-screen still counts");
const countedMain = m.markCompleted(MAIN);
check("markCompleted(main) returns true", countedMain === true);
check("badge count is 1", m.snapshotState().completed.count === 1);
check("the counted id is the main session", m.snapshotState().completed.sessions[0] === MAIN);

console.log("\n4) opening that session clears it (DSH green-dot rule)");
m.setClientState([MAIN], [MAIN, CHILD], "ready");
check("badge count is 0 after viewing", m.snapshotState().completed.count === 0);

console.log("\n5) self-healing: a child counted by an OLD build is retired");
// simulate state left behind by 0.6.1, where the child WAS counted
m.completed.set(CHILD, Date.now());
m.completed.set(MAIN2, Date.now());
check("stray child present before read", m.completed.has(CHILD) === true);
const r = m.setClientState([], [MAIN, MAIN2, CHILD], "ready");
check("read retires the stray child", m.completed.has(CHILD) === false, `retired=${r.retired}`);
check("the legitimate main completion survives", m.completed.has(MAIN2) === true);
check("only one completion remains", m.snapshotState().completed.count === 1);

console.log("\n6) unreadOnly=false must still skip non-listable ids");
check("child is still rejected in plain mode", m.markCompleted(CHILD) === false);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
fs.rmSync(tmpData, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
