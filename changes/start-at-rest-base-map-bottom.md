---
bump: patch
issues: 419, 471
---
### Tables start, reset and present at rest, with the base map at the bottom

- **No layer opens by itself (#419).** A layer with a button on the controller now starts closed when the table opens, and closes on Reset and Present, even if the table had saved it on. Layers added in the editor are no longer saved on. Before, every layer added from the gallery was saved on, so the Chalmers table opened Trees, Reveal line, Roads and Field walk at start, on Reset and on Present.
- **The base map stays at the bottom (#471).** A base map lies under the rest of the map at rest wherever the scene lists it, so it can no longer cover the street glow, lights, trees and traffic.

![Base map moved to the end of the scene: before and after](docs/screenshots/471-base-map-bottom.png)
