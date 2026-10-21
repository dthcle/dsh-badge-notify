// Regression test: a completion must raise the badge when the DSH window is not
// in the foreground, even for the session that is open behind the covering
// window.
//
// Before this fix the plugin mirrored DSH's dot rule exactly ("open in the main
// view == read"), so covering the DSH window left the session counted as read:
// the completion raised neither DSH's dot nor the badge.
//
// The real module is loaded (not a copy of the logic): lib/client.js is a plain
// script for the browser loader, so a stubbed `window.__ModuleLoader__` is
// installed first and the exports are appended to a throwaway copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

globalThis.window = { __ModuleLoader__: { load() {} } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "badge-client-test-"));
const src = fs.readFileSync(
  process.env.BADGE_CLIENT || new URL("../lib/client.js", import.meta.url),
  "utf8",
);
const EXPORTS = ["deriveReadState", "isForeground"].filter((n) =>
  new RegExp(`function\\s+${n}\\b`).test(src),
);
const modPath = path.join(tmp, "client.testable.mjs");
fs.writeFileSync(modPath, src + `\nexport { ${EXPORTS.join(", ")} };\n`, "utf8");
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

// Old builds have no foreground notion: report every open session as read,
// which is exactly the buggy behaviour, so the checks below really fail.
const derive =
  typeof m.deriveReadState === "function"
    ? m.deriveReadState
    : (snap) => {
        const byId = (snap && snap.byId) || {};
        return {
          open: Object.keys(byId).filter((id) => (byId[id]?.retainedBy?.mainView || 0) > 0),
          known: Object.keys(byId),
          phase: (snap && snap.phase) || "",
        };
      };

const OPEN = "session-open-main-view";
const OTHER = "session-open-elsewhere";
const CHILD = "26f47c1e-a0b5-4169-96a7-f3fafbbd5e3f";
const SNAP = {
  phase: "ready",
  byId: {
    [OPEN]: { retainedBy: { mainView: 1 } },
    [OTHER]: { retainedBy: { mainView: 0 } },
    [CHILD]: { retainedBy: {} },
  },
};

console.log("1) foreground: only the session open in the main view is 'read'");
const fg = derive(SNAP, true);
check("open set is exactly the main-view session", JSON.stringify(fg.open) === JSON.stringify([OPEN]), JSON.stringify(fg.open));
check("known lists every session the list can show", fg.known.length === 3);
check("phase is passed through", fg.phase === "ready");

console.log("\n2) background: NOTHING counts as read (the reported bug)");
const bg = derive(SNAP, false);
check("no session is treated as read while covered", bg.open.length === 0, JSON.stringify(bg.open));
check("known is unaffected by foreground", bg.known.length === 3);
check("phase is unaffected by foreground", bg.phase === "ready");

console.log("\n3) nothing open, foreground: still an empty open set");
check("empty snapshot yields no open sessions", derive({ byId: {} }, true).open.length === 0);
check("missing snapshot does not throw", (() => {
  try { derive(undefined, true); return true } catch (e) { return false }
})());

console.log("\n4) isForeground()");
const realDoc = globalThis.document;
const setDoc = (v) => { globalThis.document = v };
const delDoc = () => { delete globalThis.document };
try {
  if (typeof m.isForeground === "function") {
    setDoc({ visibilityState: "hidden", hasFocus: () => true });
    check("hidden page is not foreground", m.isForeground() === false);
    setDoc({ visibilityState: "visible", hasFocus: () => false });
    check("visible but unfocused page is not foreground", m.isForeground() === false);
    setDoc({ visibilityState: "visible", hasFocus: () => true });
    check("visible and focused page is foreground", m.isForeground() === true);
    delDoc();
    check("no document (node/SSR) counts as foreground", m.isForeground() === true);
    setDoc({ get visibilityState() { throw new Error("boom") } });
    check("a throwing check counts as foreground", m.isForeground() === true);
  } else {
    check("isForeground exists", false, "old build has no foreground notion");
  }
} finally {
  if (realDoc === undefined) delDoc(); else setDoc(realDoc);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);