# Photoshop MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude, Cursor, Windsurf and others) drive Adobe Photoshop: inspect PSDs, edit layers, export assets, and bridge PSD layouts into Unity.

> Not affiliated with Adobe Inc.

- **92 tools**: documents, layers, text, effects, filters, selections, exports, and offline PSD reading
- **Unity-oriented extras**: RectTransform values from layer bounds, TextMeshPro effect values, a visual sprite search over a Unity project, and a one-call "PSD → Unity assets" export
- **Built for agents**: forgiving arguments, errors that say what *does* exist, no modal dialogs blocking Photoshop, and outputs sized to fit in a tool result

## Quick start

### Requirements

- **Node.js 18+**
- **Adobe Photoshop** (CC through 2026 have been used)
- **macOS** (scripts run through AppleScript), or **Windows** (COM via `cscript`). The Windows path exists but is not currently tested.
- Optional, for the offline PSD tools: Python 3 with `pip install psd-tools Pillow`

### Claude Code

```bash
claude mcp add photoshop -- npx -y github:anikettomar19/photoshop-mcp
```

With a Unity project for the sprite tools:

```bash
claude mcp add photoshop -e UNITY_PROJECT_ROOT=/path/to/UnityProject -- npx -y github:anikettomar19/photoshop-mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "npx",
      "args": ["-y", "github:anikettomar19/photoshop-mcp"]
    }
  }
}
```

### Cursor / Windsurf

Add the same block to `.cursor/mcp.json` or `.windsurf/mcp.json`. Ready-made files are in [`examples/`](examples/).

