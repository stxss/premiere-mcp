// WebSocket bridge between the MCP server and the Premiere Pro UXP panel.
//
// Several copies of this server can run at once (Claude Desktop may start more than one,
// or Claude Desktop + Claude Code). Only one can own the port:
//   - PRIMARY: owns ws://localhost:<port> (127.0.0.1 and ::1). The Premiere panel connects here.
//   - RELAY:   any other copy. It connects to the primary as a client and sends its commands
//              through it. If the primary goes away, a relay takes over the port.
// Nothing listens on a network interface; only loopback.
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { config, SERVER_VERSION } from "./config.js";

const RETRY_MS = 3000;

function listenOn(host, port) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port });
    const onError = (err) => { wss.removeListener("listening", onListening); reject(err); };
    const onListening = () => { wss.removeListener("error", onError); resolve(wss); };
    wss.once("error", onError);
    wss.once("listening", onListening);
  });
}

export class PremiereBridge {
  constructor() {
    this.role = "starting";
    this.client = null; // primary: the Premiere panel socket
    this.clientInfo = null;
    this.cep = null; // primary: the CEP "MCP QE Helper" socket (ExtendScript / QE DOM)
    this.cepInfo = null;
    this.pending = new Map(); // id -> {resolve,reject,timer}
    this.relays = new Set(); // primary: connected relay sockets
    this.relayRoutes = new Map(); // primary: panel request id -> {socket, id}
    this.servers = [];
    this.upstream = null; // relay: socket to the primary
    this.upstreamPanel = null; // relay: panel info as reported by the primary
    this.lastError = null;
  }

  start() {
    this.#become();
    setInterval(() => {
      if (this.client && this.client.readyState === 1) this.client.send(JSON.stringify({ type: "ping" }));
      if (this.cep && this.cep.readyState === 1) this.cep.send(JSON.stringify({ type: "ping" }));
    }, 20000).unref();
  }

