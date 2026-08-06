"""Lightweight stdlib-only static file server for the message archive UI.

All data loading/filtering happens client-side now (see static/app.js) —
this just serves the static/ directory so you can point a browser at it.
Any static host (GitHub Pages, Netlify, `python -m http.server`, etc.) works
just as well; this file is kept around for local convenience.
"""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(__file__)
STATIC_DIR = os.path.join(BASE_DIR, "static")

PORT = int(os.environ.get("PORT", 8420))

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".ttf": "font/ttf",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def _send_file(self, path, content_type):
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = "/index.html" if self.path == "/" else self.path
        ext = os.path.splitext(path)[1]
        content_type = CONTENT_TYPES.get(ext)
        if not content_type:
            self.send_error(404)
            return

        file_path = os.path.join(STATIC_DIR, path.lstrip("/"))
        if not os.path.abspath(file_path).startswith(os.path.abspath(STATIC_DIR)):
            self.send_error(403)
            return

        try:
            self._send_file(file_path, content_type)
        except FileNotFoundError:
            self.send_error(404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving on http://127.0.0.1:{PORT}")
    server.serve_forever()
