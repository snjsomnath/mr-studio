---
bump: none
issues: 742
audience: developers
---
### The controller's rules have unit tests

The runtime's modules now load under plain Node, so the controller's rules can be unit tested without a browser. Under Node, `registry.ts` has no core layers, because Vite's glob only exists in a build. New tests cover which rail each button goes on, typed values, what phones may change, and two layers at once. CI writes unit-test coverage for the SDK, runtime and dashboard to its job summary.
