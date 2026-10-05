#!/usr/bin/env python3.12
"""
PSD Layer Extractor — handles Smart Objects, clipping masks, and FX extraction.
Usage:
  python3.12 psd_extract.py <psd_path> <layer_path> <output_png>
  python3.12 psd_extract.py <psd_path> --fx <layer_path>

Layer path uses slash notation: "intro screen/fg box/Sorry_Feb_2026_00515_ copy 2"
"""
import sys
from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import Tag


class ToolError(Exception):
    """An error meant for the caller: printed as one line, without a traceback."""


ROOT_PATHS = ("", "/", "__ROOT__", "<root>", "<document>")


def _sibling_names(container):
    names = [f'"{l.name}"' + ("/" if l.is_group() else "") for l in container]
    return ", ".join(names) if names else "(none)"


def get_layer_by_path(psd, path: str):
    """
    Navigate to a layer by slash-separated path.

    Matches the live-Photoshop resolver: a missing segment lists the siblings
    that do exist, identically named siblings are an error unless picked with
    "Name[n]" (0-based), and walking into something that is not a group says
    what it is instead of failing with "object is not iterable".
    """
    import re

    parts = path.strip("/").split("/")
    node = psd
    for i, part in enumerate(parts):
        under = "/".join(parts[:i]) or "<document>"
        if not (node is psd or node.is_group()):
            raise ToolError(
                f"'{under}' is a {node.kind} layer, not a group, so it has no '{part}' inside it"
            )
        want = None
        m = re.match(r"^(.*)\[(\d+)\]$", part)
        if m:
            part, want = m.group(1), int(m.group(2))
        matches = [l for l in node if l.name == part]
        if not matches:
            raise ToolError(
                f"Layer not found: '{part}' under '{under}'. Siblings here: {_sibling_names(node)}"
            )
        if want is not None:
            if want >= len(matches):
                raise ToolError(f"'{part}[{want}]' is out of range: only {len(matches)} sibling(s) named '{part}'")
            node = matches[want]
        elif len(matches) > 1:
            raise ToolError(
                f"'{part}' under '{under}' is ambiguous: {len(matches)} siblings share that name. "
                f"Use '{part}[0]' through '{part}[{len(matches) - 1}]'"
            )
        else:
            node = matches[0]
    return node


def _open_embedded(layer, path_hint: str):
    """
    Returns the smart object's embedded image, or its rendered pixels when the
    embedded file is something Pillow can't read (a PSB, AI or PDF). Saving
    those as .png and reopening them is what raised UnidentifiedImageError.
    """
    import os, tempfile
    from PIL import UnidentifiedImageError

    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        raw_path = f.name
    try:
        layer.smart_object.save(raw_path)
        try:
            return Image.open(raw_path).convert("RGBA"), "embedded"
        except UnidentifiedImageError:
            rendered = layer.composite()
            if rendered is None:
                raise ToolError(
                    f"Smart object '{path_hint}' embeds {layer.smart_object.filename}, which can't be read, "
                    "and has no rendered pixels"
                )
            return rendered.convert("RGBA"), "rendered"
    finally:
        os.unlink(raw_path)


def extract_layer(layer, out_path: str, apply_clip_context=None):
    """
    Extract a layer to a PNG file.
    - Smart Objects: extracts the embedded file directly via smart_object.save()
    - Clipping-masked layers: composites with the clip base layer
    - Regular layers: uses layer.composite()

    apply_clip_context: parent group to composite with clip masking applied.
                        When set, composites the group with only clip-relevant
                        layers visible, giving correct clipped output.
    """
    if layer.kind == 'smartobject' and layer.smart_object:
        # Smart Object: extract the embedded PNG/PSB directly
        so = layer.smart_object
        print(f"Smart Object: {so.filename} ({so.filesize} bytes)")

        if apply_clip_context is not None:
            # Composite with clip context: crop raw SO to clip base bounds
            print("Applying clip context for proper mask compositing...")
            _composite_with_clip(layer, apply_clip_context, out_path)
        else:
            # Raw extraction: no clipping applied
            img, source = _open_embedded(layer, layer.name)
            img.save(out_path)
            print(f"Extracted Smart Object ({source}): {img.size} {img.mode}")
    else:
        img = layer.composite()
        # An empty layer composites to None or to a fully transparent canvas;
        # either way this used to report success for an image with nothing in it.
        if img is None or img.getbbox() is None:
            raise ToolError(f"'{layer.name}' has no pixels to export (it is empty or fully hidden)")
        img.save(out_path)
        print(f"Extracted layer: {img.size} {img.mode}")


