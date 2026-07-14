#!/usr/bin/env python3
"""Download a (local) LifePath project from a running HTTP server.

Useful when you only know the port (e.g. http://localhost:8001) and want a
filesystem copy of the served files.

This is a small crawler for same-origin links. It understands:
- regular HTML pages with <script src>, <link href>, <a href>
- Python SimpleHTTPRequestHandler directory listings (also <a href>)

It will not try to fetch external resources.

Example:
  python3 tools/extract_from_lifepath_http.py --base http://localhost:8001 --out extracted-8001
"""

from __future__ import annotations

import argparse
import posixpath
import re
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


_STATIC_ASSET_EXTS = {
    ".css",
    ".js",
    ".json",
    ".png",
    ".jpg",
    ".jpeg",
    ".svg",
    ".webp",
    ".gif",
    ".ico",
    ".otf",
    ".ttf",
    ".woff",
    ".woff2",
    ".mp3",
    ".wav",
    ".mp4",
    ".webm",
}


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "a":
            href = attrs_dict.get("href")
            if href:
                self.links.append(href)
        elif tag == "link":
            href = attrs_dict.get("href")
            if href:
                self.links.append(href)
        elif tag == "script":
            src = attrs_dict.get("src")
            if src:
                self.links.append(src)
        elif tag == "img":
            src = attrs_dict.get("src")
            if src:
                self.links.append(src)


@dataclass(frozen=True)
class CrawlItem:
    url: str


def _normalize_url(url: str) -> str:
    """Normalize URL so it can be used as a stable key."""
    p = urlparse(url)
    # Remove fragment, keep query (directory listings sometimes depend on it).
    p = p._replace(fragment="")
    return urlunparse(p)


def _same_origin(a: str, b: str) -> bool:
    pa, pb = urlparse(a), urlparse(b)
    return (pa.scheme, pa.netloc) == (pb.scheme, pb.netloc)


def _url_path_to_relpath(url: str) -> Path:
    p = urlparse(url)
    path = p.path
    if not path or path.endswith("/"):
        path = path + "index.html"
    # Drop leading slash so it's relative.
    path = path.lstrip("/")
    # Avoid weird traversal.
    path = posixpath.normpath(path)
    if path.startswith("../") or path == "..":
        raise ValueError(f"Refusing to write outside output dir for path: {p.path!r}")
    return Path(path)


def _fetch(url: str) -> tuple[bytes, str]:
    req = Request(url, headers={"User-Agent": "lifepath-extractor", "Accept": "*/*"})
    with urlopen(req, timeout=15) as resp:
        body = resp.read()
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        return body, ctype


def _extract_links(base_url: str, html_bytes: bytes, page_url: str) -> Iterable[str]:
    try:
        html_text = html_bytes.decode("utf-8", errors="replace")
    except Exception:
        return []

    parser = LinkParser()
    parser.feed(html_text)

    # Also catch a few common JS/CSS URL patterns in case they appear in inline code.
    # Keep it conservative to avoid sucking in random text.
    for m in re.finditer(r"(?:href|src)\s*=\s*['\"]([^'\"]+)['\"]", html_text, flags=re.I):
        parser.links.append(m.group(1))

    out: list[str] = []
    for raw in parser.links:
        raw = raw.strip()
        if not raw:
            continue
        if raw.startswith("mailto:") or raw.startswith("tel:"):
            continue
        # Ignore external absolute URLs.
        abs_url = urljoin(page_url, raw)
        if not _same_origin(base_url, abs_url):
            continue
        out.append(abs_url)

    return out