The first launch clones and builds the server, so it takes a little longer. **After updating, restart the MCP server** (in Claude Code: `/mcp` → photoshop → Reconnect). A running server keeps the code it started with.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PHOTOSHOP_PATH` | Path to the Photoshop app, if auto-detection picks the wrong one | auto-detected |
| `UNITY_PROJECT_ROOT` | Unity project for the sprite and catalog tools (each call can also pass `project_root`) | none |
| `PHOTOSHOP_MCP_TIMEOUT_MS` | Default time limit per Photoshop script | `30000` |
| `LOG_LEVEL` | `0` debug, `1` info, `2` warn, `3` error (logs go to stderr) | `1` |

## Tools

| Area | Tools |
|---|---|
| **Documents** (6) | `create_document`, `open_image`, `save_document`, `close_document`, `duplicate_document`, `set_active_document` |
| **Inspect** (8) | `get_layer_tree`, `get_layers`, `get_document_info`, `get_session_info`, `get_selection_info`, `get_layer_effects`, `list_smart_objects`, `sample_color_at_pixel` |
| **Layers** (9) | `create_layer`, `create_layer_group`, `delete_layer`, `duplicate_layer`, `rename_layer`, `select_layer_by_path`, `fill_layer`, `merge_visible_layers`, `flatten_image` |
| **Layer properties** (5) | `set_layer_opacity`, `set_layer_blend_mode`, `set_layer_visibility`, `set_layer_locked`, `rasterize_layer` |
| **Arrange & transform** (9) | `move_layer`, `scale_layer`, `rotate_layer`, `fit_layer_to_document`, `move_layer_up` / `_down` / `_to_top` / `_to_bottom`, `move_layer_to_position` |
| **Text** (5) | `create_text_layer`, `update_text_content`, `set_text_font`, `set_text_color`, `set_text_alignment` |
| **Layer effects** (3) | `add_drop_shadow`, `add_stroke_effect`, `remove_layer_effects` |
| **Image & canvas** (3) | `resize_image`, `resize_canvas`, `crop_document` |
| **Adjustments** (7) | `adjust_brightness_contrast`, `adjust_hue_saturation`, `apply_levels`, `auto_levels`, `auto_contrast`, `desaturate`, `invert` |
| **Filters** (4) | `apply_gaussian_blur`, `apply_sharpen`, `apply_noise`, `apply_motion_blur` |
| **Selections & masks** (7) | `select_rectangle`, `select_all`, `deselect`, `invert_selection`, `create_layer_mask`, `apply_layer_mask`, `delete_layer_mask` |
| **Export** (2) | `export_layer_as_png`, `batch_export_layers` |
| **Smart objects** (2) | `replace_smart_object`, `swap_mockup_asset` |
| **Placement & guides** (3) | `place_image`, `add_guide`, `clear_guides` |
| **History & scripting** (5) | `undo`, `redo`, `get_history`, `play_action`, `execute_script` |
| **PSD files, no Photoshop needed** (4) | `get_psd_layer_tree`, `extract_psd_layer`, `extract_layer_fx`, `ocr_text` |
| **Unity** (3) | `get_layer_rt` (RectTransform values), `prep_ui_for_unity` (export a whole PSD with a manifest), `extract_sprite_to_catalog` |
| **Sprite search & catalog** (5) | `find_similar_sprites`, `rebuild_sprite_index`, `catalog_search`, `catalog_tag`, `catalog_list` |
| **Connection** (2) | `ping`, `get_version` |

Live-Photoshop tools are prefixed `photoshop_` (e.g. `photoshop_get_layer_tree`); the sprite and catalog tools are not.

## How calls behave

These are the details an agent (or you) will run into.

**Layer paths.** Layers are addressed by their group path: `"Header/Buttons/Claim"`. If siblings share a name, a bare name is an error rather than a guess; pick one with a 0-based index, `"Buttons/Claim[1]"`. A wrong segment reports the names that *do* exist at that level.

**Which document.** Tools act on the active document. Most also take an optional `document` argument (e.g. `"Main Screen.psd"`), which activates that document in the same call, so a click in Photoshop between calls can't redirect it.

**Forgiving arguments.** Spelling variants map to the real argument (`layerPath` / `layer_path`, `maxDepth` / `max_depth`), and so do unambiguous synonyms (`script` → `code`, `file` → `filePath`). Numbers and booleans sent as strings are converted. A missing required argument returns the full list of accepted ones.

**No blocking dialogs.** Photoshop's dialogs are switched off while a tool runs (and your setting restored afterwards). An error comes back as a tool error instead of an alert that freezes every later script.

**Errors are errors.** A failed Photoshop script is reported as a failed tool call, with Photoshop's message.

**Time limits.** Each script gets 30 s by default. Heavy tools (layer trees, exports, opening and resizing large files) get 5 minutes, and `execute_script` takes `timeout_seconds`. Photoshop can't be interrupted from outside, so after a timeout it may still be finishing; later calls wait for it.

**Large documents.** `get_layer_tree` returns compact JSON (a `legend` explains the short keys; `detail: "full"` gives long names). If a tree is too big for one tool result, it is cut to the deepest level that fits, with a `note` and per-group child counts, so you can walk into a group with `path`. A 3,270-layer document returns in about 2 seconds.

**Exporting states.** `batch_export_layers` exports layers or whole groups. To export one state of a group, hide and show children relative to it:

```json
{ "path": "Claim", "output_path": "/tmp/claim_pressed.png", "hide": ["*"], "show": ["State Pressed"] }
```

Your document's visibility is restored after each export.

## Offline PSD tools

`get_psd_layer_tree`, `extract_psd_layer` and `extract_layer_fx` read `.psd` files with Python's [psd-tools](https://github.com/psd-tools/psd-tools), so Photoshop doesn't need to be running.

- Omit `group_path` to walk the whole file; `max_depth` limits the walk.
- Hidden layers are skipped in the tree.
- Smart objects export their embedded image, or their rendered pixels when the embedded file is a PSB/AI/PDF.
- Clipped layers are cropped to their clip base; unclipped ones are not.

`ocr_text` uses the bundled `tesseract.js`, so there is nothing to install.

## Unity sprite search

`rebuild_sprite_index` hashes every image under `Assets/Sprites`, `Assets/Resources` and `Assets/Resources_moved` of the Unity project, and `find_similar_sprites` finds sprites that look like a given image (e.g. a layer exported from a PSD). Use them to check whether art already exists before exporting it again.

- Set the project with `UNITY_PROJECT_ROOT` or pass `project_root`. Each project (and each git worktree) has its own index, under `~/.cache/photoshop-mcp/<hash of the project path>/`.
- Rebuilds are incremental: only changed files are re-hashed.
- Byte-identical copies in different folders are merged into one search result, with the other locations listed under `duplicatePaths`.
- A separate 9-slice index keeps every bordered sprite, including copies, because borders live in each file's `.meta`.
- Files that aren't really PNG/JPG (for example a Photoshop file saved with a `.png` extension) can't be read, and are listed under `errors`.

## Troubleshooting

| Problem | What to do |
|---|---|
| Photoshop not found, or the wrong version is used | Set `PHOTOSHOP_PATH` |
| `Script execution timed out` | Narrow the call (`path`, `max_depth`), or raise the limit (`timeout_seconds`, `PHOTOSHOP_MCP_TIMEOUT_MS`). If Photoshop is still busy, wait: it is finishing the previous script. |
| A tool acted on the wrong document | Pass `document` |
| New tools or fixes don't show up after updating | Restart the MCP server; a running one keeps its old code |
| Offline PSD tools fail to start | `pip install psd-tools Pillow` for the `python3` on your PATH |
| Need more detail | Set `LOG_LEVEL=0` |

## Development

```bash
npm install        # also builds dist/
npm test           # build + unit tests; no Photoshop needed
npm run lint
npm run format:check
```

CI runs lint, format check, build and tests on Node 20 and 22 for every pull request. `main` is protected and requires the `ci-result` check.

- `src/tools/*-tools.ts`: tool definitions and handlers
- `src/api/extendscript.ts`: the ExtendScript sent to Photoshop
- `src/platform/`: the macOS and Windows script runners
- `scripts/psd_extract.py`: the offline PSD reader

## License

MIT
