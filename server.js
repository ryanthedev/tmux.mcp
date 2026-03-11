import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

const lastRead = new Map();
const commands = new Map();
const PROMPT_PATTERNS = [/[❯$#%>]\s*$/, /^\s*\$\s*$/, /\)\s*[❯$#%>]\s*$/];
const POLL_INTERVAL = 500;
const QUIESCE_TIME = 2000;
const MAX_WAIT = 30000;
const PAGE_SIZE = 10;
const CMD_TTL = 600000; // 10 min

// --- helpers ---

function paginate(text, page = 1, pageSize = PAGE_SIZE) {
  const lines = text.split("\n");
  if (lines.length <= pageSize) return text;
  const totalPages = Math.ceil(lines.length / pageSize);
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * pageSize;
  const slice = lines.slice(start, start + pageSize);
  return `${slice.join("\n")}\n--- page ${p}/${totalPages} (${lines.length} lines) ---${p < totalPages ? `\ntip: pass page:${p + 1} for more` : ""}`;
}

function getActivePane() {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    return execFileSync("tmux", [
      "display-message", "-t", pane, "-p",
      "#{session_name}:#{window_index}.#{pane_index}"
    ], { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function run(...args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function selfHeader() {
  const me = getActivePane();
  if (!me) return "";
  return `you are here: ${me} (session: ${me.split(":")[0]})\n\n`;
}

function isNumericSession(name) {
  return /^\d+$/.test(name);
}

function peekPane(target) {
  const raw = run("capture-pane", "-t", target, "-p", "-S", "-5");
  if (!raw) return "empty";
  const lines = raw.split("\n").filter((l) => l.trim());
  return lines.length > 0 ? lines[lines.length - 1].substring(0, 60) : "empty";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capturePane(target, lines = 100) {
  return run("capture-pane", "-t", target, "-p", "-S", `-${lines}`) || "";
}

function hasPrompt(output) {
  const lastLine = output.split("\n").filter((l) => l.trim()).pop() || "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

function deltaOutput(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lastBefore = beforeLines[beforeLines.length - 1];
  const matchIdx = afterLines.lastIndexOf(lastBefore);
  if (matchIdx >= 0 && matchIdx < afterLines.length - 1) {
    return afterLines.slice(matchIdx + 1).join("\n");
  }
  if (after !== before) return after;
  return "no new output";
}

function detectShell() {
  const shell = process.env.SHELL || "";
  if (shell.includes("fish")) return "fish";
  if (shell.includes("zsh")) return "zsh";
  return "bash";
}

function exitCodeVar() {
  return detectShell() === "fish" ? "$status" : "$?";
}

function cleanupCommands() {
  const now = Date.now();
  for (const [id, cmd] of commands) {
    if (now - cmd.startTime > CMD_TTL) commands.delete(id);
  }
}

// --- actions ---

function listSessions() {
  const raw = run("list-sessions", "-F", "#{session_name}");
  if (!raw) return "error: no tmux sessions";

  const sessions = raw.split("\n");
  const named = [];
  const numbered = [];

  for (const s of sessions) {
    if (isNumericSession(s)) numbered.push(s);
    else named.push(s);
  }

  const out = [selfHeader()];

  for (const session of named) {
    out.push(`${session}/`);
    const windows = run(
      "list-windows", "-t", session, "-F",
      "#{window_index}:#{window_name}:#{window_panes}:#{?window_active,active,}"
    );
    if (!windows) continue;
    for (const w of windows.split("\n")) {
      const [id, name, panes, active] = w.split(":");
      const marker = active === "active" ? " *" : "";
      out.push(`  :${id} ${name} (${panes}p)${marker}`);
    }
  }

  if (numbered.length > 0) {
    const range = numbered.length === 1
      ? numbered[0]
      : `${numbered[0]}-${numbered[numbered.length - 1]}`;
    out.push("", `${numbered.length} unnamed sessions (${range}) — use session action to inspect`);
  }

  out.push("", "tip: use 'session' with target to inspect a specific session with pane previews");
  return out.filter(Boolean).join("\n");
}

function inspectSession(target) {
  const session = target.split(":")[0];
  const windows = run(
    "list-windows", "-t", session, "-F",
    "#{window_index}:#{window_name}:#{window_panes}:#{?window_active,active,}"
  );
  if (!windows) return `error: session '${session}' not found`;

  const out = [selfHeader(), `${session}/`];

  for (const w of windows.split("\n")) {
    const [id, name, panes, active] = w.split(":");
    const marker = active === "active" ? " *" : "";
    out.push(`  :${id} ${name} (${panes}p)${marker}`);
    const paneCount = parseInt(panes);
    for (let p = 0; p < paneCount; p++) {
      const paneTarget = `${session}:${id}.${p}`;
      const preview = peekPane(paneTarget);
      out.push(`    .${p}: ${preview}`);
    }
  }

  return out.filter(Boolean).join("\n");
}

function readPane(target, lines = 100) {
  const output = run("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  if (output === null) return `error: cannot read ${target}`;
  lastRead.set(target, { time: Date.now(), output });
  const count = output.split("\n").length;
  return `${target} (${count} lines)\n---\n${output}\n---\ntip: use watch for delta`;
}

function watchPane(target, lines = 100) {
  const current = run("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  if (current === null) return `error: cannot read ${target}`;

  const prev = lastRead.get(target);
  const now = Date.now();
  lastRead.set(target, { time: now, output: current });

  if (!prev) {
    const count = current.split("\n").length;
    return `${target} (${count} lines, first watch — full output)\n---\n${current}`;
  }

  const prevLines = prev.output.split("\n");
  const currLines = current.split("\n");
  let newLines = [];
  const lastPrevLine = prevLines[prevLines.length - 1];
  const matchIdx = currLines.lastIndexOf(lastPrevLine);

  if (matchIdx >= 0 && matchIdx < currLines.length - 1) {
    newLines = currLines.slice(matchIdx + 1);
  } else if (current !== prev.output) {
    newLines = currLines;
  }

  const elapsed = Math.round((now - prev.time) / 1000);

  if (newLines.length === 0) return `${target}: no new output (${elapsed}s)`;
  return `${target} (+${newLines.length} lines, ${elapsed}s)\n---\n${newLines.join("\n")}`;
}

function sendKeys(target, text) {
  const keys = text.split(" ");
  for (const key of keys) {
    run("send-keys", "-t", target, key);
  }
  return `sent keys to ${target}: ${text}\ntip: watch to see output`;
}

function typeText(target, text) {
  run("send-keys", "-t", target, "-l", text);
  return `typed to ${target}: ${text}\ntip: use send to add Enter or other keys after`;
}

async function waitForOutput(target, before, lines = 100) {
  const start = Date.now();
  let lastOutput = before;
  let lastChangeTime = start;

  while (Date.now() - start < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    const current = capturePane(target, lines);

    if (current !== lastOutput) {
      lastOutput = current;
      lastChangeTime = Date.now();
    }

    if (current !== before && hasPrompt(current)) {
      lastRead.set(target, { time: Date.now(), output: current });
      return `${target} (done, prompt detected)\n---\n${deltaOutput(before, current)}`;
    }

    if (Date.now() - lastChangeTime >= QUIESCE_TIME && current !== before) {
      lastRead.set(target, { time: Date.now(), output: current });
      return `${target} (done, output settled ${QUIESCE_TIME}ms)\n---\n${deltaOutput(before, current)}`;
    }
  }

  const final = capturePane(target, lines);
  lastRead.set(target, { time: Date.now(), output: final });
  return `${target} (timeout ${MAX_WAIT / 1000}s, may still be running)\n---\n${deltaOutput(before, final)}`;
}

async function sendWait(target, text, lines = 100) {
  const before = capturePane(target, lines);
  const keys = text.split(" ");
  for (const key of keys) {
    run("send-keys", "-t", target, key);
  }
  return waitForOutput(target, before, lines);
}

async function typeWait(target, text, lines = 100) {
  const before = capturePane(target, lines);
  run("send-keys", "-t", target, "-l", text);
  run("send-keys", "-t", target, "Enter");
  return waitForOutput(target, before, lines);
}

// --- CRUD ---

function newSession(name) {
  const result = run("new-session", "-d", "-s", name);
  if (result === null) return `error: could not create session '${name}'`;
  return `created session: ${name}`;
}

function killSession(target) {
  const result = run("kill-session", "-t", target);
  if (result === null) return `error: could not kill session '${target}'`;
  return `killed session: ${target}`;
}

function newWindow(target, text) {
  const session = target.split(":")[0];
  const args = ["new-window", "-t", session];
  if (text) args.push("-n", text);
  const result = run(...args);
  if (result === null) return `error: could not create window in '${session}'`;
  return `created window${text ? ` '${text}'` : ""} in ${session}`;
}

function killWindow(target) {
  const result = run("kill-window", "-t", target);
  if (result === null) return `error: could not kill window '${target}'`;
  return `killed window: ${target}`;
}

function splitPane(target, text) {
  const direction = text === "horizontal" ? "-v" : "-h";
  const result = run("split-window", direction, "-t", target);
  if (result === null) return `error: could not split '${target}'`;
  return `split ${target} ${text || "vertical"}`;
}

function killPane(target) {
  const result = run("kill-pane", "-t", target);
  if (result === null) return `error: could not kill pane '${target}'`;
  return `killed pane: ${target}`;
}

function renameWindow(target, text) {
  const result = run("rename-window", "-t", target, text);
  if (result === null) return `error: cannot rename ${target}`;
  return `renamed ${target} -> ${text}`;
}

// --- command tracking ---

function execCommand(target, text) {
  cleanupCommands();
  const id = randomUUID().slice(0, 8);
  const startMarker = `TMUX_MCP_START_${id}`;
  const doneMarker = `TMUX_MCP_DONE_${id}`;
  const ecv = exitCodeVar();

  // echo start marker, run command, echo done marker with exit code
  const wrapped = `echo ${startMarker}; ${text}; echo ${doneMarker}_${ecv}`;

  run("send-keys", "-t", target, "-l", wrapped);
  run("send-keys", "-t", target, "Enter");

  commands.set(id, {
    target,
    command: text,
    startMarker,
    doneMarker,
    startTime: Date.now(),
  });

  return `exec ${id}: ${text}\ntarget: ${target}\ntip: use result with commandId:${id} to check output`;
}

function getResult(commandId) {
  cleanupCommands();
  const cmd = commands.get(commandId);
  if (!cmd) return `error: command '${commandId}' not found (expired after 10min?)`;

  const output = capturePane(cmd.target, 500);
  const lines = output.split("\n");

  const startIdx = lines.findIndex((l) => l.includes(cmd.startMarker));
  if (startIdx === -1) return `${commandId}: waiting (start marker not yet visible)`;

  // look for done marker
  const donePattern = new RegExp(`${cmd.doneMarker}_(\\d+)`);
  let exitCode = null;
  let doneIdx = -1;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(donePattern);
    if (match) {
      exitCode = parseInt(match[1]);
      doneIdx = i;
      break;
    }
  }

  if (doneIdx === -1) {
    // still running — show what we have so far
    const partial = lines.slice(startIdx + 1).join("\n").trim();
    const elapsed = Math.round((Date.now() - cmd.startTime) / 1000);
    return `${commandId}: running (${elapsed}s)\ncmd: ${cmd.command}\n---\n${partial || "(no output yet)"}`;
  }

  // done — extract output between markers
  const cmdOutput = lines.slice(startIdx + 1, doneIdx).join("\n").trim();
  const elapsed = Math.round((Date.now() - cmd.startTime) / 1000);

  return `${commandId}: done (${elapsed}s, exit ${exitCode})\ncmd: ${cmd.command}\n---\n${cmdOutput || "(no output)"}`;
}

function getLayout() {
  const raw = run(
    "list-panes", "-a", "-F",
    "#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} #{?pane_active,active,} #{pane_current_command}"
  );
  if (!raw) return "error: no panes";

  const out = [selfHeader()];

  for (const line of raw.split("\n")) {
    const [target, size, active, cmd] = line.split(" ");
    const marker = active === "active" ? " *" : "";
    out.push(`${target} ${size} ${cmd}${marker}`);
  }

  return out.filter(Boolean).join("\n");
}

// --- help ---

const HELP_TEXT = `tmux actions:
  list                overview of all sessions (unnamed ones summarized)
  session target      inspect one session with pane previews
  read  target        capture pane output (lines: history depth, default 100)
  watch target        new output since last read (delta)
  send  target text   key sequences (space-separated tokens)
  type  target text   literal text (preserves spaces)
  sendwait target text  send keys + wait for output
  typewait target text  type literal text + Enter, wait for output
  exec  target text   run command with tracking (returns commandId)
  result commandId    check tracked command output + exit code
  new-session text    create session (text = name)
  kill-session target kill a session
  new-window target   create window (target = session, text = optional name)
  kill-window target  kill a window
  split target        split pane (text = horizontal|vertical, default vertical)
  kill-pane target    kill a pane
  rename target text  rename a window
  layout              all panes with sizes and commands

target format: session:window.pane (e.g. main:0.0)
call any action without required params for help`;

const HELP_ACTIONS = {
  session: "session: inspect one session with pane previews\n  params: target (session name)\n  example: action:session target:main",
  read: "read: capture pane output\n  params: target (session:win.pane), lines (default 100)\n  example: action:read target:main:0.0",
  watch: "watch: delta since last read\n  params: target (session:win.pane), lines (default 100)\n  example: action:watch target:main:0.0",
  send: `send: key sequences (space-separated tokens)
  params: target (session:win.pane), text (keys)
  Enter is NOT auto-appended
  examples:
    shell command:  text:"ls -la Enter"
    interrupt:      text:"C-c"
    TUI navigation: text:"Down Down Enter"
    vim quit:       text:"Escape :q! Enter"
  special keys: Enter, Escape, Space, Tab, Up, Down, Left, Right, C-c, C-d, C-z, BSpace`,
  type: `type: literal text (preserves spaces, no Enter appended)
  params: target (session:win.pane), text (literal string)
  example: action:type target:main:0.0 text:Hello, how are you?
  tip: follow with send Enter if needed`,
  sendwait: `sendwait: send key tokens + wait for completion
  params: target (session:win.pane), text (space-separated keys), lines (default 100)
  waits up to 30s. detects shell prompt or output quiesce (2s stable)
  example: action:sendwait target:main:0.0 text:npm test Enter`,
  typewait: `typewait: type literal text + Enter, wait for completion
  params: target (session:win.pane), text (literal string), lines (default 100)
  example: action:typewait target:main:0.0 text:echo "hello world"`,
  exec: `exec: run command with marker-based tracking
  params: target (session:win.pane), text (command to run)
  returns a commandId — use 'result' action to check status/output/exit code
  better than sendwait for long-running commands
  example: action:exec target:main:0.0 text:npm test`,
  result: `result: check tracked command status
  params: commandId (from exec response)
  returns: status (running/done), exit code, output
  commands expire after 10 min
  example: action:result commandId:a1b2c3d4`,
  "new-session": "new-session: create a new tmux session\n  params: text (session name)\n  example: action:new-session text:my-project",
  "kill-session": "kill-session: kill a session\n  params: target (session name)\n  example: action:kill-session target:old-project",
  "new-window": "new-window: create a window\n  params: target (session), text (optional window name)\n  example: action:new-window target:main text:dev-server",
  "kill-window": "kill-window: kill a window\n  params: target (session:window)\n  example: action:kill-window target:main:3",
  split: "split: split a pane\n  params: target (session:win.pane), text (horizontal|vertical, default vertical)\n  example: action:split target:main:0.0 text:horizontal",
  "kill-pane": "kill-pane: kill a pane\n  params: target (session:win.pane)\n  example: action:kill-pane target:main:0.1",
  rename: "rename: rename a window\n  params: target (session:win), text (new name)\n  example: action:rename target:main:0 text:dev-server",
};

// --- dispatch ---

async function dispatch(action, target, text, lines, commandId) {
  if (!action) {
    return selfHeader() + HELP_TEXT;
  }

  switch (action) {
    case "list":
      return listSessions();
    case "session":
      if (!target) return HELP_ACTIONS.session;
      return inspectSession(target);
    case "read":
      if (!target) return HELP_ACTIONS.read;
      return readPane(target, lines);
    case "watch":
      if (!target) return HELP_ACTIONS.watch;
      return watchPane(target, lines);
    case "send":
      if (!target || !text) return HELP_ACTIONS.send;
      return sendKeys(target, text);
    case "type":
      if (!target || !text) return HELP_ACTIONS.type;
      return typeText(target, text);
    case "sendwait":
      if (!target || !text) return HELP_ACTIONS.sendwait;
      return await sendWait(target, text, lines);
    case "typewait":
      if (!target || !text) return HELP_ACTIONS.typewait;
      return await typeWait(target, text, lines);
    case "exec":
      if (!target || !text) return HELP_ACTIONS.exec;
      return execCommand(target, text);
    case "result":
      if (!commandId) return HELP_ACTIONS.result;
      return getResult(commandId);
    case "new-session":
      if (!text) return HELP_ACTIONS["new-session"];
      return newSession(text);
    case "kill-session":
      if (!target) return HELP_ACTIONS["kill-session"];
      return killSession(target);
    case "new-window":
      if (!target) return HELP_ACTIONS["new-window"];
      return newWindow(target, text);
    case "kill-window":
      if (!target) return HELP_ACTIONS["kill-window"];
      return killWindow(target);
    case "split":
      if (!target) return HELP_ACTIONS.split;
      return splitPane(target, text);
    case "kill-pane":
      if (!target) return HELP_ACTIONS["kill-pane"];
      return killPane(target);
    case "rename":
      if (!target || !text) return HELP_ACTIONS.rename;
      return renameWindow(target, text);
    case "layout":
      return getLayout();
    default:
      return `unknown action: ${action}\n\n${HELP_TEXT}`;
  }
}

// --- server ---

const ALL_ACTIONS = [
  "list", "session", "read", "watch",
  "send", "type", "sendwait", "typewait",
  "exec", "result",
  "new-session", "kill-session", "new-window", "kill-window",
  "split", "kill-pane",
  "rename", "layout",
];

const server = new McpServer({ name: "tmux", version: "0.2.0" });

server.tool(
  "tmux",
  "Tmux control. Call with no args for usage.",
  {
    action: z.enum(ALL_ACTIONS).optional(),
    target: z.string().optional(),
    text: z.string().optional(),
    lines: z.number().optional(),
    page: z.number().optional(),
    pageSize: z.number().optional(),
    commandId: z.string().optional(),
  },
  async ({ action, target, text, lines, page, pageSize, commandId }) => {
    const result = await dispatch(action, target, text, lines, commandId);
    return { content: [{ type: "text", text: paginate(result, page, pageSize) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