def _extract_links_from_css(base_url: str, css_bytes: bytes, page_url: str) -> Iterable[str]:
    try:
        css_text = css_bytes.decode("utf-8", errors="replace")
    except Exception:
        return []

    candidates: list[str] = []

    # @import "foo.css"; or @import url("foo.css");
    for m in re.finditer(
        r"@import\s+(?:url\()?\s*(['\"]?)([^'\"\)\s;]+)\1\s*\)?\s*;",
        css_text,
        flags=re.I,
    ):
        candidates.append(m.group(2))

    # url(...) references (fonts, images, etc)
    for m in re.finditer(r"url\(\s*(['\"]?)([^'\"\)]+)\1\s*\)", css_text, flags=re.I):
        candidates.append(m.group(2))

    out: list[str] = []
    for raw in candidates:
        raw = raw.strip()
        if not raw:
            continue
        if raw.startswith("data:"):
            continue
        abs_url = urljoin(page_url, raw)
        if not _same_origin(base_url, abs_url):
            continue
        out.append(abs_url)
    return out


def _extract_links_from_js(base_url: str, js_bytes: bytes, page_url: str) -> Iterable[str]:
    try:
        js_text = js_bytes.decode("utf-8", errors="replace")
    except Exception:
        return []

    # Conservative: only pull string literals that look like static assets.
    # Avoid crawling API endpoints like "/api/health".
    pattern = re.compile(
        r"(?P<q>['\"`])(?P<path>[^'\"`\n\r]+?\.(?:css|js|json|png|jpe?g|svg|webp|gif|ico|otf|ttf|woff2?|mp3|wav|mp4|webm))(?:\?[^'\"`\n\r]*)?(?P=q)",
        flags=re.I,
    )

    out: list[str] = []
    for m in pattern.finditer(js_text):
        raw = m.group("path").strip()
        if not raw:
            continue
        # Skip template-string placeholders and other runtime-generated URLs.
        if "${" in raw:
            continue
        abs_url = urljoin(page_url, raw)
        if not _same_origin(base_url, abs_url):
            continue
        out.append(abs_url)
    return out


def _write_file(out_dir: Path, url: str, body: bytes) -> Path:
    rel = _url_path_to_relpath(url)
    dest = out_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return dest


def crawl(base_url: str, out_dir: Path, *, max_pages: int = 2000) -> None:
    base_url = base_url.rstrip("/") + "/"
    out_dir.mkdir(parents=True, exist_ok=True)

    queue: list[CrawlItem] = [CrawlItem(url=base_url)]
    seen: set[str] = set()
    pages = 0

    while queue:
        item = queue.pop(0)
        url = _normalize_url(item.url)
        if url in seen:
            continue
        seen.add(url)

        try:
            body, ctype = _fetch(url)
        except Exception as e:
            print(f"[warn] fetch failed: {url} ({e})", file=sys.stderr)
            continue

        try:
            dest = _write_file(out_dir, url, body)
        except Exception as e:
            print(f"[warn] write failed: {url} ({e})", file=sys.stderr)
            continue

        pages += 1
        print(f"[ok] {url} -> {dest}")
        if pages >= max_pages:
            print(f"[warn] Reached max_pages={max_pages}, stopping.", file=sys.stderr)
            break

        parsed_path = urlparse(url).path.lower()

        is_html = ctype in ("text/html", "application/xhtml+xml")
        is_css = ctype == "text/css" or parsed_path.endswith(".css")
        is_js = ctype in ("application/javascript", "text/javascript") or parsed_path.endswith(".js")

        discovered: list[str] = []
        # Many directory listings come back as text/html.
        if is_html:
            discovered.extend(_extract_links(base_url, body, url))
        elif is_css:
            discovered.extend(_extract_links_from_css(base_url, body, url))
        elif is_js:
            discovered.extend(_extract_links_from_js(base_url, body, url))

        for link in discovered:
            n = _normalize_url(link)
            if n not in seen:
                # Avoid crawling endless non-file routes when parsing JS.
                ext = Path(urlparse(n).path).suffix.lower()
                if ext and ext not in _STATIC_ASSET_EXTS and not n.endswith("/"):
                    continue
                queue.append(CrawlItem(url=n))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Base URL, e.g. http://localhost:8001")
    ap.add_argument("--out", required=True, help="Output directory")
    ap.add_argument("--max-pages", type=int, default=2000)
    args = ap.parse_args(argv)

    out_dir = Path(args.out).expanduser().resolve()
    crawl(args.base, out_dir, max_pages=args.max_pages)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
