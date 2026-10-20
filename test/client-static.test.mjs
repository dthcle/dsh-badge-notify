// Static checks on the client half before release.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

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

const ok = !missingZh.length && !missingEn.length && !bad;
console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===`);
process.exit(ok ? 0 : 1);