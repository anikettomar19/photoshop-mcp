# photoshop-mcp

MCP server for controlling Adobe Photoshop from AI assistants (Claude, Cursor, etc.) via natural language.

> Not affiliated with Adobe Inc.

## Setup

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
`%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "npx",
      "args": ["-y", "github:anikettomar19/photoshop-mcp"],
      "env": {
        "LOG_LEVEL": "1",
        "PHOTOSHOP_PATH": "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json`

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "npx",
      "args": ["-y", "github:anikettomar19/photoshop-mcp"],
      "env": {
        "LOG_LEVEL": "1",
        "PHOTOSHOP_PATH": "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description |
|---|---|
| `PHOTOSHOP_PATH` | Path to Photoshop app (auto-detected if omitted) |
| `LOG_LEVEL` | `0`=DEBUG, `1`=INFO, `2`=WARN, `3`=ERROR |

## Tools

50+ tools across these categories:

- **Document** — create, open, save, close, crop, resize
- **Layers** — create, delete, duplicate, merge, flatten, reorder
- **Layer Properties** — opacity, blend mode, visibility, lock, rename
- **Layer Transform** — move, scale, rotate, fit to document
- **Text** — create text layer, update content, font, size, color, alignment
- **Filters** — Gaussian blur, sharpen, noise, motion blur
- **Adjustments** — brightness/contrast, hue/saturation, auto levels, desaturate, invert
- **Selections & Masks** — rectangle select, select all, invert, create/apply/delete mask
- **History** — undo, redo, get history states
- **Actions** — play recorded actions, execute custom ExtendScript
- **PSD Tools** — extract layers and effects from PSD without Photoshop open (requires `psd-tools` + `Pillow` Python packages)
- **Sprite Tools** — visual sprite search and catalog for Unity projects

## Troubleshooting

**Photoshop not found** — set `PHOTOSHOP_PATH` to your installation path.

**Script timeout** — break large operations into smaller steps (default timeout: 30s).

**Debug logs** — set `LOG_LEVEL=0`.

## Platform

- macOS — AppleScript/OSA
- Windows — COM automation

Supports Photoshop 2012–2026+.

## License

MIT
