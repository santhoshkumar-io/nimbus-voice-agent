"""No-cache static server for the Nimbus site.

Plain `python -m http.server` lets browsers heuristically cache index.html, so
config migrations and JS fixes can fail to reach the user. This server sends
`Cache-Control: no-store` on every response, guaranteeing a fresh fetch.
Serves the site dir (which contains a `playground` symlink) so the site is at
the tunnel root (/) and the playground at /playground/.

Usage: python3 serve_nocache.py [PORT] [ROOT]
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8200
ROOT = sys.argv[2] if len(sys.argv) > 2 else \
    "/home/ubuntu/agents/build-voice-agent-live/nimbus-voice-agent-starter"

os.chdir(ROOT)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), NoCacheHandler) as httpd:
    print(f"serving {ROOT} on :{PORT} (no-store)")
    httpd.serve_forever()
