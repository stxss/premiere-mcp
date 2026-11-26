import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "0.1.0";
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = process.env;
const defaultPython = process.platform === "win32" ? "python" : "python3";

export const config = {
  port: Number(env.PREMIERE_MCP_PORT || 8765),
  token: env.PREMIERE_MCP_TOKEN || "",
  timeoutMs: Number(env.PREMIERE_MCP_TIMEOUT_MS || 120000),
  ffmpeg: env.FFMPEG_PATH || "ffmpeg",
  ffprobe: env.FFPROBE_PATH || "ffprobe",
  python: env.PREMIERE_MCP_PYTHON || defaultPython,
  workDir: env.PREMIERE_MCP_WORKDIR || path.join(os.homedir(), "PremiereMCP"),
  builtinTemplatesDir: path.join(ROOT_DIR, "templates", "captions"),
};

config.userTemplatesDir = path.join(config.workDir, "caption-templates");
config.transcriptsDir = path.join(config.workDir, "transcripts");
config.outputsDir = path.join(config.workDir, "outputs");
config.modelsDir = path.join(config.workDir, "models");
config.mattesDir = path.join(config.workDir, "mattes");

export function ensureDirs() {
  for (const d of [config.workDir, config.userTemplatesDir, config.transcriptsDir, config.outputsDir, config.modelsDir, config.mattesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
