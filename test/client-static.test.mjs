// Static checks on the client half before release.
import fs from "node:fs";

const src = fs.readFileSync(
  process.env.BADGE_CLIENT || new URL("../lib/client.js", import.meta.url),
  "utf8",
);

const used = [...new Set([...src.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]))].sort();

const zhBlock = src.match(/zh:\s*\{([\s\S]*?)\n    \},/)[1];
const enBlock = src.match(/en:\s*\{([\s\S]*?)\n    \},/)[1];
const keysOf = (block) =>
  new Set([...block.matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
const zh = keysOf(zhBlock);
const en = keysOf(enBlock);

const missingZh = used.filter((k) => !zh.has(k));
const missingEn = used.filter((k) => !en.has(k));
const onlyZh = [...zh].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !zh.has(k));

console.log("locale keys used :", used.join(", "));
console.log("missing in zh    :", missingZh.length ? missingZh.join(", ") : "none");
console.log("missing in en    :", missingEn.length ? missingEn.join(", ") : "none");
console.log("only in zh       :", onlyZh.length ? onlyZh.join(", ") : "none");
console.log("only in en       :", onlyEn.length ? onlyEn.join(", ") : "none");

const css = src.match(/const DBN_CSS = `([\s\S]*?)`/)[1];
const literals = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]))];
console.log("\nliteral colours left in CSS:", literals.length ? literals.join(", ") : "none");

const tokenRefs = [...new Set([...css.matchAll(/var\((--dsw-alias-[a-z0-9-]+)\)/g)].map((m) => m[1]))];
console.log("theme tokens used        :", tokenRefs.length);
for (const tk of tokenRefs.sort()) console.log("   ", tk);

const bad = src.includes("dsh-client-ui-primitives") || /require\('@deepseek-ai\//.test(src);
console.log("\nimports a Harness Client package:", bad ? "YES (forbidden)" : "no");

// Class names used by the component must exist in the stylesheet, and vice
// versa: renaming a class in the CSS while a stale name stays in the JSX is
// silent (the element just loses its styling).
const jsPart = src.replace(css, "");
const usedClasses = new Set(
  [...jsPart.matchAll(/'([^']*\bdbn-[a-z0-9- ]*)'/g)].flatMap((m) => m[1].split(/\s+/)),
);
const definedClasses = new Set([...css.matchAll(/\.(dbn-[a-z0-9-]+)/g)].map((m) => m[1]));
const undefinedClasses = [...usedClasses].filter((c) => c && !definedClasses.has(c));
const unusedClasses = [...definedClasses].filter((c) => !usedClasses.has(c));
console.log("\nclasses used in JS not in CSS:", undefinedClasses.length ? undefinedClasses.join(", ") : "none");
console.log("classes defined in CSS, unused:", unusedClasses.length ? unusedClasses.join(", ") : "none");

const ok =
  !missingZh.length && !missingEn.length && !bad && !undefinedClasses.length;
console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
process.exit(ok ? 0 : 1);