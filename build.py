#!/usr/bin/env python3
"""Build Scaredy GmCat's static site: site/ -> dist/ with cache-busting version tags. Claude, 2026-11-19."""
import shutil, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent
SRC, DIST = ROOT / "site", ROOT / "dist"
BUILD = time.strftime("%Y%m%d%H%M", time.gmtime())
if DIST.exists():
    shutil.rmtree(DIST)
shutil.copytree(SRC, DIST)
import re
for f in list(DIST.rglob("*.html")) + [DIST / "scaredy.js"]:
    t = f.read_text("utf-8").replace("?v=BUILD", "?v=" + BUILD)
    t = re.sub(r'(/img/[a-z0-9-]+\.png)(?![?\w])', r'\1?v=' + BUILD, t)   # pictures are cached 7 days: version them too
    f.write_text(t, "utf-8")
(DIST / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://scaredy.gmcat.io/sitemap.xml\n")
(DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://scaredy.gmcat.io/</loc></url><url><loc>https://scaredy.gmcat.io/how-to/</loc></url></urlset>\n')
print("built", BUILD)