def _composite_with_clip(target_layer, parent_group, out_path: str):
    """
    Composite a clipping-masked Smart Object properly by:
    1. Extracting the raw Smart Object PNG
    2. Finding the clip base layer and its bounds
    3. Computing the intersection of SO bounds and clip base bounds in PSD coords
    4. Cropping the raw PNG to that intersection (mapped to raw image coords)

    This avoids psd-tools composite() which cannot render Smart Object content.
    """
    import os, tempfile

    layers = list(parent_group)  # bottom-to-top in psd-tools

    # Locate target in layer list (by identity: siblings can share a name)
    target_idx = next((i for i, l in enumerate(layers) if l is target_layer), None)
    if target_idx is None:
        raise ValueError("Target layer not found in parent group")

    # Find the clip base: first non-clipping layer below target
    clip_base = None
    for i in range(target_idx - 1, -1, -1):
        l = layers[i]
        if not getattr(l, 'clipping', False):
            clip_base = l
            break

    raw_img, _ = _open_embedded(target_layer, target_layer.name)

    # bbox is a tuple: (left, top, right, bottom) in PSD canvas px
    so_b = target_layer.bbox
    print(f"  Smart Object bbox (PSD): {so_b}")

    if clip_base is not None:
        cb_b = clip_base.bbox
        print(f"  Clip base '{clip_base.name}' bbox (PSD): {cb_b}")

        # Intersection of SO and clip base in PSD coords
        c_left   = max(so_b[0], cb_b[0])
        c_top    = max(so_b[1], cb_b[1])
        c_right  = min(so_b[2], cb_b[2])
        c_bottom = min(so_b[3], cb_b[3])

        if c_right <= c_left or c_bottom <= c_top:
            print("Warning: clip region is empty — using full SO bounds")
            c_left, c_top, c_right, c_bottom = so_b[0], so_b[1], so_b[2], so_b[3]
    else:
        print("No clip base found — using full SO bounds")
        c_left, c_top, c_right, c_bottom = so_b[0], so_b[1], so_b[2], so_b[3]

    # Map PSD canvas intersection → raw image pixel coords.
    # The SO bbox in PSD canvas px maps proportionally to the raw image dimensions.
    so_psd_w = so_b[2] - so_b[0]
    so_psd_h = so_b[3] - so_b[1]
    raw_w, raw_h = raw_img.size

    scale_x = raw_w / so_psd_w if so_psd_w > 0 else 1.0
    scale_y = raw_h / so_psd_h if so_psd_h > 0 else 1.0

    crop_l = max(0, int((c_left   - so_b[0]) * scale_x))
    crop_t = max(0, int((c_top    - so_b[1]) * scale_y))
    crop_r = min(raw_w, int((c_right  - so_b[0]) * scale_x))
    crop_b = min(raw_h, int((c_bottom - so_b[1]) * scale_y))

    print(f"  Raw image size: {raw_img.size} | scale: ({scale_x:.3f}, {scale_y:.3f})")
    print(f"  Crop box in raw image: ({crop_l},{crop_t},{crop_r},{crop_b})")
    cropped = raw_img.crop((crop_l, crop_t, crop_r, crop_b))
    cropped.save(out_path)
    print(f"Clip-composited: {cropped.size} {cropped.mode}")