  async #become() {
    try {
      const v4 = await listenOn("127.0.0.1", config.port);
      this.servers = [v4];
      try { this.servers.push(await listenOn("::1", config.port)); } catch (e) {
        if (!["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(e.code)) {
          console.error(`[premiere-mcp] note: could not also listen on [::1]:${config.port} (${e.code})`);
        }
      }
      for (const wss of this.servers) {
        wss.on("connection", (socket) => this.#onConnection(socket));
        wss.on("error", (err) => { this.lastError = err.message; });
      }
      this.role = "primary";
      this.lastError = null;
      console.error(`[premiere-mcp] waiting for Premiere panel on ws://localhost:${config.port}`);
    } catch (err) {
      if (err.code !== "EADDRINUSE") {
        this.lastError = err.message;
        console.error(`[premiere-mcp] cannot listen on port ${config.port}: ${err.message}`);
        setTimeout(() => this.#become(), RETRY_MS * 3).unref();
        return;
      }
      this.#connectUpstream();
    }
  }

  // ---------- relay mode ----------
  #connectUpstream() {
    this.role = "relay";
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
    let welcomed = false;
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role: "relay", token: config.token, server: SERVER_VERSION })));
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "welcome") {
        welcomed = true;
        this.upstream = ws;
        this.upstreamPanel = msg.panel || null;
        this.upstreamCep = msg.cep || null;
        this.lastError = null;
        console.error(`[premiere-mcp] port ${config.port} is owned by another copy; relaying through it`);
      } else if (msg.type === "panel") {
        this.upstreamPanel = msg.panel || null;
        this.upstreamCep = msg.cep || null;
      } else if (msg.type === "rejected") {
        this.lastError = `the copy owning port ${config.port} rejected this one (${msg.reason})`;
      } else if (msg.type === "result") {
        this.#settle(msg);
      }
    });
    ws.on("error", (err) => { this.lastError = `port ${config.port} is in use and is not answering as a Premiere MCP (${err.code || err.message})`; });
    ws.on("close", () => {
      if (this.upstream === ws) this.upstream = null;
      this.upstreamPanel = null;
      this.#failAll(welcomed ? "The server copy that talks to Premiere went away while running the command" : null);
      // Primary gone (or never answered): try to take the port ourselves, else reconnect.
      setTimeout(() => this.#become(), RETRY_MS).unref();
    });
  }

  // ---------- primary mode ----------
  #onConnection(socket) {
    let kind = null;
    const helloTimer = setTimeout(() => { if (!kind) socket.close(); }, 5000);
    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        if (config.token && msg.token !== config.token) {
          socket.send(JSON.stringify({ type: "rejected", reason: "token mismatch" }));
          socket.close();
          return;
        }
        if (msg.role === "relay") {
          kind = "relay";
          this.relays.add(socket);
          socket.send(JSON.stringify({ type: "welcome", server: SERVER_VERSION, panel: this.isConnected() ? this.clientInfo : null, cep: this.isCepConnected() ? this.cepInfo : null }));
          return;
        }
        if (msg.role === "cep") {
          kind = "cep";
          if (this.cep && this.cep !== socket) { try { this.cep.close(); } catch { /* ignore */ } }
          this.cep = socket;
          this.cepInfo = { plugin: msg.plugin, connectedAt: new Date().toISOString() };
          socket.send(JSON.stringify({ type: "welcome", server: SERVER_VERSION }));
          this.#broadcastPanel();
          console.error("[premiere-mcp] CEP QE helper connected");
          return;
        }
        kind = "panel";
        if (this.client && this.client !== socket) {
          try { this.client.close(); } catch { /* ignore */ }
        }
        this.client = socket;
        this.clientInfo = { plugin: msg.plugin, host: msg.host, connectedAt: new Date().toISOString() };
        socket.send(JSON.stringify({ type: "welcome", server: SERVER_VERSION }));
        this.#broadcastPanel();
        console.error(`[premiere-mcp] Premiere panel connected (${JSON.stringify(msg.host)})`);
        return;
      }
      if ((kind === "panel" || kind === "cep") && msg.type === "result") {
        const route = this.relayRoutes.get(msg.id);
        if (route) {
          this.relayRoutes.delete(msg.id);
          if (route.socket.readyState === 1) route.socket.send(JSON.stringify({ ...msg, id: route.id }));
          return;
        }
        this.#settle(msg);
      } else if (kind === "relay" && msg.type === "run") {
        if (!this.isConnected()) {
          socket.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: NOT_CONNECTED }));
          return;
        }
        const id = randomUUID();
        this.relayRoutes.set(id, { socket, id: msg.id });
        this.client.send(JSON.stringify({ type: "run", id, code: msg.code, label: msg.label }));
      } else if (kind === "relay" && msg.type === "runjsx") {
        if (!this.isCepConnected()) {
          socket.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: CEP_NOT_CONNECTED }));
          return;
        }
        const id = randomUUID();
        this.relayRoutes.set(id, { socket, id: msg.id });
        this.cep.send(JSON.stringify({ type: "runjsx", id, code: msg.code, label: msg.label }));
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (kind === "relay") {
        this.relays.delete(socket);
        for (const [id, r] of this.relayRoutes) if (r.socket === socket) this.relayRoutes.delete(id);
      }
      if (kind === "cep" && this.cep === socket) {
        this.cep = null;
        this.cepInfo = null;
        this.#broadcastPanel();
      }
      if (kind === "panel" && this.client === socket) {
        this.client = null;
        this.clientInfo = null;
        this.#failAll("Premiere panel disconnected while running the command");
        for (const [id, r] of this.relayRoutes) {
          if (r.socket.readyState === 1) r.socket.send(JSON.stringify({ type: "result", id: r.id, ok: false, error: "Premiere panel disconnected while running the command" }));
          this.relayRoutes.delete(id);
        }
        this.#broadcastPanel();
      }
    });
  }

  #broadcastPanel() {
    const msg = JSON.stringify({ type: "panel", panel: this.isConnected() ? this.clientInfo : null, cep: this.isCepConnected() ? this.cepInfo : null });
    for (const r of this.relays) if (r.readyState === 1) r.send(msg);
  }

  // ---------- shared ----------
  #settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve({ result: msg.result, logs: msg.logs || [] });
    else {
      const e = new Error(msg.error || "Unknown error in Premiere");
      e.logs = msg.logs || [];
      p.reject(e);
    }
  }

  #failAll(reason) {
    if (!reason) return;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  isConnected() {
    if (this.role === "relay") return !!(this.upstream && this.upstream.readyState === 1 && this.upstreamPanel);
    return !!(this.client && this.client.readyState === 1);
  }

  isCepConnected() {
    if (this.role === "relay") return !!(this.upstream && this.upstream.readyState === 1 && this.upstreamCep);
    return !!(this.cep && this.cep.readyState === 1);
  }

  status() {
    return {
      connected: this.isConnected(),
      cep: this.isCepConnected() ? (this.role === "relay" ? this.upstreamCep : this.cepInfo) : null,
      port: config.port,
      role: this.role === "relay" ? "relay (another copy owns the port and talks to Premiere for us)" : this.role,
      panel: this.role === "relay" ? this.upstreamPanel : this.clientInfo,
      error: this.lastError,
    };
  }

  // Run JavaScript (an async function body) inside Premiere. In scope: ppro, uxp, log(...).
  run(code, { timeoutMs = config.timeoutMs, label } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error(this.lastError ? `${NOT_CONNECTED} (${this.lastError})` : NOT_CONNECTED));
    }
    const target = this.role === "relay" ? this.upstream : this.client;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Premiere. The command may still finish in Premiere.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      target.send(JSON.stringify({ type: "run", id, code, label }));
    });
  }

  // Run ExtendScript in Premiere through the CEP helper (has the QE DOM). The script must evaluate to a string.
  runJsx(code, { timeoutMs = config.timeoutMs, label } = {}) {
    if (!this.isCepConnected()) return Promise.reject(new Error(CEP_NOT_CONNECTED));
    const target = this.role === "relay" ? this.upstream : this.cep;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the CEP helper. The script may still finish in Premiere.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      target.send(JSON.stringify({ type: "runjsx", id, code, label }));
    });
  }
}

const CEP_NOT_CONNECTED =
  "The CEP 'MCP QE Helper' is not connected. Install it (premiere-mcp/cep, see README), restart Premiere, and open Window > Extensions (Legacy) > MCP QE Helper once.";

const NOT_CONNECTED =
  "Premiere Pro is not connected. Open Premiere, then Window > UXP Plugins > MCP Bridge, and check it shows 'Connected'.";