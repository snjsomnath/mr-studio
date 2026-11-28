---
bump: minor
issues: 670
---
### Panels that read a dataset

A TV or controller panel can now read one of the table's CSV or GeoJSON files and work out its number straight from it, with no layer and no code. It can add up a column, average it, take its smallest or largest value, count rows, or show the latest value. It can keep only some rows with a formula, and group them into a list for bars, a list or a donut. With a time column, it follows the play head, for example energy used so far today. Files are read in the background, so the controller stays smooth.

![A page of numbers from energy.csv and buildings.geojson: counts, an average, bars and a donut grouped by use, and a curve through the day](docs/screenshots/670-dataset-panels.png)
