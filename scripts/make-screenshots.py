#!/usr/bin/env python3
"""生成 Chrome 应用商店截图（1280×800）。

用本地 HTTP 服务加载真实构建产物，注入最小 chrome mock，
因此截图展示的是扩展的真实界面而不是另行绘制的效果图。
运行：python3 scripts/make-screenshots.py
"""
import functools
import http.server
import re
import shutil
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "store-assets"
PREVIEW = ASSETS / ".preview"
PORT = 8099

MOCK = """
<script>
window.chrome = {
  runtime: {
    sendMessage: async (m) => {
      switch (m.type) {
        case 'vaultix:status':
          return { state: 'unlocked', bitwardenReady: true, keepassReady: false,
                   needsAssociation: false, canWrite: true, defaultSaveSource: 'bitwarden' };
        case 'vaultix:search':
          return { ambiguous: false, items: [
            { id: '1', source: 'bitwarden', name: 'GitHub · 工作账号',
              username: 'dev@studio.dev', password: 'demo-password' },
            { id: '2', source: 'keepassxc', name: 'mail.example.com',
              username: 'alice@example.com', password: 'demo-password', totp: '123 456' },
            { id: '3', source: 'bitwarden', name: '企业邮箱',
              username: 'alice@corp.example', password: 'demo-password' }
          ]};
        case 'vaultix:pending-save':
          return { draft: { url: 'https://console.example.com/login',
                            username: 'alice@example.com', password: 'demo-password' },
                   sources: ['bitwarden', 'keepassxc'] };
        case 'vaultix:fill':
        case 'vaultix:copy':
        case 'vaultix:save-decision':
          return { ok: true };
        default:
          return { ok: true };
      }
    },
    openOptionsPage: async () => {}
  },
  tabs: { query: async () => [{ url: 'https://github.com/login', title: 'GitHub' }] },
  storage: {
    local: {
      get: async () => ({
        mode: 'bitwarden.cloud', email: 'alice@example.com',
        serverUrl: '', backgroundLockMs: 300000, idleLockMs: 900000,
        defaultSaveSource: 'bitwarden'
      }),
      set: async () => {}
    }
  }
};
</script>
"""

POPUP_STAGE_CSS = """
<style>
  html { background: #0b101c; }
  body.popup {
    width: 1280px; height: 100vh; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(900px 600px at 78% 45%, #1a2b46 0%, #0b101c 68%);
  }
  .popup-shell {
    width: 358px; max-height: 640px; border: 1px solid #34405a;
    border-radius: 18px; box-shadow: 0 30px 90px rgba(0,0,0,.65);
    transform: translate(200px, 0);
  }
  .stage-copy { position: absolute; left: 88px; top: 196px; max-width: 470px; }
  .stage-copy .eyebrow { color: #5ee3be; font-size: 13px; letter-spacing: 3px; font-weight: 700; }
  .stage-copy h1 { margin: 16px 0 12px; font-size: 46px; line-height: 1.12; letter-spacing: -1px; }
  .stage-copy p { margin: 0 0 28px; color: #9aa7bf; font-size: 17px; line-height: 1.7; }
  .stage-copy li { margin: 12px 0; color: #d7dfec; font-size: 15px; list-style: none; }
  .stage-copy li::before { content: '→'; color: #5ee3be; margin-right: 12px; font-weight: 700; }
</style>
"""

POPUP_COPY = """
<div class="stage-copy">
  <div class="eyebrow">VAULTIX BROWSER</div>
  <h1>一个入口<br />两个密码库</h1>
  <p>在 Bitwarden / Vaultwarden 与 KeePassXC 之间<br />统一取用与保存登录凭证。</p>
  <ul>
    <li>按当前站点自动匹配、一键填充</li>
    <li>新密码确认后写回你自己的密码库</li>
    <li>主密码与明文凭证永不落盘</li>
  </ul>
</div>
"""

OPTIONS_STAGE_CSS = """
<style>
  html { background: #0b101c; }
  body.options { padding: 10px 40px; }
  .options-page { max-width: 1080px; }
  .options-header { margin-bottom: 8px; }
  .card { margin-bottom: 6px; }
  .card-head { padding: 7px 16px; }
  .card-body { padding: 7px 16px; }
  .field { margin-bottom: 5px; }
  .field input, .field select { padding: 6px 10px; }
  .callout, .options-footer { display: none; }
  .page-actions { margin-top: 6px; }
</style>
"""


def make_preview(
    name: str, source: Path, css: str, extra: str, mock: str = MOCK
) -> Path:
    html = source.read_text(encoding="utf-8")
    html = html.replace('href="shared.css"', 'href="/dist/ui/shared.css"')
    html = html.replace('src="popup.js"', 'src="/dist/ui/popup.js"')
    html = html.replace('src="options.js"', 'src="/dist/ui/options.js"')
    html = html.replace("</head>", f"{css}</head>")
    html = html.replace("<script", f"{mock}<script", 1)
    html = html.replace("</body>", f"{extra}</body>")
    target = PREVIEW / name
    target.write_text(html, encoding="utf-8")
    return target


def shoot(url: str, out: Path, width: int = 1280, height: int = 800) -> None:
    out.unlink(missing_ok=True)
    subprocess.run(
        [
            "google-chrome",
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={width},{height}",
            f"--screenshot={out}",
            url,
        ],
        check=True,
        capture_output=True,
        timeout=90,
    )


def main() -> None:
    PREVIEW.mkdir(parents=True, exist_ok=True)
    make_preview("popup.html", ROOT / "ui" / "popup.html", POPUP_STAGE_CSS, POPUP_COPY)
    make_preview("popup-locked.html", ROOT / "ui" / "popup.html", POPUP_STAGE_CSS, POPUP_COPY,
                 MOCK.replace("state: 'unlocked'", "state: 'locked'"))
    make_preview(
        "options.html", ROOT / "ui" / "options.html", OPTIONS_STAGE_CSS, ""
    )

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(ROOT)
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        shoot(
            f"http://127.0.0.1:{PORT}/store-assets/.preview/popup.html",
            ASSETS / "screenshot-1.png",
        )
        shoot(
            f"http://127.0.0.1:{PORT}/store-assets/.preview/options.html",
            ASSETS / "screenshot-2.png",
        )
        shoot(
            f"http://127.0.0.1:{PORT}/store-assets/.preview/popup-locked.html",
            ASSETS / "screenshot-3.png",
        )
    finally:
        server.shutdown()
        server.server_close()

    # 商店还接受 440×280 小图与 920×680 宣传图；从主图裁切并缩放
    from PIL import Image

    main_shot = Image.open(ASSETS / "screenshot-1.png").convert("RGB")
    small = main_shot.resize((440, 275), Image.Resampling.LANCZOS)
    small_canvas = Image.new("RGB", (440, 280), (11, 16, 28))
    small_canvas.paste(small, (0, 2))
    small_canvas.save(ASSETS / "small-promo-440x280.png")

    crop_w = round(main_shot.height * (920 / 680))
    left = (main_shot.width - crop_w) // 2
    promo = main_shot.crop((left, 0, left + crop_w, main_shot.height)).resize(
        (920, 680), Image.Resampling.LANCZOS
    )
    promo.save(ASSETS / "promo-920x680.png")
    shutil.copy(ROOT / "icons" / "icon-128.png", ASSETS / "icon-128.png")
    for file in sorted(ASSETS.glob("*.png")):
        print(f"{file.name}: {file.stat().st_size} bytes")


if __name__ == "__main__":
    main()
