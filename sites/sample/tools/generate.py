#!/usr/bin/env python3
"""Generates the sample site's synthetic data. Deterministic: rerun to reproduce.

    python3 sites/sample/tools/generate.py

The district is invented. It exists so tests and layer dev mode have a small,
licence-free site with buildings, courtyards, trees, sloping ground, streets,
a few transit lines and a short slideshow.
"""
import json
import math
import random
import struct
import zlib
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


def line(points):
    return [lonlat(*turn(x, y)) for x, y in points]


def terrain_at(xm, ym):
    hill = 6.0 * math.exp(-((xm + 250) ** 2 + (ym - 120) ** 2) / (2 * 140.0**2))
    return 8.0 - 0.006 * xm + 0.008 * ym + hill


def write_png(path, width, height, pixel):
    """A minimal RGB PNG writer, so the generator needs nothing outside the standard library."""
    rows = b"".join(b"\x00" + bytes(c for x in range(width) for c in pixel(x, y)) for y in range(height))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    rng = random.Random(7)
    buildings, trees, kinds, parks = [], [], [], []
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
                kinds.append("housing")
            elif kind < 0.6:  # tower on a plinth
                height = round(rng.uniform(40, 70), 1)
                rings = [ring(rect(x + 20, y + 20, 30, 30))]
                buildings.append((round(rng.uniform(5, 8), 1), [ring(rect(x, y, block, 16))]))
                kinds += ["shops", "offices"]
            elif kind < 0.8:  # two slabs
                height = round(rng.uniform(12, 30), 1)
                rings = [ring(rect(x, y, block, 16))]
                buildings.append((round(rng.uniform(12, 30), 1), [ring(rect(x, y + block - 16, block, 16))]))
                kinds += ["housing", "housing"]
            else:  # L shape
                height = round(rng.uniform(9, 21), 1)
                rings = [ring([(x, y), (x + block, y), (x + block, y + 18), (x + 18, y + 18), (x + 18, y + block), (x, y + block)])]
                kinds.append("public")
            buildings.append((height, rings))
    for k in range(-30, 31):  # street trees along one avenue
        tx, ty = turn(k * 16.0, -street / 2)
        trees.append((tx, ty, 9.0))

    DATA.mkdir(exist_ok=True)
    features = [
        {"type": "Feature", "properties": {"id": i, "height": h, "kind": kinds[i]}, "geometry": {"type": "Polygon", "coordinates": rings}}
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
            values.append(terrain_at(xm, ym))
    (DATA / "terrain.f32").write_bytes(struct.pack(f"<{len(values)}f", *values))

    # Streets: the centre lines of the gaps between blocks, with a vertex at every crossing
    # so that traffic can turn there. One avenue is wider and carries the tram.
    reach = range(-n, n + 2)
    centre = lambda i: i * pitch - street / 2
    roads = []
    for i in reach:
        avenue = i == 0
        props = {"kind": "avenue" if avenue else "street", "width": 14 if avenue else 9}
        roads.append((props, line([(centre(j), centre(i)) for j in reach])))  # along the street grid's x axis
        roads.append(({"kind": "street", "width": 9}, line([(centre(i), centre(j)) for j in reach])))
    features = [{"type": "Feature", "properties": p, "geometry": {"type": "LineString", "coordinates": c}} for p, c in roads]
    (DATA / "roads.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))

    # Transit: a tram along the avenue and two bus lines that turn a corner. Stops every other crossing.
    def route(corners):
        """Grid crossings (i, j) joined by straight runs, with every crossing on the way as a vertex."""
        nodes = [corners[0]]
        for (i1, j1) in corners[1:]:
            i0, j0 = nodes[-1]
            steps = max(abs(i1 - i0), abs(j1 - j0))
            nodes += [(i0 + (i1 - i0) * k // steps, j0 + (j1 - j0) * k // steps) for k in range(1, steps + 1)]
        return nodes

    lines = [
        ({"line": "1", "mode": "tram", "colour": "#ffd700"}, route([(-7, 0), (7, 0)])),
        ({"line": "16", "mode": "bus", "colour": "#00a5e0"}, route([(-6, 3), (2, 3), (2, -4)])),
        ({"line": "52", "mode": "bus", "colour": "#e5578f"}, route([(-3, -4), (-3, 2), (6, 2)])),
    ]
    features, stops = [], set()
    for props, nodes in lines:
        features.append({"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": line([(centre(i), centre(j)) for i, j in nodes])}})
        stops.update(nodes[1::2])
    for k, (i, j) in enumerate(sorted(stops)):
        features.append({"type": "Feature", "properties": {"name": f"Stop {k + 1}"}, "geometry": {"type": "Point", "coordinates": lonlat(*turn(centre(i), centre(j)))}})
    (DATA / "transit.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))

    # Slideshow: the site's own data as map slides, and the terrain as an image.
    slides = DATA / "slideshow"
    slides.mkdir(exist_ok=True)
    low, high = min(values), max(values)

    def relief(px, py, w=500, h=300):
        xm, ym = (px + 0.5) / w * WIDTH_M - WIDTH_M / 2, HEIGHT_M / 2 - (py + 0.5) / h * HEIGHT_M
        z = terrain_at(xm, ym)
        t = (z - low) / (high - low)
        # Light from the north-west, and a contour every metre.
        shade = 0.75 + 12.0 * ((terrain_at(xm + 4, ym) - z) - (terrain_at(xm, ym - 4) - z)) / 8
        contour = 0.6 if abs(z - round(z)) < 0.04 else 1.0
        base = (20 + 60 * t, 70 + 110 * t, 90 + 60 * (1 - t))
        return tuple(max(0, min(255, int(c * shade * contour))) for c in base)

    write_png(slides / "terrain.png", 500, 300, relief)
    config = {
        "slides": [
            {
                "media": "../buildings.geojson", "type": "geojson", "duration": 8000,
                "metadata": {
                    "title": "What the buildings are used for",
                    "description": "Every footprint in the sample district, coloured by use",
                    "source": "Synthetic data from sites/sample/tools/generate.py",
                    "legend": {"items": [
                        {"color": "#ff8a3d", "label": "Housing"}, {"color": "#4dabf7", "label": "Offices"},
                        {"color": "#f7d154", "label": "Shops"}, {"color": "#b197fc", "label": "Public buildings"},
                    ]},
                    "style": {"colorProperty": "kind", "fillOpacity": 0.6, "strokeWidth": 1,
                              "colorMap": {"housing": "#ff8a3d", "offices": "#4dabf7", "shops": "#f7d154", "public": "#b197fc"}},
                },
            },
            {
                "media": "terrain.png", "type": "image", "duration": 8000, "fitMode": "stretch",
                "metadata": {
                    "title": "Terrain",
                    "description": "The ground slopes down to the south-east, with one low hill. Contours every metre.",
                    "source": "Synthetic data from sites/sample/tools/generate.py",
                },
            },
            {
                "media": "../roads.geojson", "type": "geojson", "duration": 8000,
                "metadata": {
                    "title": "Street network",
                    "description": "One avenue and a grid of local streets",
                    "source": "Synthetic data from sites/sample/tools/generate.py",
                    "legend": {"items": [{"color": "#ffd43b", "label": "Avenue"}, {"color": "#74c0fc", "label": "Street"}]},
                    "style": {"colorProperty": "kind", "strokeWidth": 4, "strokeOpacity": 0.9, "colorMap": {"avenue": "#ffd43b", "street": "#74c0fc"}},
                },
            },
        ]
    }
    (slides / "slideshow.json").write_text(json.dumps(config, indent=2) + "\n")
    print(f"{len(buildings)} buildings, {len(trees)} trees, terrain {tw}x{th}, {len(roads)} streets, {len(lines)} transit lines")
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
