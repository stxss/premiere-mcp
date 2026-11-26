// MCP QE Helper (CEP). Connects to the premiere-mcp server as role "cep" and runs ExtendScript it sends.
// Protocol: server -> {type:"runjsx", id, code}; panel -> {type:"result", id, ok, result|error}.
// The ExtendScript must evaluate to a string (host.jsx's tqJSON() is available for that).
var VERSION = "0.1.0";
var ws = null;
var retry = null;

function el(id) { return document.getElementById(id); }
function log(s) {
  var d = el("log");
  d.textContent = new Date().toLocaleTimeString() + " " + s + "\n" + d.textContent.slice(0, 4000);
}
function setStatus(cls, s) { var e = el("status"); e.className = cls; e.textContent = s; }
function store(k, v) { try { if (v === undefined) return localStorage.getItem("qe." + k); localStorage.setItem("qe." + k, v); } catch (e) { return null; } }

function evalScript(code, cb) {
  // window.__adobe_cep__ is what CSInterface.evalScript wraps.
  window.__adobe_cep__.evalScript(code, cb);
}

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  var port = (el("port").value || "8765").trim();
  store("port", port); store("token", el("token").value || "");
  setStatus("wait", "Connecting to ws://127.0.0.1:" + port + "...");
  try { ws = new WebSocket("ws://127.0.0.1:" + port); } catch (e) { setStatus("off", "Cannot open socket"); schedule(); return; }
  ws.onopen = function () {
    ws.send(JSON.stringify({ type: "hello", role: "cep", plugin: VERSION, token: el("token").value || "" }));
  };
  ws.onmessage = function (evt) {
    var msg; try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (msg.type === "welcome") { setStatus("on", "Connected (server " + (msg.server || "?") + ")"); log("connected"); }
    else if (msg.type === "rejected") { setStatus("off", "Rejected: " + msg.reason); ws.close(); }
    else if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); }
    else if (msg.type === "runjsx") {
      var t0 = Date.now();
      evalScript(msg.code, function (res) {
        var ok = !(typeof res === "string" && res.indexOf("EvalScript error") === 0);
        ws.send(JSON.stringify(ok ? { type: "result", id: msg.id, ok: true, result: res } : { type: "result", id: msg.id, ok: false, error: res }));
        log((ok ? "ok " : "error ") + (msg.label || msg.id) + " (" + (Date.now() - t0) + " ms)");
      });
    }
  };
  ws.onclose = function () { setStatus("off", "Disconnected - is the MCP server running?"); schedule(); };
  ws.onerror = function () {};
}
function schedule() { if (!retry) retry = setTimeout(function () { retry = null; connect(); }, 3000); }

el("port").value = store("port") || "8765";
el("token").value = store("token") || "";
el("connect").onclick = function () { if (ws) try { ws.close(); } catch (e) {} ws = null; setTimeout(connect, 200); };
connect();
