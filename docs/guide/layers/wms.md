# Web map (WMS)

## What it shows

A map from an online map service laid over the table: aerial photos (also from the 1960s and 70s), the topographic map, hillshade, property boundaries, or your municipality's planning maps.

![Choosing a built-in map](docs/screenshots/200-add-slide.png)

## Good for

Then-and-now comparisons, official maps and plans, and data you do not want to download.

## Set it up

1. Add **Web map (WMS)** from **Insert › New layer**, or add it as a slide.
2. Under **Map**, choose one of the built-in Swedish maps. They need no key.
3. For another service, choose **Your own service**, paste its **Service address**, and type the names of its **Layers** (comma separated). Its owner can tell you them.
4. If the service needs a login, add it once under **Sources and keys** on Home and choose it under **Sign-in**.

## Lantmäteriet maps

- The built-in Swedish maps come from SLU's open copy of Lantmäteriet's services (hades.slu.se). They need no login, and the credit "© Lantmäteriet, via SLU" is shown with them.
- Lantmäteriet's own services (maps.lantmateriet.se), such as Ortofoto Visning and Topowebb, need a user name and password even though the data is open. Create a free account on Geotorget (geotorget.lantmateriet.se), order the service there (for example **Ortofoto Visning**), and type the user name and password it gives you under **Lantmäteriet** in **Sources and keys**.
- Then choose **Your own service**, paste the address, for example `https://maps.lantmateriet.se/ortofoto/wms/v1.3` with the layer `Ortofoto_0.5`, and choose **Lantmäteriet** under **Sign-in**. The same login works for every address on maps.lantmateriet.se.
- SLU's GET download service needs an SLU student or staff login and gives files to download, not a map service, so it cannot be a source.

## Tips

- The computer must be online the first time; after that, the map picture is kept for the table.
- If the map stays empty, the controller shows the service's message, often a misspelt layer name.
