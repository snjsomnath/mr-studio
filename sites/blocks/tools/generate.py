#!/usr/bin/env python3
"""Generates the synthetic datasets of the building-blocks demo site. Deterministic.

    python3 sites/blocks/tools/generate.py

Everything here is invented. The buildings are the sample district's; on top of them
this writes the kinds of data real layers read, so every data adapter has a file to
load: places (GeoJSON points), an energy community (GeoJSON nodes and flow lines with
hourly series) and a table of building attributes (CSV).
"""
import csv
import json
import math
import random
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
ORIGIN = (11.9700, 57.7000)
A, E2 = 6378137.0, 0.00669437999014
phi = math.radians(ORIGIN[1])
s = 1 - E2 * math.sin(phi) ** 2
M_LAT = A * (1 - E2) / s**1.5 * math.pi / 180
M_LON = A / math.sqrt(s) * math.cos(phi) * math.pi / 180


def lonlat(east, north):
    return [round(ORIGIN[0] + east / M_LON, 7), round(ORIGIN[1] + north / M_LAT, 7)]


def local(lon, lat):
    return (lon - ORIGIN[0]) * M_LON, (lat - ORIGIN[1]) * M_LAT


def write(name, features, **extra):
    (DATA / name).write_text(json.dumps({"type": "FeatureCollection", **extra, "features": features}, separators=(",", ":")) + "\n")


def main():
    rng = random.Random(11)
    buildings = json.loads((DATA / "buildings.geojson").read_text())["features"]
    centres = {}
    for b in buildings:
        ring = b["geometry"]["coordinates"][0][:-1]
        pts = [local(*p) for p in ring]
        centres[b["properties"]["id"]] = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    on_table = [i for i, (e, n) in centres.items() if abs(e) < 440 and abs(n) < 250]

    # Places that draw people, with a kind and a weight.
    kinds = ["landmark", "theatre", "heritage", "education", "studio", "nature", "community", "art"]
    names = ["The Tower", "Harbour Theatre", "Old Manor", "The Cog", "Film Studios", "Granite Hill", "Dry Dock", "Evening Star", "The Dome", "Propeller Yard"]
    places = []
    for i, name in enumerate(names):
        e, n = rng.uniform(-420, 420), rng.uniform(-230, 230)
        places.append({"type": "Feature", "properties": {"name": name, "kind": kinds[i % len(kinds)], "weight": round(rng.uniform(0.7, 1.4), 1)},
                       "geometry": {"type": "Point", "coordinates": lonlat(e, n)}})
    write("places.geojson", places)

    # An energy community: members, a grid tie, a battery, and hourly flows between them.
    members = rng.sample(on_table, 14)
    solar_roofs = set(members[:5])
    host = members[5]
    hours = range(24)
    sun = [max(0.0, math.sin((h - 6) / 14 * math.pi)) if 6 <= h <= 20 else 0.0 for h in hours]
    rows, nodes, flows = [], [], []
    grid_at = (-470.0, 270.0)
    nodes.append({"type": "Feature", "properties": {"id": "grid", "kind": "grid", "name": "Grid tie"}, "geometry": {"type": "Point", "coordinates": lonlat(*grid_at)}})
    nodes.append({"type": "Feature", "properties": {"id": "battery", "kind": "battery", "name": "Battery", "host": host, "capacity_kwh": 250},
                  "geometry": {"type": "Point", "coordinates": lonlat(*centres[host])}})
    for m in members:
        peak = rng.choice([8, 20, 45, 120, 400])
        busiest = rng.choice([9, 13, 18])
        shape = [0.35 + 0.65 * math.exp(-((h - busiest) / 4.5) ** 2) for h in hours]
        demand = [round(peak * v, 1) for v in shape]
        pv_kw = rng.choice([40, 90, 160]) if m in solar_roofs else 0
        solar = [round(pv_kw * v, 1) for v in sun]
        rows.append({"id": m, "name": f"Building {m}", "class": rng.choice("ABCDEFG"), "pv_kw": pv_kw, **{f"h{h:02d}": demand[h] for h in hours}})
        nodes.append({"type": "Feature", "properties": {"id": f"b{m}", "kind": "building", "building": m, "solar_hourly": solar},
                      "geometry": {"type": "Point", "coordinates": lonlat(*centres[m])}})
        # What the roof does not cover comes from the battery in the evening and the grid otherwise.
        net = [max(0.0, demand[h] - solar[h]) for h in hours]
        from_battery = [round(net[h] * 0.6, 1) if 18 <= h <= 22 and m in members[5:9] else 0.0 for h in hours]
        from_grid = [round(net[h] - from_battery[h], 1) for h in hours]
        e, n = centres[m]
        dog_leg = [lonlat(*grid_at), lonlat(e, grid_at[1]), lonlat(e, n)]
        flows.append({"type": "Feature", "properties": {"id": f"grid-b{m}", "source": "grid", "target": f"b{m}", "kind": "grid", "flow_hourly": from_grid},
                      "geometry": {"type": "LineString", "coordinates": dog_leg}})
        if any(from_battery):
            flows.append({"type": "Feature", "properties": {"id": f"battery-b{m}", "source": "battery", "target": f"b{m}", "kind": "battery", "flow_hourly": from_battery},
                          "geometry": {"type": "LineString", "coordinates": [lonlat(*centres[host]), lonlat(e, n)]}})
    # The battery charges from the grid at night.
    charge = [60.0 if h < 5 else 0.0 for h in hours]
    flows.append({"type": "Feature", "properties": {"id": "grid-battery", "source": "grid", "target": "battery", "kind": "grid", "flow_hourly": charge},
                  "geometry": {"type": "LineString", "coordinates": [lonlat(*grid_at), lonlat(centres[host][0], grid_at[1]), lonlat(*centres[host])]}})
    write("energy-nodes.geojson", nodes)
    write("energy-flows.geojson", flows)
    with (DATA / "buildings.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(places)} places, {len(members)} members, {len(flows)} flows")


if __name__ == "__main__":
    main()
