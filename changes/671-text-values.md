---
bump: minor
issues: 671
---
### Text boxes that read live numbers

A Note panel can now write live values into its sentence: "The roofs made **{{kwh}}** today, {{delta}} more than a year ago." Each value is bound, worked out with an expression or typed in, and written with its unit, decimals or as a percent, in the visitors' number style (5,0 in Swedish). Words between `**` are bold, and a value can take the accent colour. The box size sets how much it holds (a tile 64 characters and two values, a wide box 128 and four), and longer text is refused when the panel is checked instead of being drawn smaller.

![A tile and a wide text box with live values](docs/screenshots/671-text-values.png)
