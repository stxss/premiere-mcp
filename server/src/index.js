#!/usr/bin/env node
// Premiere Pro MCP server: stdio MCP for Claude + WebSocket bridge to the Premiere UXP panel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PremiereBridge } from "./bridge.js";
import { registerPremiereTools } from "./premiere-tools.js";
import { registerMediaTools } from "./media-tools.js";
import { registerHyperframesTools } from "./hyperframes-tools.js";
import { config, ensureDirs, SERVER_VERSION } from "./config.js";

const INSTRUCTIONS = `Premiere Pro MCP. Two tool families:
- ppro_* act inside the open Premiere Pro project (needs the MCP Bridge panel connected; check with ppro_status).
- media_*, transcribe_media, transcript_*, captions_*, shorts_render run locally with ffmpeg + Whisper (free, no cloud).
Typical flows:
- Tighten a talking-head: media_detect_silence (+ transcript for fillers/retakes) -> ppro_rough_cut(segments_file) -> ppro_declick_audio (removes tongue clicks/lip smacks at clip starts; always do this for talking heads).
- Green screen / talking-head key: matte_setup (once) -> media_matte(preview_times) to check -> media_matte(ranges = source in/out of every timeline clip) -> ppro_replace_with_matte(matte_map). Better than Ultra Key on uneven, dark or compressed screens; keeps chairs/props. Effect order note: in a component chain the effect appended LAST renders FIRST.
- Story/rough cut from footage: transcribe_media -> transcript_read/transcript_search -> ppro_rough_cut(segments).
- Chapters: transcript_read -> ppro_add_markers(type=chapter) -> ppro_youtube_chapters.
- Captions: transcribe_media -> captions_generate(srt) -> ppro_import_captions; styled burn-in uses format=ass.
- Motion graphics (titles, lower thirds, intros): hyperframes_init -> hyperframes_write_file -> hyperframes_check -> hyperframes_render(format=mov, place_at=...) puts an alpha overlay on V2.
- Shorts: transcribe_media -> transcript_read/search to find 20-60s self-contained moments -> shorts_render.
Times are always seconds. Long jobs return a job_id: poll job_status with wait_seconds.
Ask before destructive project changes; edits are undoable in Premiere (Ctrl/Cmd+Z).`;

ensureDirs();
const bridge = new PremiereBridge();
bridge.start();

const server = new McpServer({ name: "premiere-pro", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
registerPremiereTools(server, bridge);
registerMediaTools(server, bridge);
registerHyperframesTools(server, bridge);

await server.connect(new StdioServerTransport());
console.error(`[premiere-mcp] v${SERVER_VERSION} ready (port ${config.port}, workdir ${config.workDir})`);
