---
bump: minor
issues: 509
---
### An older MR Studio says which version a table needs

A table made on a newer MR Studio used to fail on an older studio computer with whatever it tripped over first: an unknown setting, a missing layer, an error inside a layer's code (#509).

Now a table carries the version of the newest MR Studio that changed it (a one-line `mrstudio.version` file beside site.json, written by the app). An older app that cannot read the table says "This table was made with MR Studio 0.55. This computer has 0.49. Update MR Studio on this computer to 0.55 or newer." One that can read it says the same once and offers **Open anyway**.

![The question an older MR Studio asks](docs/screenshots/509-made-with-newer.png)

A team's own code layer says which MR Studio it needs (`requires.app` in layer.json, written by `mrstudio layer build`). On an older app the rest of the table shows and that layer says what to install.

![A layer built for a newer MR Studio says so](docs/screenshots/509-layer-needs-newer.png)

The site template's check installs the version the table names.
