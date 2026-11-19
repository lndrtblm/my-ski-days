"""Bouwt de map publish/ voor de online (privé) versie op claude.ai.

    python -I publiceer_bouw.py

De lokale app gebruikt één bestand per sessie (data/s/<id>.js, 300+ bestanden). Online mag een
publicatie maar een beperkt aantal bestanden hebben, dus hier worden de sessies gebundeld tot
bestanden van max. ~8 MB, op datumvolgorde (nieuwe sessies komen dus vooral in de laatste bundel).
data/bundles.js vertelt de app welke bundel welke sessie bevat.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "publish"
MAX_BYTES = 8_000_000


def read_index() -> dict:
    text = (DATA / "index.js").read_text(encoding="utf-8")
    return json.loads(text[len("CARV.index("):text.rindex(");")])


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "data").mkdir(parents=True)

    sessions = sorted(read_index()["sessions"], key=lambda s: s.get("start") or "")
    bundles: list[list[str]] = [[]]
    size = 0
    mapping: dict[str, str] = {}
    for s in sessions:
        f = DATA / "s" / f"{s['id']}.js"
        if not f.exists():
            continue
        body = f.read_text(encoding="utf-8")
        n = len(body.encode("utf-8"))
        if bundles[-1] and size + n > MAX_BYTES:
            bundles.append([])
            size = 0
        bundles[-1].append(body)
        size += n
        mapping[s["id"]] = f"b{len(bundles):02d}.js"
    for i, parts in enumerate(bundles, 1):
        (OUT / "data" / f"b{i:02d}.js").write_text("".join(parts), encoding="utf-8")
    (OUT / "data" / "bundles.js").write_text(f"CARV.bundles({json.dumps(mapping)});\n", encoding="utf-8")
    for name in ("index.js", "stretches.js"):
        shutil.copy2(DATA / name, OUT / "data" / name)
    shutil.copy2(ROOT / "app.js", OUT / "app.js")
    shutil.copy2(ROOT / "app.css", OUT / "app.css")
    shutil.copy2(ROOT / "theme-carv.css", OUT / "theme-carv.css")

    # The page itself: claude.ai wraps it in <html><head><body>, so only the contents go here.
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = body.replace('<script src="data/index.js"', '<script src="data/bundles.js"></script>\n<script src="data/index.js"')
    page = ('<title>My Ski Days</title>\n<link rel="stylesheet" href="app.css">\n<link rel="stylesheet" href="theme-carv.css">\n' + body.strip() + "\n")
    (OUT / "index.html").write_text(page, encoding="utf-8")

    build_site()
    files = sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*") if p.is_file())
    total = sum((OUT / f).stat().st_size for f in files) / 1e6
    print(f"publish/: {len(files)} bestanden, {total:.1f} MB, {len(bundles)} bundels, {len(mapping)} sessies")
    for f in files:
        print(f"  {f}  {(OUT / f).stat().st_size / 1e6:.1f} MB")


SITE = ROOT / "site"


def build_site() -> None:
    """site/: the internet version (Cloudflare Pages): a full HTML page with app icon and
    home-screen settings. It contains NO data: online-zetten.ps1 adds the data encrypted
    (site/data/*.bin) from publish/data with versleutel.mjs."""
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir()
    for name in ("app.js", "app.css", "theme-carv.css", "icon.png", "icon-512.png", "manifest.webmanifest"):
        shutil.copy2(ROOT / name, SITE / name)
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    html = re.sub(r'<script src="data/index\.js"[^>]*></script>',
                  '<script>window.CARV_SECURE = true; CARV.secureBoot();</script>', html)
    html = html.replace('<script src="app.js">', '<script>window.CARV_SECURE = true;</script>\n<script src="app.js">')
    (SITE / "index.html").write_text(html, encoding="utf-8")
    # Never in search engines; always check for a newer version of the data.
    (SITE / "_headers").write_text("/*\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-cache\n", encoding="utf-8")


if __name__ == "__main__":
    main()
