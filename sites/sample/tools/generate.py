#!/usr/bin/env python3
"""Generates the sample site's synthetic data. Deterministic: rerun to reproduce.

    python3 sites/sample/tools/generate.py

The district is invented. It exists so tests and layer dev mode have a small,
licence-free site with buildings, courtyards, trees and sloping ground.
"""
import json
import math
import random
import struct
from pathlib import Path

ORIGIN = (11.9700, 57.7000)  # lon, lat
WIDTH_M, HEIGHT_M = 1000.0, 600.0
STREET_BEARING = 20.0  # the street grid is turned against the table on purpose
DATA = Path(__file__).resolve().parent.parent / "data"

A, E2 = 6378137.0, 0.00669437999014
phi = math.radians(ORIGIN[1])
s = 1 - E2 * math.sin(phi) ** 2
M_PER_DEG_LAT = A * (1 - E2) / s**1.5 * math.pi / 180
M_PER_DEG_LON = A / math.sqrt(s) * math.cos(phi) * math.pi / 180


def lonlat(east, north):
    return [round(ORIGIN[0] + east / M_PER_DEG_LON, 7), round(ORIGIN[1] + north / M_PER_DEG_LAT, 7)]


def turn(x, y):
    a = math.radians(-STREET_BEARING)
    return x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)


def ring(points):
    pts = [lonlat(*turn(x, y)) for x, y in points]
    return pts + [pts[0]]


