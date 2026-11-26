// Protocol test for the CEP helper route: primary + relay + fake CEP client on a spare port.
process.env.PREMIERE_MCP_PORT = process.env.PREMIERE_MCP_PORT || "8799";
const { PremiereBridge } = await import("../src/bridge.js");
const { WebSocket } = await import("ws");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };

const primary = new PremiereBridge(); primary.start(); await wait(300);
check(primary.role === "primary", "primary owns the port");
try { await primary.runJsx("1"); check(false, "runJsx without CEP rejects"); } catch (e) { check(/CEP/.test(e.message), "runJsx without CEP rejects"); }

const cep = new WebSocket(`ws://127.0.0.1:${process.env.PREMIERE_MCP_PORT}`);
cep.on("open", () => cep.send(JSON.stringify({ type: "hello", role: "cep", plugin: "test" })));
cep.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "runjsx") cep.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: `{"ok":true,"result":"ran:${m.code}"}` }));
});
await wait(300);
check(primary.isCepConnected() && primary.status().cep, "CEP shows in status");
const r = await primary.runJsx("abc");
check(r.result === '{"ok":true,"result":"ran:abc"}', "primary runJsx round trip");

const relay = new PremiereBridge(); relay.start(); await wait(500);
check(relay.role === "relay" && relay.isCepConnected(), "relay sees CEP");
const r2 = await relay.runJsx("xyz");
check(r2.result.includes("ran:xyz"), "relay runJsx routed through primary");
check(!relay.isConnected(), "UXP panel still reported absent");

cep.close(); await wait(300);
check(!primary.isCepConnected() && !relay.isCepConnected(), "CEP disconnect propagates to relay");
console.log(fails ? `${fails} FAILURE(S)` : "ALL PASSED");
process.exit(fails ? 1 : 0);
