// Call a premiere-mcp tool (or run a raw UXP/ExtendScript file) against the live Premiere, through the
// running MCP server's bridge (joins as a relay). Lets you try new/changed tools without restarting Claude.
// Usage:
//   node test/call.mjs tool <tool_name> '<json args>'      (or @args.json)
//   node test/call.mjs uxp <file.js> [timeout_s]           (body of an async fn; prelude helpers in scope)
//   node test/call.mjs jsx <file.jsx> [timeout_s]
// Prints {ms, result} with the wall-clock time of the call.
import fs from "node:fs";
const { PremiereBridge } = await import("../src/bridge.js");
const { registerPremiereTools } = await import("../src/premiere-tools.js");
const { script } = await import("../src/ppro-prelude.js");

const [mode, target, a3] = process.argv.slice(2);
const bridge = new PremiereBridge();
bridge.start();
for (let i = 0; i < 50 && !bridge.isConnected(); i++) await new Promise((r) => setTimeout(r, 100));
if (!bridge.isConnected()) { console.error("Premiere panel not connected", bridge.status()); process.exit(2); }

const tools = {};
registerPremiereTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, bridge);

const t0 = Date.now();
let out;
if (mode === "tool") {
  if (!tools[target]) { console.error("No tool " + target + ". Have: " + Object.keys(tools).join(", ")); process.exit(2); }
  const args = a3 ? JSON.parse(a3.startsWith("@") ? fs.readFileSync(a3.slice(1), "utf8") : a3) : {};
  const r = await tools[target](args);
  out = r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
} else if (mode === "uxp") {
  const timeoutMs = (Number(a3) || 600) * 1000;
  try { out = (await bridge.run(script({}, fs.readFileSync(target, "utf8")), { label: "call.mjs", timeoutMs })).result; }
  catch (e) { out = { error: e.message }; }
} else if (mode === "jsx") {
  const timeoutMs = (Number(a3) || 600) * 1000;
  try { out = (await bridge.runJsx(fs.readFileSync(target, "utf8"), { label: "call.mjs", timeoutMs })).result; }
  catch (e) { out = { error: e.message }; }
} else { console.error("mode: tool | uxp | jsx"); process.exit(2); }
console.log(JSON.stringify({ ms: Date.now() - t0, result: out }, null, 1));
process.exit(0);