def extract_fx(layer):
    """
    Extract layer effects (stroke, drop shadow) and print Unity TMPInstancingUtil mappings.
    """
    block = layer.tagged_blocks.get(Tag.OBJECT_BASED_EFFECTS_LAYER_INFO)
    if not block:
        print("No object-based effects found.")
        return

    data = block.data
    scale = data.get(b'Scl ', 100.0) / 100.0  # percentage → multiplier

    print(f"\n=== Layer FX: '{layer.name}' (scale={scale:.3f}) ===")

    # Stroke (FrFX = Frame Fill Effect = Stroke)
    stroke = data.get(b'FrFX')
    if stroke and stroke.get(b'enab'):
        color = stroke[b'Clr ']
        r, g, b_val = color[b'Rd  '] / 255.0, color[b'Grn '] / 255.0, color[b'Bl  '] / 255.0
        size_px = stroke[b'Sz  '] * scale
        opacity = stroke[b'Opct'] / 100.0
        print(f"\nStroke (FX → TMPInstancingUtil):")
        print(f"  PSD: size={stroke[b'Sz  ']}px × scale={scale:.2f} → {size_px:.1f}px, color=({int(r*255)},{int(g*255)},{int(b_val*255)}), opacity={opacity:.0%}")
        # In TMP SDF, OutlineThickness 0..1 controls stroke width relative to glyph
        # Approximate: size_px / (fontSize_px * 0.25)  -- tune per font
        thickness_approx = min(0.5, size_px / 30.0)
        print(f"  Unity: m_OutlineColor: {{r:{r:.3f}, g:{g:.3f}, b:{b_val:.3f}, a:{opacity:.3f}}}")
        print(f"         m_OutlineThickness: {thickness_approx:.2f}  (tune visually)")

    # Drop Shadow (DrSh)
    shadow = data.get(b'DrSh')
    if shadow and shadow.get(b'enab'):
        color = shadow[b'Clr ']
        r, g, b_val = color[b'Rd  '] / 255.0, color[b'Grn '] / 255.0, color[b'Bl  '] / 255.0
        opacity = shadow[b'Opct'] / 100.0
        distance = shadow[b'Dstn'] * scale
        blur = shadow[b'blur'] * scale
        angle_deg = shadow[b'lagl']  # angle FROM which light comes
        import math
        # Shadow offset: positive distance in direction opposite to light angle
        rad = math.radians(angle_deg)
        # PSD: angle=90° means light from top → shadow goes down
        # OffsetX = distance * sin(angle), OffsetY = -distance * cos(angle)
        # In TMP UV space: scale down significantly (SDF units ~0-1)
        scale_factor = 0.005  # tune: larger = bigger offset
        ox = distance * math.sin(math.radians(angle_deg)) * scale_factor
        oy = -distance * math.cos(math.radians(angle_deg)) * scale_factor
        dilate = min(0.3, blur * 0.003)
        softness = min(0.5, blur * 0.005)
        print(f"\nDrop Shadow (FX → TMPInstancingUtil):")
        print(f"  PSD: color=({int(r*255)},{int(g*255)},{int(b_val*255)}), opacity={opacity:.0%}, dist={distance:.1f}px, blur={blur:.1f}px, angle={angle_deg}°")
        print(f"  Unity: m_UnderlayColor: {{r:{r:.3f}, g:{g:.3f}, b:{b_val:.3f}, a:{opacity:.3f}}}")
        print(f"         m_OffsetX: {ox:.3f}")
        print(f"         m_OffsetY: {oy:.3f}")
        print(f"         m_UnderlayDilate: {dilate:.3f}")
        print(f"         m_UnderlaySoftness: {softness:.3f}")


