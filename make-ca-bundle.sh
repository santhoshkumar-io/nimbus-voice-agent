#!/usr/bin/env bash
# Export this machine's trust store (macOS keychain) to a PEM bundle.
#
# Why: this machine terminates TLS through an inspecting proxy. `curl` trusts it
# via the keychain, but Python (httpx/certifi) and Node (the Vercel CLI) ship their
# own CA stores and do not, so outbound HTTPS fails with:
#   Python: [SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate chain
#   Node:   Error: self-signed certificate in certificate chain
# Both are easy to misread as a bad API key or a network outage.
#
# Usage:  ./make-ca-bundle.sh   then export the vars it prints.
set -euo pipefail
cd "$(dirname "$0")"

OUT="certs/macos-ca.pem"
mkdir -p certs
: > "$OUT"
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >> "$OUT" 2>/dev/null || true
security find-certificate -a -p /Library/Keychains/System.keychain                        >> "$OUT" 2>/dev/null || true
security find-certificate -a -p "$HOME/Library/Keychains/login.keychain-db"                >> "$OUT" 2>/dev/null || true

N=$(grep -c 'BEGIN CERTIFICATE' "$OUT" || echo 0)
[ "$N" -gt 0 ] || { echo "ERROR: no certificates exported"; exit 1; }
echo "wrote $OUT ($N certificates)"
echo
echo "Export these (add to your shell profile to make it permanent):"
echo "  export SSL_CERT_FILE=\"$(pwd)/$OUT\"        # Python / httpx"
echo "  export REQUESTS_CA_BUNDLE=\"$(pwd)/$OUT\"   # requests"
echo "  export NODE_EXTRA_CA_CERTS=\"$(pwd)/$OUT\"  # Node / Vercel CLI"