def rect(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def main():
    rng = random.Random(7)
    buildings, trees, parks = [], [], []
    block, street = 70.0, 18.0
    pitch = block + street
    n = 9
    for iy in range(-n, n + 1):
        for ix in range(-n, n + 1):
            x, y = ix * pitch, iy * pitch
            cx, cy = turn(x + block / 2, y + block / 2)
            if abs(cx) > WIDTH_M / 2 + block or abs(cy) > HEIGHT_M / 2 + block:
                continue
            kind = rng.random()
            if kind < 0.14:  # park
                parks.append((ix, iy))
                for _ in range(rng.randint(8, 16)):
                    tx, ty = turn(x + rng.uniform(4, block - 4), y + rng.uniform(4, block - 4))
                    trees.append((tx, ty, round(rng.uniform(6, 16), 1)))
                continue
            if kind < 0.45:  # perimeter block with a courtyard
                height = round(rng.uniform(15, 24), 1)
                rings = [ring(rect(x, y, block, block)), ring(rect(x + 14, y + 14, block - 28, block - 28))]
                tx, ty = turn(x + block / 2, y + block / 2)
                trees.append((tx, ty, round(rng.uniform(6, 10), 1)))
            elif kind < 0.6:  # tower on a plinth
                height = round(rng.uniform(40, 70), 1)
                rings = [ring(rect(x + 20, y + 20, 30, 30))]
                buildings.append((round(rng.uniform(5, 8), 1), [ring(rect(x, y, block, 16))]))
            elif kind < 0.8:  # two slabs
                height = round(rng.uniform(12, 30), 1)
                rings = [ring(rect(x, y, block, 16))]
                buildings.append((round(rng.uniform(12, 30), 1), [ring(rect(x, y + block - 16, block, 16))]))
            else:  # L shape
                height = round(rng.uniform(9, 21), 1)
                rings = [ring([(x, y), (x + block, y), (x + block, y + 18), (x + 18, y + 18), (x + 18, y + block), (x, y + block)])]
            buildings.append((height, rings))
    for k in range(-30, 31):  # street trees along one avenue
        tx, ty = turn(k * 16.0, -street / 2)
        trees.append((tx, ty, 9.0))

    DATA.mkdir(exist_ok=True)
    features = [
        {"type": "Feature", "properties": {"id": i, "height": h}, "geometry": {"type": "Polygon", "coordinates": rings}}
        for i, (h, rings) in enumerate(buildings)
    ]
    (DATA / "buildings.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    features = [
        {"type": "Feature", "properties": {"height": h}, "geometry": {"type": "Point", "coordinates": lonlat(x, y)}}
        for x, y, h in trees
    ]
    (DATA / "trees.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))

    # Terrain: a gentle slope down to the south-east with one low hill. 10 m cells, row 0 at the top.
    tw, th = 100, 60
    values = []
    for row in range(th):
        for col in range(tw):
            xm, ym = (col + 0.5) / tw * WIDTH_M - WIDTH_M / 2, HEIGHT_M / 2 - (row + 0.5) / th * HEIGHT_M
            hill = 6.0 * math.exp(-((xm + 250) ** 2 + (ym - 120) ** 2) / (2 * 140.0**2))
            values.append(8.0 - 0.006 * xm + 0.008 * ym + hill)
    (DATA / "terrain.f32").write_bytes(struct.pack(f"<{len(values)}f", *values))
    print(f"{len(buildings)} buildings, {len(trees)} trees, terrain {tw}x{th}")
    mobility(pitch, street, n, parks)


def mobility(pitch, street, n, parks):
    """Walkways, trips and travel-time cells for the CoolPaths and mobility layers."""
    rng = random.Random(11)  # its own stream, so the scene data above never changes

    def node(ix, iy):  # a street crossing, in table-aligned metres
        return turn(ix * pitch - street / 2, iy * pitch - street / 2)

    def inside(ix, iy, inset=6.0):
        x, y = node(ix, iy)
        return abs(x) <= WIDTH_M / 2 - inset and abs(y) <= HEIGHT_M / 2 - inset

    def line(a, b):
        return [lonlat(*node(*a)), lonlat(*node(*b))]

    # Walkways: one line per street segment between crossings, plus a diagonal path through each park.
    walkways = []
    for ix in range(-n, n + 2):
        for iy in range(-n, n + 2):
            if not inside(ix, iy):
                continue
            for other, kind in (((ix + 1, iy), "street"), ((ix, iy + 1), "street")):
                if inside(*other):
                    walkways.append((kind, line((ix, iy), other)))
    for ix, iy in parks:
        if inside(ix, iy) and inside(ix + 1, iy + 1):
            walkways.append(("park", line((ix, iy), (ix + 1, iy + 1))))
    features = [
        {"type": "Feature", "properties": {"id": i, "kind": kind}, "geometry": {"type": "LineString", "coordinates": coords}}
        for i, (kind, coords) in enumerate(walkways)
    ]
    (DATA / "walkways.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))

    # Trips: every home sends one person on foot and one by tram to the same square.
    # The tram runs along the avenue (iy = 0) every four minutes.
    walk_ms, tram_ms, headway = 1.35, 8.0, 240.0

    def leg(mode, start, speed, crossings):
        length = pitch * (len(crossings) - 1)
        return {"mode": mode, "start": round(start, 1), "duration": round(length / speed, 1), "coordinates": [lonlat(*node(*c)) for c in crossings]}

    def run(a, b, fixed, along_x):  # crossings from a to b along one street
        step = 1 if b >= a else -1
        return [(k, fixed) if along_x else (fixed, k) for k in range(a, b + step, step)]

    homes = [(ix, iy) for ix in range(-n, n + 2) for iy in range(-n, n + 2) if inside(ix, iy) and abs(ix) + abs(iy) >= 3]
    homes = [h for h in homes if all(inside(*c) for c in run(h[1], 0, h[0], False) + run(h[0], 0, 0, True))]
    trips = []
    for ix, iy in rng.sample(homes, min(60, len(homes))):
        depart = rng.uniform(0, 300)
        to_avenue, on_avenue = run(iy, 0, ix, False), run(ix, 0, 0, True)
        walk = [leg("walk", depart, walk_ms, to_avenue)] if iy else []
        at_avenue = depart + (walk[0]["duration"] if walk else 0)
        if ix:
            walk_all = walk + [leg("walk", at_avenue, walk_ms, on_avenue)]
            board = math.ceil(at_avenue / headway) * headway
            tram = walk + [leg("tram", board, tram_ms, on_avenue)]
        else:
            walk_all = tram = walk
        trips.append({"group": "walk", "legs": walk_all})
        trips.append({"group": "tram", "legs": tram})
    duration = math.ceil(max(l["start"] + l["duration"] for t in trips for l in t["legs"]) / 60) * 60
    (DATA / "trips.json").write_text(
        json.dumps(
            {
                "format": 1,
                "title": "Getting to the square",
                "duration": duration,
                "groups": [
                    {"id": "walk", "label": "On foot", "color": "#fb923c"},
                    {"id": "tram", "label": "Walk and tram", "color": "#2dd4bf"},
                ],
                "destination": {"label": "The square", "coordinates": lonlat(*node(0, 0))},
                "trips": trips,
            },
            separators=(",", ":"),
        )
    )

    # Cells: minutes on foot to the square from each 50 m cell, at four times of the morning.
    steps = ["07:00", "08:00", "09:00", "10:00"]
    crowding = [1.0, 1.35, 1.2, 1.05]
    size = 50.0
    dx, dy = node(0, 0)
    cells = []
    for row in range(int(HEIGHT_M / size)):
        for col in range(int(WIDTH_M / size)):
            x0, y0 = col * size - WIDTH_M / 2, HEIGHT_M / 2 - (row + 1) * size
            corners = [(x0, y0), (x0 + size, y0), (x0 + size, y0 + size), (x0, y0 + size)]
            pts = [lonlat(x, y) for x, y in corners]
            away = abs(x0 + size / 2 - dx) + abs(y0 + size / 2 - dy)
            empty = rng.random() < 0.08  # cells nobody lives in stay empty
            values = [None if empty else round(away / walk_ms / 60 * c, 2) for c in crowding]
            cells.append({"type": "Feature", "properties": {"values": values}, "geometry": {"type": "Polygon", "coordinates": [pts + [pts[0]]]}})
    (DATA / "trip-cells.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "metadata": {"label": "Minutes on foot to the square", "unit": "min", "steps": steps, "min": 0, "max": 15},
                "features": cells,
            },
            separators=(",", ":"),
        )
    )
    print(f"{len(walkways)} walkways, {len(trips)} trips over {duration} s, {len(cells)} cells")


if __name__ == "__main__":
    main()
