---
bump: patch
issues: 484
---
### Street networks are built once, off the table's thread

Traffic, street life, street glow and CoolPaths build their street networks in the background now, and keep them until the streets file changes. A second layer on the same streets, or the same layer turned off and on, starts straight away. On the Universeum table (87,761 street segments), this takes about a second of street parsing and graph building off the table at start, and close to another second off every CoolPaths start.
