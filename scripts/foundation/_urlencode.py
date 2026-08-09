#!/usr/bin/env python3
"""URL-encode a single value read from stdin; print the encoded value to stdout.

Non-secret helper used by scripts/foundation/dbguard.sh. The value (a database
password) is passed via stdin only, never via argv, so it does not appear in
process arguments. Nothing is echoed on error.
"""
import sys
import urllib.parse

value = sys.stdin.read().strip()
# RFC 3986 unreserved characters stay as-is; everything else is percent-encoded.
sys.stdout.write(urllib.parse.quote(value, safe=""))
