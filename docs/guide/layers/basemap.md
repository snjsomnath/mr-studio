# Base map

## What it shows

The ground everything else is drawn on. Most tables use **Dark, from your data**: your own streets and buildings, drawn dark so the layers on top stand out. You can also use a ready-made map (dark, night, light, grey, street or terrain), an aerial photo, a map from your own sources, or plain ground.

![The base map as an aerial photo](docs/screenshots/37-aerial.png)

## Good for

Every table needs one. Keep it dark and quiet: visitors look at the layers, not the map.

## Set it up

1. Select **Map** in the list on the left. If there is no base map yet, add **Base map** from **New layer** on the Insert tab.
2. Under **Style**, choose a look. **Dark, from your data** needs the table's streets and buildings (Insert tab, **Data file**, then **From OpenStreetMap**).
3. For an aerial photo or a ready-made map, the computer must be online the first time. MR Studio keeps the map pictures, so the table still shows them later without internet.
4. For **From your sources**, first add a Mapbox, CARTO or Lantmäteriet key under **Sources and keys** on Home, then choose it under **Map source**.
5. Turn down **Brightness** if the map competes with the layers. **Black and white** takes the colour out of a photo.

## No key needed

Every style works without a key, apart from **From your sources**. **Dark, from your data** is drawn from the table's own streets and buildings. The ready-made maps come from free public services: OpenStreetMap, Esri and OpenTopoMap. The Name and place map in the guide uses OpenStreetMap too.

These free services ask for light use. OpenStreetMap's tile policy, for example, has no fixed quota but blocks heavy or bulk downloading. MR Studio stays well inside that, because the computer fetches each map picture once and keeps it for 30 days, so the table runs from its own copy. Don't point many tables at a large area and pan around all day. If a service ever refuses, the table keeps its last copy.

CARTO's light and dark maps now need a CARTO key, and without one they come back marked "API key required". That is why they are only offered through **Sources and keys**. A key is optional: add one there (CARTO or Mapbox) if you want those looks or a guaranteed allowance.

## Tips

- On a white model, a darker map makes the projected layers look brighter.
- The map credit (for example © OpenStreetMap) is shown with the table automatically.