def extract_layer_tree(psd, group_path, max_depth=None):
    """
    Extract the full layer tree of a group as JSON with all data PixelPeep needs:
    bounds, text (font/size/color/alignment), FX (stroke/shadow/gradient), solidfill colors, PPI.
    Returns JSON string.
    """
    import json

    # PPI — extract from RESOLUTION_INFO image resource (ID 1005)
    ppi = None
    try:
        from psd_tools.constants import Resource
        import struct
        res_data = psd.image_resources[Resource.RESOLUTION_INFO].data.tobytes()
        h_int = struct.unpack('>H', res_data[0:2])[0]
        h_frac = struct.unpack('>H', res_data[2:4])[0]
        ppi = round(h_int + h_frac / 65536.0)
    except Exception:
        pass

    # No group (or an explicit root marker) walks the whole document; callers
    # tried "", "__ROOT__" and omitting it, and all used to fail.
    is_root = group_path is None or group_path.strip() in ROOT_PATHS
    group = psd if is_root else get_layer_by_path(psd, group_path)
    if not is_root and not group.is_group():
        raise ToolError(f"'{group_path}' is a {group.kind} layer, not a group")
    group_path = "" if is_root else group_path

    def get_color(c):
        """Extract RGB from psd-tools Descriptor color object."""
        return {"r": round(float(c[b'Rd  '])), "g": round(float(c[b'Grn '])), "b": round(float(c[b'Bl  ']))}

    def extract_gradient_overlay(layer):
        try:
            for e in layer.effects:
                if type(e).__name__ == 'GradientOverlay' and e.enabled:
                    g = e.gradient
                    colors = g[b'Clrs']
                    if len(colors) >= 2:
                        s0, s1 = colors[0][b'Clr '], colors[1][b'Clr ']
                        return {
                            "top_color": {"r": round(float(s0[b'Rd  '])), "g": round(float(s0[b'Grn '])), "b": round(float(s0[b'Bl  ']))},
                            "bottom_color": {"r": round(float(s1[b'Rd  '])), "g": round(float(s1[b'Grn '])), "b": round(float(s1[b'Bl  ']))},
                            "angle": float(e.angle), "scale": float(e.scale), "opacity": float(e.opacity)
                        }
        except (AttributeError, KeyError, TypeError, IndexError):
            pass
        return None

    def extract_stroke(layer):
        try:
            for e in layer.effects:
                if type(e).__name__ == 'Stroke' and e.enabled:
                    return {"size": float(e.size), "color": get_color(e.color)}
        except (AttributeError, KeyError, TypeError):
            pass
        return None

    def extract_dropshadow(layer):
        try:
            for e in layer.effects:
                if type(e).__name__ == 'DropShadow' and e.enabled:
                    return {"distance": float(e.distance), "size": float(e.size),
                            "angle": float(e.angle), "color": get_color(e.color)}
        except (AttributeError, KeyError, TypeError):
            pass
        return None

    def get_solidfill_color(layer):
        tb = layer.tagged_blocks
        # Source 1: SOLID_COLOR_SHEET_SETTING (standard shape fill)
        try:
            data = tb.get_data(Tag.SOLID_COLOR_SHEET_SETTING)
            if data:
                clr = data[b'Clr ']
                return {"r": round(float(clr[b'Rd  '])), "g": round(float(clr[b'Grn '])), "b": round(float(clr[b'Bl  '])), "a": 255}
        except (AttributeError, KeyError, TypeError):
            pass
        # Source 2: VECTOR_STROKE_CONTENT_DATA (fill when stroke settings present)
        try:
            if Tag.VECTOR_STROKE_CONTENT_DATA in tb:
                data = tb[Tag.VECTOR_STROKE_CONTENT_DATA].data
                clr = data[b'Clr ']
                return {"r": round(float(clr[b'Rd  '])), "g": round(float(clr[b'Grn '])), "b": round(float(clr[b'Bl  '])), "a": 255}
        except (AttributeError, KeyError, TypeError):
            pass
        # Source 3: GRADIENT_FILL_SETTING (first color stop)
        try:
            data = tb.get_data(Tag.GRADIENT_FILL_SETTING)
            if data:
                grad = data.get(b'Grad', data)
                if b'Clrs' in grad and len(grad[b'Clrs']) > 0:
                    clr = grad[b'Clrs'][0][b'Clr ']
                    return {"r": round(float(clr[b'Rd  '])), "g": round(float(clr[b'Grn '])), "b": round(float(clr[b'Bl  '])), "a": 255}
        except (AttributeError, KeyError, TypeError):
            pass
        return None

    def get_corner_radius(layer):
        try:
            if not hasattr(layer, 'origination') or not layer.origination:
                return None
            orig = layer.origination[0]
            if type(orig).__name__ == 'Invalidated':
                return None
            if hasattr(orig, 'radii') and orig.radii:
                vals = []
                for k, v in orig.radii.items():
                    if k == b'unitValueQuadVersion':
                        continue
                    try:
                        vals.append(float(v))
                    except (TypeError, ValueError):
                        pass
                return round(sum(vals) / len(vals), 2) if vals else 0
            return 0
        except (AttributeError, KeyError, TypeError, IndexError):
            return None

    def get_text_data(layer):
        try:
            ed = layer.engine_dict
            sr = ed['StyleRun']['RunArray'][0]['StyleSheet']['StyleSheetData']
            font_idx = int(sr.get('Font', 0))
            font_size = float(sr.get('FontSize', 0))
            rd = layer.resource_dict
            fs = rd.get('FontSet', rd.get(b'FontSet', []))
            font_name = "unknown"
            if font_idx < len(fs):
                fn = fs[font_idx].get('Name', fs[font_idx].get(b'Name', 'unknown'))
                font_name = fn.decode() if isinstance(fn, bytes) else str(fn)
            font_name = font_name.strip("'\"")
            fc = sr.get('FillColor', None)
            fr, fg, fb = 255, 255, 255
            if fc:
                vals = fc.get('Values', [1, 0, 0, 0])
                fr = round(float(vals[1]) * 255)
                fg = round(float(vals[2]) * 255)
                fb = round(float(vals[3]) * 255)
            pr = ed['ParagraphRun']['RunArray'][0]['ParagraphSheet']['Properties']
            just = int(pr.get('Justification', 2))
            return {
                "content": layer.text or "", "font": font_name,
                "psd_font_size": font_size,
                "alignment": {0: "LEFT", 1: "RIGHT", 2: "CENTER"}.get(just, "CENTER"),
                "fill_color": {"r": fr, "g": fg, "b": fb, "a": 255}
            }
        except Exception as e:
            return {"content": layer.text or "", "font": "unknown", "psd_font_size": 0,
                    "alignment": "CENTER", "fill_color": {"r": 255, "g": 255, "b": 255, "a": 255},
                    "_error": str(e)}

    layers = []

    def walk(container, parent_path, parent_bounds, depth):
        for layer in container:
            if not layer.visible:
                continue
            path = f"{parent_path}/{layer.name}"
            bbox = layer.bbox
            bounds = {"left": bbox[0], "top": bbox[1], "right": bbox[2], "bottom": bbox[3],
                      "width": bbox[2] - bbox[0], "height": bbox[3] - bbox[1]}
            kind = str(layer.kind)
            is_text = kind == "type"
            is_so = kind == "smartobject"
            is_fill = kind in ("solidcolorfill", "shape")
            is_group = kind == "group"
            is_pixel = kind == "pixel"

            type_str = ("TEXT" if is_text else "SMARTOBJECT" if is_so else "SOLIDFILL" if is_fill
                        else "GROUP" if is_group else "NORMAL")

            entry = {
                "path": path, "name": layer.name, "type": f"LayerKind.{type_str}",
                "visible": True, "depth": depth, "bounds": bounds,
                "parent_path": parent_path, "parent_bounds": parent_bounds,
                "text": None, "fx": None,
                "is_smart_object": is_so,
                "has_clip_mask": getattr(layer._record, 'clipping', 0) == 1 if hasattr(layer, '_record') else False,
                "export_needed": is_so or (is_pixel and bounds["width"] > 0),
                "button_text": None,
                "solidfill_color": get_solidfill_color(layer) if is_fill else None,
                "corner_radius": get_corner_radius(layer) if is_fill else None
            }

            if is_text:
                entry["export_needed"] = False
                entry["text"] = get_text_data(layer)
                entry["fx"] = {
                    "stroke": extract_stroke(layer),
                    "drop_shadow": extract_dropshadow(layer),
                    "gradient_overlay": extract_gradient_overlay(layer)
                }
            if is_fill:
                entry["export_needed"] = False
            if is_group:
                entry["export_needed"] = False

            layers.append(entry)
            if is_group:
                # A group cut off by max_depth says how many children it has,
                # so a clipped walk is never mistaken for an empty group.
                if max_depth is not None and depth >= max_depth:
                    entry["child_count"] = len(list(layer))
                    entry["truncated"] = True
                else:
                    walk(layer, path, bounds, depth + 1)

    bb = (0, 0, psd.width, psd.height) if is_root else group.bbox
    gb = {"left": bb[0], "top": bb[1], "right": bb[2], "bottom": bb[3],
          "width": bb[2] - bb[0], "height": bb[3] - bb[1]}
    walk(group, group_path, gb, 1)

    result = {
        "document": {"width": psd.width, "height": psd.height, "ppi": ppi},
        "target_group": group_path or None,
        "max_depth": max_depth,
        "group_bounds": gb,
        "layers": layers
    }
    return json.dumps(result)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    psd_path = sys.argv[1]
    psd = PSDImage.open(psd_path)

    if sys.argv[2] == "--fx":
        layer_path = sys.argv[3]
        layer = get_layer_by_path(psd, layer_path)
        extract_fx(layer)
    elif sys.argv[2] == "--layer-tree":
        group_path = sys.argv[3] if len(sys.argv) > 3 else ""
        max_depth = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
        print(extract_layer_tree(psd, group_path, max_depth))
    else:
        layer_path = sys.argv[2]
        out_path = sys.argv[3] if len(sys.argv) > 3 else "/tmp/extracted_layer.png"
        layer = get_layer_by_path(psd, layer_path)

        # Clip only layers that are actually clipped. This used to pass the
        # parent group for every nested layer, so an unclipped smart object was
        # cropped to whatever layer sat below it, and a clipped layer at the top
        # level (no parent group) was never clipped at all.
        parent = layer.parent if getattr(layer, "clipping", False) else None

        extract_layer(layer, out_path, apply_clip_context=parent)


if __name__ == "__main__":
    # Errors meant for the caller (and file problems) are one "ERROR:" line on
    # stderr; anything else keeps its traceback for debugging.
    try:
        main()
    except (ToolError, FileNotFoundError, IsADirectoryError, PermissionError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
