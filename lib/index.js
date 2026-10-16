// dsh-badge-notify — host half.
//
// Watches three Host signals and projects them onto the DSH taskbar button:
//   * agent/status            running -> idle   => one more session completed
//   * user-questions/request  (waterfall)       => black dot  (question awaiting reply)
//   * approval/request        (waterfall)       => yellow dot (permission request)
//
// The numbers live in state.json; the overlay process (assets/BadgeNotify.ps1)
// renders them on the taskbar button. The overlay is spawned detached from the
// host process: restarting DSH does not kill it, and it keeps painting the last
// known state.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const name = "badge-notify";
const inject = ["webServer", "systemPrompt"];

const API = "/api/dsh-badge-notify";
const VERSION = "0.6.1";
// Bumped whenever assets/config.json gains or changes keys: the deployed copy is
// then refreshed (previous file kept as config.json.bak) instead of being left
// stale. User edits survive every bump that does not change this number.
const CONFIG_VERSION = 12;

const GUIDANCE =
  "本机已安装 dsh-badge-notify 插件（DSH 任务栏徽标）：它在 Windows 任务栏的 DSH 图标上叠画一个浮层——" +
  "图标右上角是 ChatGPT 风格的黑底白字计数徽标（未读的已完成会话数，与 DSH 侧边栏的绿点同义：" +
  "会话跑完时你没在看它才计数，打开该会话即视为已读并自动减掉），" +
  "图标左边缘自上而下排列提示点（点心落在图标左边缘）：" +
  "黑点=有提问待回答（user-questions/request），黄点=有权限申请待批准（approval/request）。" +
  "位置/配色/尺寸在 %LOCALAPPDATA%\\DshBadgeNotify\\config.json 调整。" +
  "管理路由（仅 loopback POST）：/api/dsh-badge-notify/status|start|stop|clear|read；" +
  "Web GUI 设置 → 插件 → 任务徽标 有状态、启停与清零。用户提到「任务栏徽标/任务提示/气泡计数」时即指本插件。";

// Package root (parent of lib/) — assets/ is a sibling of lib/.
const here = (p) => join(fileURLToPath(new URL("../", import.meta.url)), p);

function deployDir() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA not set");
  return join(local, "DshBadgeNotify");
}

// ---- host log --------------------------------------------------------------
// The Host half runs inside DSH, where a thrown error in apply() would only
// surface as a dead plugin. Everything of consequence is narrated here, and
// SYNCHRONOUSLY: a failure path that needs the event loop to report itself can
// lose the report exactly when the loop is the thing in trouble.
const LOG_MAX_BYTES = 262144;

