/*
 * Premiere MCP Bridge - UXP panel.
 * Connects to the local MCP server over WebSocket, runs the JavaScript it sends
 * inside Premiere Pro (with the `premierepro` module), and returns the result.
 * All tool logic lives in the server, so this panel rarely needs updating.
 */
const ppro = require("premierepro");
const uxp = require("uxp");

const PLUGIN_VERSION = "0.1.0";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const el = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};

let ws = null;
let retryTimer = null;
let manualClose = false;

function log(msg, cls) {
  const box = el("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  box.appendChild(line);
  while (box.childNodes.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function setStatus(state, text) {
  el("dot").className = state === "on" ? "on" : state === "wait" ? "wait" : "";
  el("status").textContent = text;
}

// Make Premiere objects JSON friendly: TickTime -> seconds, Guid -> string.
function replacer(_key, value) {
  if (value && typeof value === "object") {
    if ("seconds" in value && "ticks" in value) return value.seconds;
    if (typeof value.toString === "function" && value.constructor && value.constructor.name === "Guid") {
      return value.toString();
    }
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj === undefined ? null : obj, replacer);
  } catch (e) {
    return JSON.stringify({ unserializable: String(obj), error: String(e) });
  }
}

async function runCommand(msg) {
  const logs = [];
  const userLog = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : safeStringify(x))).join(" "));
  const started = Date.now();
  try {
    const fn = new AsyncFunction("ppro", "uxp", "log", msg.code);
    const result = await fn(ppro, uxp, userLog);
    const payload = `{"type":"result","id":${JSON.stringify(msg.id)},"ok":true,"result":${safeStringify(result)},"logs":${JSON.stringify(logs)}}`;
    ws.send(payload);
    log(`ok ${msg.label || msg.id} (${Date.now() - started} ms)`, "ok");
  } catch (err) {
    const error = (err && (err.stack || err.message)) || String(err);
    ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error, logs }));
    log(`error ${msg.label || msg.id}: ${err && err.message ? err.message : err}`, "err");
  }
}

function scheduleRetry() {
  if (retryTimer || manualClose || !el("auto").checked) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 3000);
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const port = (el("port").value || "8765").trim();
  // "localhost", not 127.0.0.1: UXP's network permission check matches host names more reliably than IPs.
  const url = `ws://localhost:${port}`;
  store.set("port", port);
  store.set("token", el("token").value || "");
  setStatus("wait", `Connecting to ${url}...`);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setStatus("off", "Cannot open socket");
    log(String(e), "err");
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello",
      plugin: PLUGIN_VERSION,
      token: el("token").value || "",
      host: uxp.host ? { name: uxp.host.name, version: uxp.host.version } : null,
    }));
  };
  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (msg.type === "welcome") {
      setStatus("on", `Connected (server ${msg.server || "?"})`);
      log("Connected to MCP server", "ok");
    } else if (msg.type === "rejected") {
      setStatus("off", "Rejected: " + (msg.reason || "bad token"));
      log("Rejected by server: " + (msg.reason || ""), "err");
      manualClose = true;
      ws.close();
    } else if (msg.type === "run") {
      runCommand(msg);
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  };
  ws.onclose = () => {
    setStatus("off", "Disconnected - is the MCP server running?");
    scheduleRetry();
  };
  ws.onerror = () => { /* onclose follows */ };
}

el("port").value = store.get("port", "8765");
el("token").value = store.get("token", "");
el("connect").addEventListener("click", () => {
  manualClose = false;
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
  ws = null;
  setTimeout(connect, 200);
});
el("auto").addEventListener("change", () => { if (el("auto").checked) { manualClose = false; scheduleRetry(); } });

connect();
