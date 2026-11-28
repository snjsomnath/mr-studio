---
bump: patch
issues: 715
---
### Panels fit on the controller too

On the controller, the dashboard under an open layer is shorter than on a TV. Its panels were squeezed into rows smaller than they were designed for, and some text was drawn for the whole screen's height. So wide panels with four bars or rows, the donut's ring and some chips spilled out of their boxes. Now rows are as tall as a TV's unless that would push panels onto another page, and text is sized to the canvas. The overflow test now also checks every widget on the controller's canvas.

![Bars, a list, a donut and a chip on the controller, before and after](docs/screenshots/715-controller-fit.png)
