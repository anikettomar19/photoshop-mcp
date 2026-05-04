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


def get_layer_by_path(psd, path: str):
    """Navigate to a layer by slash-separated path."""
    parts = path.strip("/").split("/")
    node = psd
    for part in parts:
        found = None
        for layer in node:
            if layer.name == part:
                found = layer
                break
        if found is None:
            raise ValueError(f"Layer not found: '{part}' in path '{path}'")
        node = found
    return node


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
            so.save(out_path)
            img = Image.open(out_path)
            print(f"Extracted Smart Object: {img.size} {img.mode}")
    else:
        img = layer.composite()
        if img is None:
            print(f"Warning: composite() returned None for '{layer.name}'")
            return
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

    # Locate target in layer list
    target_idx = next((i for i, l in enumerate(layers) if l.name == target_layer.name), None)
    if target_idx is None:
        raise ValueError("Target layer not found in parent group")

    # Find the clip base: first non-clipping layer below target
    clip_base = None
    for i in range(target_idx - 1, -1, -1):
        l = layers[i]
        if not getattr(l, 'clipping', False):
            clip_base = l
            break

    # Extract raw Smart Object to a temp file
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as f:
        raw_path = f.name
    target_layer.smart_object.save(raw_path)
    raw_img = Image.open(raw_path).convert("RGBA")
    os.unlink(raw_path)

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


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    psd_path = sys.argv[1]
    psd = PSDImage.open(psd_path)

    if sys.argv[2] == "--fx":
        layer_path = sys.argv[3]
        layer = get_layer_by_path(psd, layer_path)
        extract_fx(layer)
    else:
        layer_path = sys.argv[2]
        out_path = sys.argv[3] if len(sys.argv) > 3 else "/tmp/extracted_layer.png"
        layer = get_layer_by_path(psd, layer_path)

        # Auto-detect if layer needs clip context (parent group)
        path_parts = layer_path.split("/")
        if len(path_parts) > 1:
            parent_path = "/".join(path_parts[:-1])
            parent = get_layer_by_path(psd, parent_path)
        else:
            parent = None

        extract_layer(layer, out_path, apply_clip_context=parent)
