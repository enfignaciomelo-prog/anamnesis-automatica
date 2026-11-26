"""Genera los íconos PNG de la PWA (se ejecuta una vez; los PNG se versionan)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

INK = (22, 38, 58)
PAPER = (243, 246, 245)
LISTEN = (194, 54, 43)
WASH = (176, 197, 228)


def icon(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGB", (size, size), INK if maskable else PAPER)
    d = ImageDraw.Draw(img)
    pad = int(size * (0.2 if maskable else 0.12))
    if not maskable:
        d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=int(size * 0.14), fill=INK)
    # Tres renglones de ficha; el del medio subrayado como respaldo.
    x0, x1 = int(size * 0.3), int(size * 0.7)
    for i, frac in enumerate((0.38, 0.5, 0.62)):
        y = int(size * frac)
        h = max(2, int(size * 0.035))
        if i == 1:
            d.rectangle([x0, y - h, x1, y + h * 2], fill=WASH)
        d.rectangle([x0, y - h // 2, x1 if i != 2 else int(size * 0.58), y + h // 2], fill=PAPER)
    r = int(size * 0.055)
    cx, cy = int(size * 0.7), int(size * 0.3)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LISTEN)
    return img


def main(out: str) -> None:
    o = Path(out)
    o.mkdir(parents=True, exist_ok=True)
    icon(192).save(o / "icon-192.png")
    icon(512).save(o / "icon-512.png")
    icon(512, maskable=True).save(o / "icon-maskable-512.png")
    icon(180).save(o / "apple-touch-icon.png")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/icons")
