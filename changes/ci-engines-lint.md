---
bump: none
issues: 261, 264
---
### Every pull request is tried in the Mac's and Windows' browser engines

CI now runs the end-to-end check on every pull request, plus a smoke test that turns every core layer on and off with the display colour pass on. It runs in WebKit on a Mac runner (what the Mac app draws with) and in Edge on a Windows runner (WebView2). A page error, a frame slower than 5 s, or a large SVG filter (which froze the Mac app before) turns the pull request red. Rust format and lint, a check for unhandled promises, weekly grouped dependency updates and a weekly security audit keep the code tidy as more sites and contributors join.
