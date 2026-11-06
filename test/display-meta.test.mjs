// The plugin's display title comes from locale/<lang>.json "meta.title", not
// from package.json (verified against @deepseek-ai/dsh-app-boot's
// readPluginMeta: title = localizedText('title', dictionaries, manifest.name)).
//
// That means a missing or malformed locale file silently degrades the label to
// the bare package name, and a locale file that is not shipped in the npm
// tarball degrades it for everyone who installs from npm. Both are cheap to get
// wrong and invisible until someone reads the plugin list, so assert them.
import fs from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  (" + detail + ")" : ""}`);
  }
};

const WANTED_ZH = "任务状态徽标（dsh-badge-notify）";

console.log("1) locale files exist and parse");
const zh = readJson(path.join(root, "locale/zh.json"));
const en = readJson(path.join(root, "locale/en.json"));
check("locale/zh.json parses", zh !== undefined);
check("locale/en.json parses", en !== undefined);

console.log("\n2) titles are present and correct");
check("zh title is the requested label", zh?.meta?.title === WANTED_ZH, zh?.meta?.title);
check("en title exists", typeof en?.meta?.title === "string" && en.meta.title.length > 0, en?.meta?.title);
check("en title carries the package name", /dsh-badge-notify/.test(en?.meta?.title ?? ""));
check(
  "zh title uses FULL-WIDTH parentheses (U+FF08/U+FF09)",
  zh?.meta?.title?.includes("（") === true && zh?.meta?.title?.includes("）") === true,
  zh?.meta?.title,
);
check("descriptions are present", !!zh?.meta?.description && !!en?.meta?.description);

console.log("\n3) the npm package ships locale/ (else the title breaks after install)");
const pkg = readJson(path.join(root, "package.json"));
const files = Array.isArray(pkg?.files) ? pkg.files : [];
check("package.json files[] includes locale", files.includes("locale"), files.join(", "));

console.log("\n4) exports must expose ./locale/*.json");
// THIS is what actually broke the title. readPluginMeta resolves the dictionary
// through the package's own module resolution:
//     optionalResourcePath(`${specifier}/locale/en.json`, parentURL)
// and once `exports` exists, Node refuses every subpath it does not list - so
// the lookup threw, `dictionaries` stayed empty and the title silently fell back
// to the package name. dsh-header-modify works because it declares this subpath.
const exportsField = pkg?.exports ?? {};
const localeExport = Object.keys(exportsField).find((k) => k.startsWith("./locale/"));
check("exports declares a ./locale/*.json subpath", localeExport !== undefined, Object.keys(exportsField).join(", "));

// Prove it by resolving exactly the way the Host does.
const { createRequire } = await import("node:module");
const req = createRequire(path.join(root, "lib/index.js"));
let enResolves = false;
try {
  req.resolve("dsh-badge-notify/locale/en.json");
  enResolves = true;
} catch {
  enResolves = false;
}
check(
  "dsh-badge-notify/locale/en.json is resolvable through exports",
  enResolves,
  "Node refused the subpath - readPluginMeta would fall back to the package name",
);

console.log("\n5) the title differs from the package name");
// If they were equal, readPluginMeta would be falling back - the exact failure
// mode this test exists to catch.
check(
  "locale title is not the bare package name",
  en?.meta?.title !== pkg?.name && zh?.meta?.title !== pkg?.name,
  `name=${pkg?.name}`,
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);