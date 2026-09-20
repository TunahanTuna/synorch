#!/usr/bin/env python3
"""px.py - pixel art pipeline helpers for the pixel-art-assets skill.

Requires Pillow:  pip install pillow

Commands:
  quantize  Downscale to a true pixel grid, snap colors to a palette, binarize alpha
  upscale   Integer nearest-neighbor upscale (review previews; always ship the 1x)
  palette   List unique opaque colors in an image (audit against the style bible)
  sheet     Contact sheet from a folder of PNGs (set-consistency review)

Palette format: comma-separated hex ("1a1c2c,5d275d,b13e53") or a file with one
hex color per line (# prefix and 3-digit shorthand both accepted).
"""
import argparse
import math
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install pillow")


def parse_hex(h: str):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6:
        sys.exit(f"Bad hex color: {h!r}")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load_palette(spec: str):
    path = Path(spec)
    if path.exists():
        raw = path.read_text().replace(",", "\n").splitlines()
    else:
        raw = spec.split(",")
    palette = [parse_hex(item) for item in raw if item.strip()]
    if not palette:
        sys.exit("Empty palette")
    return palette


def nearest(color, palette):
    r, g, b = color
    return min(palette, key=lambda c: (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2)


def out_path(inp: str, suffix: str, explicit: str | None):
    return explicit or str(Path(inp).with_suffix("")) + suffix


def cmd_quantize(a):
    img = Image.open(a.input).convert("RGBA")
    if a.grid:
        try:
            w, h = (int(x) for x in a.grid.lower().split("x"))
        except ValueError:
            sys.exit("--grid expects WIDTHxHEIGHT, e.g. 32x32")
        resample = Image.BOX if a.method == "box" else Image.NEAREST
        img = img.resize((w, h), resample)
    palette = load_palette(a.palette) if a.palette else None
    px = img.load()
    width, height = img.size
    cache = {}
    for y in range(height):
        for x in range(width):
            r, g, b, alpha = px[x, y]
            if alpha < a.alpha_threshold:          # binary alpha: no soft edges
                px[x, y] = (0, 0, 0, 0)
                continue
            if palette:
                key = (r, g, b)
                if key not in cache:
                    cache[key] = nearest(key, palette)
                r, g, b = cache[key]
            px[x, y] = (r, g, b, 255)
    out = out_path(a.input, ".px.png", a.output)
    img.save(out)
    mode = "palette-locked" if palette else "alpha-cleaned"
    print(f"wrote {out} ({width}x{height}, {mode})")


def cmd_upscale(a):
    img = Image.open(a.input).convert("RGBA")
    img = img.resize((img.width * a.factor, img.height * a.factor), Image.NEAREST)
    out = out_path(a.input, f".x{a.factor}.png", a.output)
    img.save(out)
    print(f"wrote {out} ({img.width}x{img.height})")


def cmd_palette(a):
    img = Image.open(a.input).convert("RGBA")
    counts = {}
    for r, g, b, alpha in img.getdata():
        if alpha >= 128:
            counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    print(f"{len(counts)} opaque colors in {a.input}")
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    for (r, g, b), n in ranked[: a.top]:
        print(f"  #{r:02x}{g:02x}{b:02x}  x{n}")
    if len(ranked) > a.top:
        print(f"  ... and {len(ranked) - a.top} more")


def cmd_sheet(a):
    files = sorted(Path(a.folder).glob("*.png"))
    if not files:
        sys.exit(f"no PNGs in {a.folder}")
    images = [Image.open(f).convert("RGBA") for f in files]
    cell_w = max(i.width for i in images) * a.scale + a.pad
    cell_h = max(i.height for i in images) * a.scale + a.pad
    cols = a.cols or max(1, math.ceil(math.sqrt(len(images))))
    rows = math.ceil(len(images) / cols)
    bg = (*parse_hex(a.bg), 255)
    sheet = Image.new("RGBA", (cols * cell_w + a.pad, rows * cell_h + a.pad), bg)
    for idx, img in enumerate(images):
        img = img.resize((img.width * a.scale, img.height * a.scale), Image.NEAREST)
        cx = a.pad + (idx % cols) * cell_w
        cy = a.pad + (idx // cols) * cell_h
        sheet.paste(img, (cx, cy), img)
    sheet.save(a.output)
    print(f"wrote {a.output} ({len(images)} assets, {cols}x{rows} grid)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    q = sub.add_parser("quantize", help="downscale + palette lock + binary alpha")
    q.add_argument("input")
    q.add_argument("--grid", help="target grid WIDTHxHEIGHT, e.g. 32x32 (omit to keep size)")
    q.add_argument("--method", choices=["box", "nearest"], default="box",
                   help="box = average then snap (best for AI cleanup), nearest = crisp sampling")
    q.add_argument("--palette", help="hex list or palette file; omit to only clean alpha")
    q.add_argument("--alpha-threshold", type=int, default=128)
    q.add_argument("--output", "-o")
    q.set_defaults(func=cmd_quantize)

    u = sub.add_parser("upscale", help="integer nearest-neighbor preview")
    u.add_argument("input")
    u.add_argument("--factor", "-f", type=int, default=8)
    u.add_argument("--output", "-o")
    u.set_defaults(func=cmd_upscale)

    p = sub.add_parser("palette", help="audit unique opaque colors")
    p.add_argument("input")
    p.add_argument("--top", type=int, default=40)
    p.set_defaults(func=cmd_palette)

    s = sub.add_parser("sheet", help="contact sheet of a folder of PNGs")
    s.add_argument("folder")
    s.add_argument("--scale", type=int, default=4)
    s.add_argument("--cols", type=int)
    s.add_argument("--pad", type=int, default=8)
    s.add_argument("--bg", default="202020")
    s.add_argument("--output", "-o", default="contact-sheet.png")
    s.set_defaults(func=cmd_sheet)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

