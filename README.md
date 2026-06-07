# Photoshop MCP

MCP server that gives AI assistants (Claude, Cursor, Windsurf, etc.) full control over Adobe Photoshop through natural language.

> Not affiliated with Adobe Inc.

## What can it do?

80 tools across 16 categories — from creating documents and manipulating layers to running filters, extracting PSD data, and searching sprite catalogs.

| Category | Tools | Examples |
|---|---|---|
| **Document** | 4 | Create, open, save, close documents |
| **Layers** | 5 | Create, delete, duplicate, group, get layer tree |
| **Layer Properties** | 9 | Opacity, blend mode, visibility, lock, rename, merge, flatten, rasterize |
| **Layer Ordering** | 5 | Move to top/bottom, up/down, to specific position |
| **Layer Transform** | 4 | Move, scale, rotate, fit to document |
| **Layer Effects** | 4 | Drop shadow, stroke, read effects, remove effects |
| **Text** | 4 | Create text layers, update content, font, color, alignment |
| **Selections & Masks** | 7 | Rectangle select, select all, invert, create/apply/delete masks |
| **Image** | 2 | Resize, crop |
| **Filters** | 4 | Gaussian blur, sharpen, noise, motion blur |
| **Adjustments** | 6 | Brightness/contrast, hue/saturation, levels, auto levels, desaturate, invert |
| **History** | 3 | Undo, redo, get history states |
| **Actions** | 2 | Play recorded actions, execute custom ExtendScript |
| **Image Placement** | 2 | Place image as layer, open image as document |
| **Utility** | 10 | Session info, color sampling, export layer PNG, guides, duplicate document |
| **PSD Extraction** | 2 | Extract layers and layer effects from PSD files without Photoshop |
| **Sprite Tools** | 5 | Visual sprite search, catalog tagging, perceptual hash matching |

## Quick Start

### Prerequisites

- Node.js >= 18
- Adobe Photoshop (2012-2026+ supported)
- macOS (AppleScript/OSA) or Windows (COM automation)

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "npx",
      "args": ["-y", "github:anikettomar19/photoshop-mcp"],
      "env": {
        "PHOTOSHOP_PATH": "/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app"
      }
    }
  }
}
```

### Cursor / Windsurf

Add to `.cursor/mcp.json` or `.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "npx",
      "args": ["-y", "github:anikettomar19/photoshop-mcp"],
      "env": {
        "PHOTOSHOP_PATH": "/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PHOTOSHOP_PATH` | Path to Photoshop application | Auto-detected |
| `LOG_LEVEL` | `0` DEBUG, `1` INFO, `2` WARN, `3` ERROR | `1` |

## PSD Extraction (Offline)

The `photoshop_extract_psd_layer` and `photoshop_extract_layer_fx` tools can read PSD files directly without Photoshop running. Requires Python packages:

```bash
pip install psd-tools Pillow
```

## Troubleshooting

| Problem | Solution |
|---|---|
| Photoshop not found | Set `PHOTOSHOP_PATH` to your installation path |
| Script timeout | Break large operations into smaller steps (default: 30s) |
| Need debug logs | Set `LOG_LEVEL=0` |

## License

MIT
