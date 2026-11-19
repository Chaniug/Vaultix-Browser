#!/usr/bin/env python3
"""生成 Vaultix Browser 扩展图标（16/32/48/128）。

纯 Pillow 绘制，无外部素材依赖；先在大尺寸绘制再 Lanczos 降采样，
保证小尺寸仍然可辨识。运行：python3 scripts/generate-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
SIZE = 512


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(size: int) -> Image.Image:
    """从薄荷绿到蓝紫的垂直渐变，带圆角。"""
    top = (94, 227, 190)
    bottom = (58, 169, 214)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    radius = int(size * 0.22)
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(lerp(top[i], bottom[i], t) for i in range(3)) + (255,)
        for x in range(size):
            # 圆角判定
            cx = min(max(x, radius), size - radius)
            cy = min(max(y, radius), size - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius**2 or (
                radius <= x <= size - radius or radius <= y <= size - radius
            ):
                px[x, y] = color
    return img


def draw() -> Image.Image:
    img = gradient(SIZE)
    d = ImageDraw.Draw(img)
    ink = (13, 19, 34, 255)
    accent = (238, 255, 250, 255)

    # 锁体
    body = (int(SIZE * 0.25), int(SIZE * 0.44), int(SIZE * 0.75), int(SIZE * 0.80))
    d.rounded_rectangle(body, radius=int(SIZE * 0.075), fill=ink)

    # 锁梁（半圆弧）
    cx, cy = SIZE // 2, int(SIZE * 0.44)
    r = int(SIZE * 0.155)
    d.arc(
        (cx - r, cy - r, cx + r, cy + r),
        start=180,
        end=360,
        fill=ink,
        width=int(SIZE * 0.052),
    )

    # 钥匙孔：圆 + 梯形柄
    kr = int(SIZE * 0.052)
    kx, ky = cx, int(SIZE * 0.575)
    d.ellipse((kx - kr, ky - kr, kx + kr, ky + kr), fill=accent)
    half_top = int(SIZE * 0.018)
    half_bottom = int(SIZE * 0.034)
    y1 = ky + kr - int(SIZE * 0.006)
    y2 = int(SIZE * 0.735)
    d.polygon(
        [
            (kx - half_top, y1),
            (kx + half_top, y1),
            (kx + half_bottom, y2),
            (kx - half_bottom, y2),
        ],
        fill=accent,
    )

    # 锁体高光，增加层次
    d.rounded_rectangle(
        (
            body[0] + int(SIZE * 0.03),
            body[1] + int(SIZE * 0.03),
            body[2] - int(SIZE * 0.03),
            body[1] + int(SIZE * 0.075),
        ),
        radius=int(SIZE * 0.02),
        fill=(38, 52, 76, 255),
    )
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = draw()
    for size in (16, 32, 48, 128):
        master.resize((size, size), Image.Resampling.LANCZOS).save(
            OUT / f"icon-{size}.png", optimize=True
        )
    print("生成图标:", ", ".join(str(p.name) for p in sorted(OUT.glob("*.png"))))


if __name__ == "__main__":
    main()
