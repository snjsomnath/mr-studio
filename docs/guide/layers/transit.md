# Public transport

## What it shows

Trams, buses, trains and ferries moving along their routes, with their line numbers. They are either simulated or the real vehicles, live.

![Trams and buses on their lines](docs/screenshots/202-after.png)

## Good for

A living city at rest, and showing how a place is connected.

## Set it up

1. Add **Public transport** from **Insert › New layer**. Without any data, a few made-up lines run along the streets, so it is never empty.
2. For your city's real routes and stops, bring them in with **Add data** as a dataset of your own named `transit`: a GeoJSON file with the routes as lines and the stops as points.
3. For live vehicles in Gothenburg, add your Västtrafik key under **Sources and keys** on Home. Then set **Vehicles** to **Live feed** and choose Västtrafik under **Live data from**.
4. Turn on **Routes** and **Stops** to draw the network itself.

## Tips

- Live vehicles need the internet. If the feed stops, the vehicles that were last seen fade out.
- Other cities' feeds can be added by address under **Feed address**.
