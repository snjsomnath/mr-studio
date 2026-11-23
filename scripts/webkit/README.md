# WebKit probes (macOS)

The Mac app draws with WKWebView, which differs from Chromium. These load a page in a real
WKWebView and save a snapshot, without needing Screen Recording permission.

    swift scripts/webkit/snap.swift <url-or-file> <out.png> <seconds> [width] [height] [js]

`filter-probe.html` checks which CSS filters WebKit draws over WebGL (the colour pass, #181).