function logLine(message) {
  try {
    const dir = join(deployDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "host.log");
    try {
      if (statSync(file).size > LOG_MAX_BYTES) rmSync(file, { force: true });
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}\n`, "utf8");
  } catch {
    /* logging must never break the plugin */
  }
}

const debugLog = logLine;
const describe = (error) => (error instanceof Error ? `${error.message}` : String(error));

// ---- state ----------------------------------------------------------------
// completed: sessionId -> completion timestamp (dedupe by session, as asked)
// pending:   key       -> { kind, sessionId, text, at }
const completed = new Map();
const pending = new Map();
const lastStatus = new Map();
// Sessions currently open in the Client's main view, as reported by the browser
// half. DSH's own sidebar treats a completion as "unread" (green dot) only when
// the session is NOT the one you are looking at, and clears the dot as soon as
// you open it. The badge mirrors exactly that, so these ids drive two rules:
//   1. a session that finishes while you are watching it is never counted;
//   2. a session you open after it finished stops being counted.
const viewed = new Set();
// Session ids the Client's list contains (what its sidebar can show), and the
// list's load phase. A completion for an id that is not in `known` can never be
// read by the user, so it must not raise the count.
const known = new Set();
let clientPhase = "";
// When true (default) the badge tracks UNREAD completions, exactly like DSH's
// own green dot: finishing while you watch a session does not count, and opening
// a finished session retires it. Set badge.unreadOnly=false in config.json to
// count every completion instead.
let unreadOnly = true;
// How long an attention mark stays on screen at minimum, even when the request
// it stands for is resolved immediately (see removePending).
let attentionMinVisibleMs = 1500;

const pendingTtlMs = 30 * 60 * 1000;
const maxPending = 12;

function nowMs() {
  return Date.now();
}

function prunePending() {
  const now = nowMs();
  const cutoff = now - pendingTtlMs;
  for (const [key, entry] of pending) {
    if (entry.at < cutoff) {
      pending.delete(key);
      continue;
    }
    // A mark held past its minimum visible time is released here, so the next
    // flush drops it.
    if (entry.holdUntil > 0 && entry.holdUntil <= now) pending.delete(key);
  }
}

function trimText(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function addPending(key, kind, sessionId, text) {
  prunePending();
  pending.set(key, { kind, sessionId, text: trimText(text), at: nowMs(), holdUntil: 0 });
  touchState("addPending");
}

// A request can be answered within milliseconds -- an auto-approver, or a policy
// that fails closed. The overlay polls state.json, so a mark that lives for less
// than one poll is never drawn at all: the yellow dot looked "missing" even
// though the event had been observed (host.log had the pending, the screen had
// nothing). Every mark is therefore held on screen for at least
// attention.minVisibleMs, which is what a notification is for.
function removePending(key) {
  const entry = pending.get(key);
  if (entry === undefined) return;
  const shownFor = nowMs() - entry.at;
  if (entry.holdUntil === 0 && shownFor < attentionMinVisibleMs) {
    entry.holdUntil = nowMs() + (attentionMinVisibleMs - shownFor);
    void debugLog(`pending ${key} resolved after ${shownFor}ms -> held ${attentionMinVisibleMs - shownFor}ms`);
    touchState("holdPending");
    return;
  }
  void debugLog(`pending ${key} resolved after ${shownFor}ms`);
  pending.delete(key);
  touchState("removePending");
}

// True when a held mark is due to be released (the housekeeping tick flushes it).
function hasExpiredHold() {
  const now = nowMs();
  for (const entry of pending.values()) {
    if (entry.holdUntil > 0 && entry.holdUntil <= now) return true;
  }
  return false;
}

function markCompleted(sessionId) {
  const id = String(sessionId);
  // Finishing while the user is looking at this very session is not an unread
  // completion, so it never raises the count (DSH's own dot behaves the same
  // way). `unreadOnly=false` restores plain "count every completion".
  if (!unreadOnly) {
    completed.set(sessionId, nowMs());
    touchState("markCompleted");
    return true;
  }
  if (viewed.has(id)) return false;
  // Only sessions the Client actually lists can ever be READ, so only those may
  // raise the count. A subagent child session (bare UUID, e.g. spawned by the
  // subagent tool) never shows up in the sidebar: counting it produced a number
  // the user could not clear, because there is no dot to click for it.
  if (clientPhase === "ready" && !known.has(id)) {
    void debugLog(`agent/status: ${id} finished but is not listed in the UI -> not counted`);
    return false;
  }
  completed.set(sessionId, nowMs());
  touchState("markCompleted");
  return true;
}

function clearCompleted() {
  completed.clear();
  touchState("clearCompleted");
}

// The Client half reports, on every session-list change:
//   sessionIds - the sessions open in its main view (== "read", DSH's rule)
//   known      - every session id its list contains (== what the sidebar can show)
//   phase      - "pending" while that list is still loading, else "ready"
//
// Both sets replace the previous state (a session that scrolled out of view
// counts again if it finishes later, exactly like DSH's dot).
function setClientState(sessionIds, knownIds, phase) {
  const next = new Set(sessionIds.map((id) => String(id)));
  let added = 0;
  for (const id of next) if (!viewed.has(id)) added++;
  let removed = 0;
  for (const id of viewed) if (!next.has(id)) removed++;
  viewed.clear();
  for (const id of next) viewed.add(id);

  if (Array.isArray(knownIds)) {
    known.clear();
    for (const id of knownIds) known.add(String(id));
  }
  if (typeof phase === "string" && phase !== "") clientPhase = phase;

  // Anything now open has been read: retire its completion.
  let retired = 0;
  for (const id of next) {
    if (completed.delete(id)) retired++;
  }
  // And anything the UI cannot even list can never be read: drop it too, so a
  // subagent's completion cannot pin the count forever.
  if (clientPhase === "ready" && known.size > 0) {
    for (const id of [...completed.keys()]) {
      if (!known.has(id)) {
        completed.delete(id);
        retired++;
        void debugLog(`read: ${id} is not listed in the UI -> retired`);
      }
    }
  }
  if (retired > 0) touchState("setClientState");
  return { viewed: viewed.size, known: known.size, phase: clientPhase, added, removed, retired, completedCount: completed.size };
}

function snapshotState() {
  prunePending();
  const pend = [...pending.values()].sort((a, b) => a.at - b.at);
  return {
    updatedAt: nowMs(),
    version: VERSION,
    completed: { count: completed.size, sessions: [...completed.keys()] },
    pending: {
      count: pend.length,
      questions: pend.filter((p) => p.kind === "question").length,
      approvals: pend.filter((p) => p.kind === "approval").length,
      items: pend.slice(0, maxPending),
    },
  };
}

const STATE_FILE = () => join(deployDir(), "state.json");

// Timer-free persistence, on purpose.
//
// The first revision debounced this through setTimeout and cleared the pending
// timer in the effect cleanup WITHOUT nulling the handle. One dispose landing
// during a pending flush therefore left the shared `flushTimer` truthy forever,
// and every later scheduleFlush() returned early: the count kept rising in
// memory while state.json silently froze on a stale value. A <1 KB synchronous
// write at the moment of change removes that whole failure class.
let stateDirty = false;

function flushStateNow(context) {
  try {
    const dir = deployDir();
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `state.json.tmp${process.pid}`);
    writeFileSync(tmp, JSON.stringify(snapshotState(), null, 2), "utf8");
    renameSync(tmp, STATE_FILE());
    stateDirty = false;
    return true;
  } catch (error) {
    logLine(`flush FAILED (${context}): ${describe(error)}`);
    return false;
  }
}

function touchState(context) {
  stateDirty = true;
  return flushStateNow(context);
}

// ---- stop intent -----------------------------------------------------------
// The boot path brings the overlay up so a fresh install just works. An
// explicit stop (route or settings tab) drops stopped.flag so the next boot
// does not resurrect it against the user's wish; start clears the flag.
const STOP_FLAG = () => join(deployDir(), "stopped.flag");

async function readStopFlag() {
  try {
    await readFile(STOP_FLAG(), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function writeStopFlag() {
  try {
    await mkdir(deployDir(), { recursive: true });
    await writeFile(STOP_FLAG(), "user-stopped", "utf8");
  } catch {
    /* best effort */
  }
}

async function clearStopFlag() {
  try {
    await rm(STOP_FLAG(), { force: true });
  } catch {
    /* best effort */
  }
}

// ---- process discovery ----------------------------------------------------
// Match the launch shape "-File <path>BadgeNotify.ps1" only, so stop() can never
// kill an unrelated process that merely mentions the file name.
const PS_FIND = [
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" |",
  "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-File\\s+\\S*BadgeNotify[.]ps1' -and $_.CommandLine -notmatch 'SelfTest' } |",
  "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }",
].join(" ");

async function findPids() {
  if (process.platform !== "win32") return { pids: [], lines: [] };
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", PS_FIND], {
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
    const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pids = lines.map((l) => Number.parseInt(l, 10)).filter((n) => Number.isInteger(n) && n > 0);
    return { pids, lines };
  } catch {
    return { pids: [], lines: [] };
  }
}

// ---- deploy / start / stop -------------------------------------------------
const RUNTIME_FILES = ["BadgeNotify.ps1"];

// The host half does not otherwise read config.json (the overlay owns it), but
// these two rules are HOST decisions, so they are read here.
function loadHostConfig(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    if (typeof raw?.badge?.unreadOnly === "boolean") unreadOnly = raw.badge.unreadOnly;
    const minVisible = raw?.attention?.minVisibleMs;
    if (Number.isFinite(minVisible) && minVisible >= 0) attentionMinVisibleMs = minVisible;
  } catch {
    /* missing/unparsable config keeps the defaults */
  }
  return { unreadOnly, attentionMinVisibleMs };
}

async function deploy() {
  const dir = deployDir();
  await mkdir(join(dir, "logs"), { recursive: true });
  for (const file of RUNTIME_FILES) {
    const src = here(join("assets", file));
    if (!existsSync(src)) throw new Error(`asset missing: ${file} (resolved: ${src})`);
    await copyFile(src, join(dir, file));
  }
  await deployConfig(dir);
  loadHostConfig(dir);
  flushStateNow("deploy");
  return { dir };
}

// config.json belongs to the user: it is written when missing, and refreshed
// only when the packaged schema version moved on (the old file is kept aside).
async function deployConfig(dir) {
  const src = here(join("assets", "config.json"));
  if (!existsSync(src)) return;
  const dst = join(dir, "config.json");
  let stale = !existsSync(dst);
  if (!stale) {
    try {
      const current = JSON.parse(await readFile(dst, "utf8"));
      stale = (current?.configVersion ?? 0) !== CONFIG_VERSION;
    } catch {
      stale = true;
    }
  }
  if (!stale) return;
  if (existsSync(dst)) {
    try {
      await copyFile(dst, join(dir, "config.json.bak"));
    } catch {
      /* best effort */
    }
  }
  await copyFile(src, dst);
}

async function readDeployedVersion(dir) {
  try {
    const text = await readFile(join(dir, "BadgeNotify.ps1"), "utf8");
    const m = text.match(/\$script:Version = '([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Content hash of the overlay payload at a location, or "" when absent.
async function payloadHash(dir) {
  try {
    const buf = await readFile(join(dir, "BadgeNotify.ps1"));
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

// Kill the overlay. Shared by stop() (user intent) and the payload upgrade path
// (which must NOT record a stop intent).
async function killOverlay() {
  const { pids } = await findPids();
  for (const pid of pids) {
    try {
      await execFileAsync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
        timeout: 15000,
        windowsHide: true,
      });
    } catch {
      /* already gone */
    }
  }
  if (pids.length > 0) await new Promise((r) => setTimeout(r, 800));
  return (await findPids()).pids;
}

async function start() {
  await clearStopFlag();
  const running = await findPids();
  const payloadBefore = await payloadHash(deployDir());
  const { dir } = await deploy();
  const payloadAfter = await payloadHash(dir);
  const stale = running.pids.length > 0 && payloadBefore !== "" && payloadBefore !== payloadAfter;
  await debugLog(
    `start: running=${running.pids.length} payload ${payloadBefore.slice(0, 12) || "(none)"} -> ` +
      `${payloadAfter.slice(0, 12) || "(none)"} stale=${stale} dir=${dir}`,
  );

  if (running.pids.length > 0 && !stale) return { alreadyRunning: true, pids: running.pids };
  // The package shipped a new overlay: replace the running instance so the
  // deployed pixels match the installed code.
  if (stale) await killOverlay();

  if (process.platform !== "win32") throw new Error("the badge overlay is Windows-only");
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  const ps = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { spawn } = await import("node:child_process");
  const { openSync } = await import("node:fs");
  const out = openSync(join(dir, "logs", "overlay.log"), "a");
  // No detached:true: DETACHED_PROCESS and windowsHide's CREATE_NO_WINDOW are
  // mutually hostile CreateProcess flags and the spawn dies silently. On
  // Windows a plain child already outlives its parent.
  const child = spawn(
    ps,
    ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", join(dir, "BadgeNotify.ps1"), "-NoWelcome"],
    { stdio: ["ignore", out, out], windowsHide: true, cwd: dir },
  );
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e.message;
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 3500));
  const after = await findPids();
  await debugLog(`start: spawned pid=${child.pid ?? "?"} running=${after.pids.length} spawnError=${spawnError ?? "none"}`);
  let diag;
  if (after.pids.length === 0) {
    try {
      const text = await readFile(join(dir, "logs", "overlay.log"), "utf8");
      diag = text.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ") || "(overlay.log empty)";
    } catch {
      diag = "(no overlay.log)";
    }
  }
  return { started: after.pids.length > 0, pids: after.pids, spawnError, dir, ...(diag ? { diag } : {}) };
}

async function stop() {
  if (process.platform !== "win32") throw new Error("the badge overlay is Windows-only");
  const left = await killOverlay();
  await writeStopFlag();
  return { stopped: left.length === 0, pids: left };
}

async function status() {
  const { pids } = await findPids();
  const dir = deployDir();
  const state = snapshotState();
  return {
    running: pids.length > 0,
    pids,
    dataDir: dir,
    deployed: existsSync(join(dir, "BadgeNotify.ps1")),
    version: await readDeployedVersion(dir),
    platform: process.platform,
    stopIntent: await readStopFlag(),
    completedCount: state.completed.count,
    completedSessions: state.completed.sessions,
    viewedCount: viewed.size,
    knownCount: known.size,
    clientPhase,
    pendingCount: state.pending.count,
    pending: state.pending.items,
  };
}

// ---- routes ---------------------------------------------------------------
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function writeJson(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const ACTIONS = {
  status,
  start,
  stop,
  clear: async () => {
    const cleared = completed.size;
    clearCompleted();
    return { cleared, completedCount: 0 };
  },
  // The Client half reports which sessions are open in its main view; those
  // completions are "read" and stop being counted (same rule as DSH's own green
  // completion dot).
  read: async (body) => {
    const ids = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
    const knownIds = Array.isArray(body?.known) ? body.known : undefined;
    const result = setClientState(ids, knownIds, body?.phase);
    if (result.retired > 0 || result.added > 0 || result.removed > 0) {
      void debugLog(
        `read: viewed=${result.viewed} known=${result.known} phase=${result.phase} ` +
          `retired=${result.retired} (completed=${result.completedCount})`,
      );
    }
    return result;
  },
};

// POST bodies are tiny JSON objects; anything unparsable is simply "no body".
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function makeRoutes() {
  return Object.entries(ACTIONS).map(([key, fn]) => ({
    kind: "exact",
    path: `${API}/${key}`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
      if ((req.method ?? "POST") !== "POST") return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      try {
        const body = await readBody(req);
        writeJson(res, 200, { result: await fn(body) });
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
}

// NOTE: the overlay is click-through and has no click handling at all, so it
// never writes clear.req. This watcher only exists so a FUTURE interactive
// overlay (or a manual `echo x > clear.req`) can ask for a reset. The count is
// normally cleared via POST /api/dsh-badge-notify/clear or the settings tab.
function startClearWatcher() {
  const timer = setInterval(async () => {
    // Release attention marks whose minimum visible time has elapsed. This tick
    // is the plugin's only recurring timer, so the hold does not add one.
    if (hasExpiredHold()) touchState("holdExpired");
    const flag = join(deployDir(), "clear.req");
    try {
      if (!existsSync(flag)) return;
      await rm(flag, { force: true });
      clearCompleted();
    } catch {
      /* best effort */
    }
  }, 1500);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Timer-free persistence means a failed write (AV lock, transient sharing
// violation) would otherwise stick until the next event. The watchdog retries
// only while the state is known dirty, so it costs one no-op tick otherwise.
function startStateWatchdog() {
  const timer = setInterval(() => {
    if (stateDirty) flushStateNow("watchdog");
  }, 20000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---- event wiring ---------------------------------------------------------
// Waterfall observers must be FIRST in the chain: a later listener may claim
// the request outright, and an observer that never runs would show no dot.
// `prepend` puts us ahead of the composed answerers; if this Cordis build does
// not support the option we fall back to a plain append.
function observe(ctx, event, handler, label) {
  try {
    ctx.on(event, handler, { prepend: true });
    void debugLog(`observe: ${label} registered (prepend)`);
    return true;
  } catch (error) {
    void debugLog(`observe: ${label} prepend rejected (${describe(error)}), retrying plain`);
    try {
      ctx.on(event, handler);
      void debugLog(`observe: ${label} registered (plain)`);
      return false;
    } catch (error2) {
      void debugLog(`observe: ${label} FAILED: ${describe(error2)}`);
      return false;
    }
  }
}

function wireEvents(ctx) {
  ctx.on("agent/status", (payload) => {
    const sessionId = payload?.agent?.id;
    const next = payload?.status;
    if (!sessionId || !next) return;
    const sid = String(sessionId);
    const prev = lastStatus.get(sid);
    lastStatus.set(sid, next);
    // A completed "task" = a session that was running and is now idle. The
    // count only rises when that session is NOT the one the user is viewing.
    if (next === "idle" && prev === "running") {
      const counted = markCompleted(sid);
      void debugLog(
        `agent/status: ${sid} running -> idle (completed=${completed.size}${counted ? "" : ", viewed: not counted"})`,
      );
    }
  });

  observe(
    ctx,
    "approval/request",
    async (req, next) => {
      const sid = req?.agent?.id ? String(req.agent.id) : "?";
      const key = `approval:${sid}:${req?.callId ?? req?.toolName ?? "?"}`;
      addPending(key, "approval", sid, req?.reason ?? req?.toolName);
      void debugLog(`approval/request: ${key} pending=${pending.size}`);
      try {
        return await next();
      } finally {
        removePending(key);
      }
    },
    "approval/request",
  );

  observe(
    ctx,
    "user-questions/request",
    async (req, next) => {
      const sid = req?.agent?.id ? String(req.agent.id) : "?";
      const key = `question:${sid}:${req?.wait?.callId ?? "?"}`;
      const items = Array.isArray(req?.questions) ? req.questions : [];
      const text = items.map((q) => q?.header || q?.question).filter(Boolean).join(" / ");
      addPending(key, "question", sid, text);
      void debugLog(`user-questions/request: ${key} pending=${pending.size}`);
      try {
        return await next();
      } finally {
        removePending(key);
      }
    },
    "user-questions/request",
  );
}

// ---- apply ----------------------------------------------------------------
// Every stage is isolated: one failing stage must never take the overlay down
// with it, and the reason ends up in host.log.
function apply(ctx) {
  if (process.platform !== "win32") {
    void debugLog("apply: skipped (not win32)");
    return;
  }
  void debugLog(`apply: v${VERSION} start`);

  const stage = (label, fn) => {
    try {
      fn();
      void debugLog(`apply: ${label} ok`);
    } catch (error) {
      void debugLog(`apply: ${label} FAILED: ${describe(error)}`);
    }
  };

  stage("wireEvents", () => wireEvents(ctx));

  const disposers = [];
  stage("routes", () => {
    for (const route of makeRoutes()) disposers.push(ctx.webServer.register(route));
  });

  let stopClearWatch = null;
  stage("clearWatcher", () => {
    stopClearWatch = startClearWatcher();
  });

  let stopWatchdog = null;
  stage("stateWatchdog", () => {
    stopWatchdog = startStateWatchdog();
  });

  stage("effect", () =>
    ctx.effect(
      () => () => {
        for (const dispose of disposers) dispose();
        stopClearWatch?.();
        stopWatchdog?.();
      },
      "dsh-badge-notify: routes",
    ),
  );

  stage("guidance", () => ctx.systemPrompt.section({ name: "plugin:dsh-badge-notify", order: 221, text: GUIDANCE }));

  flushStateNow("apply");

  // Boot convenience: a fresh install just works — deploy and bring the overlay
  // up. start() is the single entry point: it refreshes the payload (and
  // restarts a running instance whose payload changed), so this path must run
  // even when something is already painting. An explicit stop is remembered via
  // stopped.flag and is never undone here.
  void (async () => {
    try {
      if (await readStopFlag()) {
        void debugLog("boot: skipped (stopped.flag present)");
        return;
      }
      const result = await start();
      void debugLog(`boot: start -> ${JSON.stringify(result)}`);
    } catch (error) {
      void debugLog(`boot: start FAILED: ${describe(error)}`);
    }
  })();
}

export { apply, inject, name };
