# Premiere Pro MCP

Lets Claude drive Adobe Premiere Pro, plus a free local toolkit (ffmpeg + Whisper) for transcripts, keyword search, caption templates and Shorts. No paid platforms, no cloud transcription.

```
Claude ──MCP (stdio)──▶ Node server ──WebSocket 127.0.0.1:8765──▶ "MCP Bridge" UXP panel ──▶ Premiere Pro
                             └── ffmpeg / ffprobe / faster-whisper (runs on your machine)
```

Works on Windows and macOS. Requires Premiere Pro 25.6 or newer (the UXP API this uses landed in 25.6).

## What's in it (42 tools)

**Premiere (`ppro_*`)**
- `ppro_status`, `ppro_project_overview`, `ppro_sequence_info` – see the project, bins, sequences, every clip on every track, markers
- `ppro_import_files`, `ppro_organize` – import into bins, create/move/rename/label items
- `ppro_rough_cut` – build a new sequence from time ranges of a source clip (silence-removed segments or story beats)
- `ppro_create_sequence`, `ppro_open_sequence`, `ppro_set_in_out`
- `ppro_add_markers`, `ppro_list_markers`, `ppro_remove_markers`, `ppro_youtube_chapters` – chapter markers to a ready-to-paste YouTube chapter list
- `ppro_import_captions` – put an SRT on the timeline as a caption track
- `ppro_premiere_transcribe` – Premiere's own built-in Speech to Text, as an alternative to Whisper
- `ppro_find_export_presets`, `ppro_export_sequence` (in Premiere or via Media Encoder), `ppro_export_frame` (thumbnails)
- `ppro_execute_script` + `ppro_api_help` – Claude can write any Premiere UXP script for jobs the fixed tools don't cover
- Batch timeline tools (one call per editing step, each reports its own time): `ppro_place_from_plan` (clear + lay a whole cut list frame-exact incl. divider pieces, checked clip by clip; edits run with a parking sequence in front and retry when Premiere invalidates objects), `ppro_set_layout` (enable flags, split transforms, outro slide), `ppro_add_video_transitions` (one transition at many edits on many tracks), `ppro_set_markers_from_json`, `ppro_place_intro_outro` (the plan's nested sequences + their audio level), `ppro_read_timeline` (clips, effects, keyframes, video+audio transitions, markers in one read). They take `plan_file` (a plan.json); everything show-specific (tracks, project item names, labels, transforms, nests, parking sequence) comes from its `spec` block, documented at the top of `server/src/plan-tools.js`.
- `ppro_audio_transitions` – audio transitions on every edit (QE DOM), or with `edges` on chosen edit points with their own lengths, all in one call

**HyperFrames (motion graphics, free, local)**
- `hyperframes_init`, `hyperframes_read_file`, `hyperframes_write_file` – create and edit an HTML/GSAP composition (titles, lower thirds, intros, animated text)
- `hyperframes_check`, `hyperframes_snapshot` – validate it and preview frames before rendering
- `hyperframes_render` – render to MP4, or MOV ProRes 4444 with transparency, and optionally import it and place it on V2 of your sequence in one step

**Local media (free)**
- `transcribe_media` – Whisper (faster-whisper) with word-level timestamps, cached per file
- `transcript_read`, `transcript_search` – read with timestamps, find keywords/phrases with exact cut points
- `media_detect_silence` – dead-air detection that feeds straight into `ppro_rough_cut`
- `captions_generate`, `captions_reformat`, `captions_list_templates`, `captions_get_template`, `captions_save_template` – SRT/VTT/ASS from templates; restyle existing SRTs
- `shorts_render` – 9:16 short from any time range: crop / blurred background / letterbox, burned-in animated captions
- `media_probe`, `media_extract_frames`, `job_status`, `job_cancel`, `setup_check`

Built-in caption templates: `youtube-standard`, `youtube-single-line`, `shorts-punchy` (1-3 words, caps, active word highlighted), `shorts-karaoke`, `shorts-boxed`. Make your own by asking Claude, e.g. "save a caption template called my-shorts based on shorts-punchy with 2 words max and a red highlight". User templates live in `~/PremiereMCP/caption-templates/`.

## Setup

### Windows: one script

Unzip, open PowerShell in the `premiere-mcp` folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
```

It installs whatever is missing (Node.js LTS, ffmpeg, Python, faster-whisper), runs `npm install` (which includes HyperFrames), and adds the server to Claude Desktop's config (backing up the old one). Windows may show admin prompts for the installers. Then do step 3 below (the Premiere panel) and restart Claude Desktop.

### 1. Install the prerequisites (manual / macOS)

| | Windows | macOS |
|---|---|---|
| Node.js 22+ | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| ffmpeg (with libass) | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
| Python 3.9+ | `winget install Python.Python.3.12` | `brew install python` |
| Whisper | `python -m pip install faster-whisper` | `python3 -m pip install faster-whisper` |

Restart your terminal afterwards so the new commands are on PATH. NVIDIA GPU on Windows: faster-whisper uses it automatically if CUDA 12 + cuDNN are installed; otherwise it runs on CPU (`small` model: roughly real-time or faster on a modern CPU).

### 2. Install the server

```bash
cd premiere-mcp/server
npm install
```

### 3. Load the Premiere panel

1. Install **UXP Developer Tools** (v2.2+) from the Creative Cloud app (All apps → search "UXP"). Accept the prompt to enable Developer Mode on first launch.
2. In Premiere: Settings/Preferences → Plugins → tick **Enable developer mode**, restart Premiere.
3. Open UXP Developer Tools → **Add Plugin** → pick `premiere-mcp/plugin/manifest.json` → **Load**.
4. In Premiere: **Window → UXP Plugins → MCP Bridge**. Dock it anywhere. It shows a green dot once the MCP server is running.

To avoid the Developer Tool every session: in UXP Developer Tools use **••• → Package** to make a `.ccx`, then double-click it to install it permanently.

### 4. Connect Claude

**Claude Desktop** – edit `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`, macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "premiere-pro": {
      "command": "node",
      "args": ["C:/path/to/premiere-mcp/server/src/index.js"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add premiere-pro -- node /path/to/premiere-mcp/server/src/index.js
```

Restart Claude, then ask: *"run setup_check"*. It reports anything missing with the exact fix.

### Optional settings (environment variables in the MCP config `env` block)

| Variable | Default | Purpose |
|---|---|---|
| `PREMIERE_MCP_PORT` | `8765` | Bridge port. If you change it, change it in the panel too, and add it to `plugin/manifest.json` network domains. |
| `PREMIERE_MCP_TOKEN` | – | Shared secret; type the same value into the panel's Token field |
| `PREMIERE_MCP_WORKDIR` | `~/PremiereMCP` | Transcripts, caption templates, renders |
| `PREMIERE_MCP_PYTHON` | `python` / `python3` | Python with faster-whisper installed (e.g. a venv) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | If they're not on PATH |
| `PREMIERE_MCP_TIMEOUT_MS` | `120000` | Default time limit for a Premiere command |

Only one copy of the server can own the port. If you use both Claude Desktop and Claude Code, give one a different port.

## Things to ask Claude

- "Detect the silences in C:/footage/vlog_A.mp4 and build a tight cut in Premiere called 'Vlog A tight'. Use -38 dB so it isn't too aggressive."
- "Transcribe the interview, read it, and assemble a 6-minute story cut: hook, problem, three examples, ending."
- "Find every time I say the sponsor's name and drop comment markers there."
- "Read the transcript and add chapter markers to the active sequence, then give me the YouTube chapters list."
- "Make English SRT captions with youtube-single-line and put them on the timeline."
- "Find the 3 best 30–50 second moments for Shorts — each must make sense on its own with a strong first line — and render them with shorts-punchy captions, face on the left third (crop_x 0.3)."
- "Re-format this SRT from Premiere into 2-word uppercase captions as ASS."
- "Export the active sequence with my YouTube 4K preset via Media Encoder, and grab a thumbnail frame at 1:23."
- "Organise the project: put all .wav files in Audio, all b-roll in B-roll/<date>."

Portuguese works too: pass `language: "pt"` to transcription, or let it auto-detect.

## How it behaves

- Every edit is a single undo step in Premiere (Ctrl/Cmd+Z reverts it).
- `ppro_rough_cut` creates hard-boundary subclips in `Rough Cuts/<sequence name>` and lays them back to back; the original footage and other sequences are untouched.
- Long jobs (transcription, silence detection on long files, renders) return a `job_id` if they run past ~40 s; Claude polls `job_status`.
- Caption styling inside Premiere (fonts, colours) isn't exposed by Adobe's API. SRT goes in with your Premiere caption style; for fully styled/animated captions use `format: "ass"` and `shorts_render` (burn-in) or your own ffmpeg export.
- `ppro_execute_script` runs arbitrary code inside Premiere. That is the point of it, but only connect this server to Claude sessions you control.

## Status / known limits

- Built against Adobe's UXP reference and samples for Premiere 25.6+, and tested end to end (all 36 tools) against an in-memory imitation of the API (`server/test/`), and used on real Premiere projects (Windows). Not every tool has been exercised on real Premiere yet; the likeliest mismatch spots: `ppro_rough_cut` (how `createSequenceFromMedia` orders multiple clips; the tool verifies and appends anything missing), `ppro_import_captions` (SRT placement through the API; falls back to leaving the SRT in a bin to drag in), and marker colours. If something fails, the error text comes back to Claude, which can usually work around it with `ppro_execute_script`.
- Export presets (.epr) must exist on disk; save one from Premiere's export panel if `ppro_find_export_presets` finds nothing useful.
- Transcription quality vs speed: `small` is the default; `medium` or `large-v3` for accuracy (slower; best with a GPU); `tiny`/`base` for quick drafts.

## Tests

```bash
cd server
node test/run-tests.js /path/to/any-video-with-speech.mp4            # synthetic transcript
node test/run-tests.js /path/to/any-video-with-speech.mp4 --whisper  # real Whisper (tiny model)
```

Try a tool against the live Premiere without restarting Claude (joins the running server's bridge as a relay):

```bash
cd server
node test/call.mjs tool ppro_read_timeline '{"sequence":"Episode Copy","out_file":"C:/tmp/read.json"}'
node test/call.mjs uxp my_script.js        # raw UXP body, prelude helpers in scope
node test/call.mjs jsx my_script.jsx       # raw ExtendScript through the CEP helper
```

## CEP companion: MCP QE Helper (audio transitions, QE DOM)

UXP can't add audio transitions. `cep/` is a tiny CEP panel that connects to the same port as role `cep`
and runs ExtendScript (with the QE DOM). Tools that use it: `ppro_audio_transitions`, `ppro_execute_extendscript`,
`ppro_place_intro_outro` (nest audio level), `ppro_read_timeline` and `ppro_add_video_transitions` (reading transitions:
UXP returns nulls for them). The server sends `cep/host.jsx` along with every call, so edits to it apply without
reloading the panel.

Install (once). CSXS.12 is the key for Premiere 25.x; setting it for several versions is harmless.

Windows (PowerShell):

```powershell
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
New-Item -ItemType Junction -Path "$env:APPDATA\Adobe\CEP\extensions\dev.premieremcp.qehelper" -Target "<repo>\cep"
```

macOS:

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions
ln -s "<repo>/cep" ~/Library/Application\ Support/Adobe/CEP/extensions/dev.premieremcp.qehelper
```

Restart Premiere; open Window > Extensions (Legacy) > MCP QE Helper once if it doesn't start by itself.

Every copy of the MCP server must run this version before the helper connects: an older server treats any
non-relay hello as the UXP panel, so the helper would kick the UXP panel off.

## Publishing without your private history

`python scripts/publish.py "what changed"` pushes the current files as one new commit to a separate remote (default `github`)
and refuses if a file is local-only, looks like a secret, or matches your gitignored `publish-blocklist.txt`.
`python scripts/publish.py --help` has the one-time setup.
