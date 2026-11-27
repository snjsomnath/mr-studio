# Map data

## What it shows

A dataset of your own drawn on the table, such as land use, building types or planned areas, coloured by category. **Next** can reveal one category at a time.

![Categories revealed one by one](docs/screenshots/43-slides-next-reveals.png)

## Good for

Walking visitors through a map piece by piece: "here is the housing, here are the schools, here is the green".

## Set it up

1. Bring the dataset in: Insert tab, **Data file**, choose a GeoJSON file (or a shapefile converted to GeoJSON).
2. Add **Map data** from **Insert › New layer**, or put it in a slideshow as a slide.
3. Under **Dataset**, choose your data. Under **Colour by**, choose the column that holds the categories, for example `kind`.
4. Choose **Category colours**: the data's own colours, the table palette, or energy classes A to G.
5. With **Next reveals one category at a time** on, each press of Next on the controller brings in the next category.

## Tips

- Up to 12 categories get their own colours. With more, the map is drawn in one colour.
- For styled maps with glow or motion, make your own layer in the layer builder instead (guide "Bring in your own data").
