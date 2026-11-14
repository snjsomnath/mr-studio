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
    buildings, trees = [], []
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


if __name__ == "__main__":
    main()
