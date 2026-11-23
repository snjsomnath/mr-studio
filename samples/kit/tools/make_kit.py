#!/usr/bin/env python3
"""Builds the sample data kit from the sample site's synthetic district. Stdlib only, deterministic.

    python3 samples/kit/tools/make_kit.py

Every file lands inside a 1000 x 600 m table centred on lon 11.97, lat 57.70 (the
sample district), except the files under `broken/`, which are wrong on purpose.
"""
import csv
import json
import math
import random
import shutil
import struct
from datetime import datetime, timedelta
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SAMPLE = KIT.parent.parent / "sites" / "sample" / "data"
ORIGIN = (11.97, 57.70)
WIDTH_M, HEIGHT_M = 1000.0, 600.0
random.seed(7)

# ---- Geodesy: local metres around the origin, and SWEREF99 TM (EPSG:3006) -------

A, F = 6378137.0, 1 / 298.257222101  # GRS80
E2 = F * (2 - F)
phi0 = math.radians(ORIGIN[1])
s = 1 - E2 * math.sin(phi0) ** 2
M_LAT = A * (1 - E2) / s**1.5 * math.pi / 180
M_LON = A / math.sqrt(s) * math.cos(phi0) * math.pi / 180


def lonlat(east, north):
    return [round(ORIGIN[0] + east / M_LON, 7), round(ORIGIN[1] + north / M_LAT, 7)]


def sweref(lon, lat, lon0=15.0, k0=0.9996, fe=500000.0):
    """Gauss-Krüger forward (Lantmäteriet's formulas), metres east and north."""
    n = F / (2 - F)
    a_hat = A / (1 + n) * (1 + n**2 / 4 + n**4 / 64)
    e2 = E2
    Aa = e2
    Bb = (5 * e2**2 - e2**3) / 6
    Cc = (104 * e2**3 - 45 * e2**4) / 120
    Dd = (1237 * e2**4) / 1260
    b1 = n / 2 - 2 * n**2 / 3 + 5 * n**3 / 16 + 41 * n**4 / 180
    b2 = 13 * n**2 / 48 - 3 * n**3 / 5 + 557 * n**4 / 1440
    b3 = 61 * n**3 / 240 - 103 * n**4 / 140
    b4 = 49561 * n**4 / 161280
    phi, lam = math.radians(lat), math.radians(lon - lon0)
    sp = math.sin(phi)
    phis = phi - sp * math.cos(phi) * (Aa + Bb * sp**2 + Cc * sp**4 + Dd * sp**6)
    xi = math.atan(math.tan(phis) / math.cos(lam))
    eta = math.atanh(math.cos(phis) * math.sin(lam))
    x = k0 * a_hat * (xi + sum(b * math.sin(2 * j * xi) * math.cosh(2 * j * eta) for j, b in enumerate((b1, b2, b3, b4), 1)))
    y = k0 * a_hat * (eta + sum(b * math.cos(2 * j * xi) * math.sinh(2 * j * eta) for j, b in enumerate((b1, b2, b3, b4), 1)))
    return round(y + fe, 2), round(x, 2)


def load(name):
    return json.loads((SAMPLE / name).read_text())


def write(path, obj):
    path = KIT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")) + "\n")


def map_coords(geom, fn):
    def walk(c):
        return fn(*c[:2]) if isinstance(c[0], (int, float)) else [walk(x) for x in c]
    return {"type": geom["type"], "coordinates": walk(geom["coordinates"])}


def centroid(geom):
    ring = geom["coordinates"][0]
    return sum(p[0] for p in ring[:-1]) / (len(ring) - 1), sum(p[1] for p in ring[:-1]) / (len(ring) - 1)


# ---- Buildings -----------------------------------------------------------------

USE = {"housing": "Housing", "office": "Offices", "shop": "Shops", "public": "Public building"}
buildings = load("buildings.geojson")
for f in buildings["features"]:
    p = f["properties"]
    p["name"] = f"{USE.get(p['kind'], p['kind'])} {p['id'] + 1}"
    p["levels"] = max(1, round(p["height"] / 3.2))
    p["year"] = random.choice([1932, 1958, 1964, 1971, 1989, 2004, 2012, 2021])
write("buildings.geojson", buildings)

# The same buildings in SWEREF99 TM, as most Swedish municipalities hand them out.
proj = {
    "type": "FeatureCollection",
    "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3006"}},
    "features": [{**f, "geometry": map_coords(f["geometry"], lambda x, y: list(sweref(x, y)))} for f in buildings["features"]],
}
write("crs/buildings-sweref99tm.geojson", proj)
# ...and without saying so, so the editor has to ask which coordinate system it is.
write("crs/buildings-sweref99tm-no-crs.geojson", {k: v for k, v in proj.items() if k != "crs"})

# Energy per building, joined by id (CSV join to buildings).
(KIT / "tables").mkdir(exist_ok=True)
with open(KIT / "tables/building-energy.csv", "w", newline="") as out:
    w = csv.writer(out)
    w.writerow(["building_id", "heating_kwh_m2", "electricity_kwh_m2", "solar_potential_kwh", "energy_class"])
    for f in buildings["features"]:
        p = f["properties"]
        heat = round(random.uniform(55, 160) * (1.25 if p["year"] < 1975 else 0.8), 1)
        w.writerow([p["id"], heat, round(random.uniform(20, 70), 1), round(random.uniform(2, 60) * p["levels"] ** 0.3 * 100), "ABCDEFG"[min(6, int(heat // 25))]])

# ---- Streets, walking paths, transit ------------------------------------------

roads = load("roads.geojson")
for i, f in enumerate(roads["features"]):
    wide = f["properties"].get("width", 9) >= 12
    f["properties"] = {"id": i, "highway": "secondary" if wide else "residential", "name": f"{'Storgatan' if wide else 'Gata'} {i + 1}", "maxspeed": 50 if wide else 30, "lanes": 2, "oneway": "no", "width": f["properties"].get("width", 9)}
write("streets.geojson", roads)

walk = load("walkways.geojson")
for f in walk["features"]:
    f["properties"] = {"id": f["properties"]["id"], "highway": random.choice(["footway", "footway", "path", "pedestrian"]), "surface": random.choice(["asphalt", "paving_stones", "gravel"])}
write("walkways.geojson", walk)
write("transit.geojson", load("transit.geojson"))

# ---- Trees: GeoJSON points, a plain CSV and a Swedish-Excel CSV ------------------

SPECIES = ["Tilia cordata", "Acer platanoides", "Quercus robur", "Betula pendula", "Prunus avium", "Sorbus aucuparia"]
trees = load("trees.geojson")
for i, f in enumerate(trees["features"]):
    f["properties"] = {"id": i, "species": random.choice(SPECIES), "height": f["properties"]["height"], "crown_m": round(f["properties"]["height"] * 0.45, 1), "planted": random.randint(1950, 2022)}
write("trees.geojson", trees)
with open(KIT / "trees.csv", "w", newline="") as out:
    w = csv.writer(out)
    w.writerow(["id", "lat", "lon", "species", "height"])
    for f in trees["features"]:
        lon, lat = f["geometry"]["coordinates"]
        w.writerow([f["properties"]["id"], lat, lon, f["properties"]["species"], f["properties"]["height"]])
# Semicolons and decimal commas, SWEREF99 TM easting/northing: what Excel saves on a Swedish PC.
with open(KIT / "crs/trees-sweref99tm-excel.csv", "w", newline="", encoding="utf-8-sig") as out:
    out.write("Trädnr;Art;Höjd;N;E\n")
    for f in trees["features"]:
        e, n = sweref(*f["geometry"]["coordinates"])
        out.write(f"{f['properties']['id']};{f['properties']['species']};{str(f['properties']['height']).replace('.', ',')};{str(n).replace('.', ',')};{str(e).replace('.', ',')}\n")

# ---- Trips ---------------------------------------------------------------------

shutil.copy(SAMPLE / "trips.json", KIT / "trips.json")

# ---- Ground: GeoTIFFs ----------------------------------------------------------


def height(east, north):
    """A gentle slope with a hill in the north-west, metres above sea level."""
    return 12 + 0.012 * north + 9 * math.exp(-(((east + 280) / 180) ** 2 + ((north - 160) / 140) ** 2))


def geotiff(path, w, h, x0, y0, dx, dy, values, keys, nodata=None):
    """A single-band float32 GeoTIFF, uncompressed, one strip. (x0, y0) is the top-left corner."""
    data = struct.pack(f"<{w * h}f", *values)
    tags = []  # (tag, type, count, payload bytes)
    def add(tag, typ, vals):
        fmt = {3: "H", 4: "I", 12: "d", 2: None}[typ]
        raw = vals if typ == 2 else struct.pack(f"<{len(vals)}{fmt}", *vals)
        tags.append((tag, typ, len(vals) if typ != 2 else len(raw), raw))
    add(256, 4, [w]); add(257, 4, [h]); add(258, 3, [32]); add(259, 3, [1]); add(262, 3, [1])
    add(273, 4, [0]); add(277, 3, [1]); add(278, 4, [h]); add(279, 4, [len(data)]); add(284, 3, [1]); add(339, 3, [3])
    add(33550, 12, [dx, dy, 0.0]); add(33922, 12, [0.0, 0.0, 0.0, x0, y0, 0.0]); add(34735, 3, keys)
    if nodata is not None:
        add(42113, 2, f"{nodata}\0".encode())
    tags.sort()
    ifd_size = 2 + 12 * len(tags) + 4
    extra_at = 8 + ifd_size
    extra = b""
    entries = b""
    offsets = {}
    for tag, typ, count, raw in tags:
        if len(raw) <= 4:
            entries += struct.pack("<HHI", tag, typ, count) + raw.ljust(4, b"\0")
        else:
            offsets[tag] = extra_at + len(extra)
            entries += struct.pack("<HHII", tag, typ, count, extra_at + len(extra))
            extra += raw + (b"\0" if len(raw) % 2 else b"")
    data_at = extra_at + len(extra)
    entries = entries.replace(struct.pack("<HHI", 273, 4, 1) + struct.pack("<I", 0), struct.pack("<HHI", 273, 4, 1) + struct.pack("<I", data_at))
    out = b"II*\0" + struct.pack("<I", 8) + struct.pack("<H", len(tags)) + entries + b"\0\0\0\0" + extra + data
    (KIT / path).parent.mkdir(parents=True, exist_ok=True)
    (KIT / path).write_bytes(out)


# 10 m pixels in SWEREF99 TM, covering the table with 100 m to spare.
cx, cy = sweref(*ORIGIN)
px, margin = 10.0, 100.0
w, h = int((WIDTH_M + 2 * margin) / px), int((HEIGHT_M + 2 * margin) / px)
x0, y0 = round(cx - WIDTH_M / 2 - margin), round(cy + HEIGHT_M / 2 + margin)
vals = [round(height(x0 + (i + 0.5) * px - cx, y0 - (j + 0.5) * px - cy), 2) for j in range(h) for i in range(w)]
# GeoKeys: projected, PixelIsArea, EPSG:3006, linear unit metre.
geotiff("terrain-sweref99tm.tif", w, h, x0, y0, px, px, vals, [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3006, 3076, 0, 1, 9001])
# The same ground in plain lon/lat, about 10 m pixels.
dlon, dlat = 10 / M_LON, 10 / M_LAT
lon0, lat0 = ORIGIN[0] - (WIDTH_M / 2 + margin) / M_LON, ORIGIN[1] + (HEIGHT_M / 2 + margin) / M_LAT
vals = [round(height((lon0 + (i + 0.5) * dlon - ORIGIN[0]) * M_LON, (lat0 - (j + 0.5) * dlat - ORIGIN[1]) * M_LAT), 2) for j in range(h) for i in range(w)]
geotiff("crs/terrain-wgs84.tif", w, h, lon0, lat0, dlon, dlat, vals, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326])

# ---- Sensors and a time series ---------------------------------------------------

SENSORS = [("S1", "The square", 0, 30), ("S2", "School yard", -300, 150), ("S3", "Harbour edge", 380, -210), ("S4", "Park", -150, -180), ("S5", "Main street", 200, 90)]
write("sensors.geojson", {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"sensor_id": sid, "name": name}, "geometry": {"type": "Point", "coordinates": lonlat(e, n)}} for sid, name, e, n in SENSORS]})
start = datetime(2026, 7, 3, 0, 0)
with open(KIT / "tables/sensors-timeseries.csv", "w", newline="") as out:
    w = csv.writer(out)
    w.writerow(["sensor_id", "timestamp", "temperature_c", "pm25_ugm3", "noise_db", "people"])
    for k, (sid, *_rest) in enumerate(SENSORS):
        for hr in range(0, 48):
            t = start + timedelta(minutes=30 * hr)
            day = math.sin((t.hour + t.minute / 60 - 9) / 24 * 2 * math.pi)
            rush = math.exp(-((t.hour - 8) / 1.5) ** 2) + math.exp(-((t.hour - 17) / 1.8) ** 2)
            w.writerow([sid, t.strftime("%Y-%m-%dT%H:%M"), round(19 + 6 * day + k * 0.4 + random.uniform(-0.4, 0.4), 1),
                        round(6 + 14 * rush + random.uniform(0, 3), 1), round(42 + 20 * rush + (8 if sid == "S5" else 0) + random.uniform(-2, 2), 1),
                        int(max(0, (40 if sid in ("S1", "S5") else 12) * (0.2 + rush + max(0, day)) + random.uniform(-3, 3)))])

# A moving point: one delivery bike, positions every 2 minutes (a point driven by a time series).
with open(KIT / "tables/bike-track.csv", "w", newline="") as out:
    w = csv.writer(out)
    w.writerow(["timestamp", "lat", "lon", "speed_kmh"])
    for i in range(60):
        a = i / 60 * 2 * math.pi
        lon, lat = lonlat(320 * math.cos(a), 180 * math.sin(2 * a) / 1.5)
        w.writerow([(start + timedelta(hours=11, minutes=2 * i)).strftime("%Y-%m-%dT%H:%M"), lat, lon, round(14 + 6 * math.sin(3 * a), 1)])

# ---- Zones with values (choropleth), and points of interest ----------------------

zones = []
for zi, (e0, n0) in enumerate([(x, y) for y in (-300, 0) for x in (-500, -250, 0, 250)]):
    ring = [lonlat(e0, n0), lonlat(e0 + 250, n0), lonlat(e0 + 250, n0 + 300), lonlat(e0, n0 + 300), lonlat(e0, n0)]
    zones.append({"type": "Feature", "properties": {"zone": f"Z{zi + 1}", "population": random.randint(300, 2400), "green_share": round(random.uniform(0.05, 0.45), 2),
                  "noise_db": random.randint(48, 68)}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
write("zones.geojson", {"type": "FeatureCollection", "features": zones})
# Places follow the place data standard (#160): name, weight and a category, plus optional
# activity, flows and links tables that every place motion reads.
POI = [("School", "school", "learning", 0.7, -300, 160), ("Library", "library", "learning", 0.85, 60, 40), ("Café", "cafe", "everyday", 0.4, 10, 20),
       ("Clinic", "clinic", "care", 0.55, 250, -60), ("Playground", "playground", "everyday", 0.35, -160, -170), ("Tram stop", "stop", "transport", 1.0, 120, 10)]
write("places.geojson", {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"name": n, "kind": k, "category": c, "weight": w}, "geometry": {"type": "Point", "coordinates": lonlat(e, nn)}} for n, k, c, w, e, nn in POI]})
# A weekday from 06:00 to 22:00, every half hour: school mornings, café lunches, tram rush hours.
PEAKS = {"School": [(8, 1.0), (15, 0.6)], "Library": [(11, 0.6), (17, 0.9)], "Café": [(8, 0.5), (12.5, 1.0), (16, 0.6)], "Clinic": [(10, 0.8), (14, 0.7)],
         "Playground": [(15.5, 1.0), (17, 0.7)], "Tram stop": [(7.5, 1.0), (16.5, 1.0), (12, 0.4)]}
with open(KIT / "tables/activity.csv", "w", newline="") as out:
    rows = csv.writer(out)
    rows.writerow(["place", "time", "activity"])
    for n, *_ in POI:
        for step in range(33):
            h = 6 + step / 2
            v = 0.05 + sum(a * math.exp(-((h - at) / 1.1) ** 2) for at, a in PEAKS[n])
            rows.writerow([n, f"2026-11-23T{int(h):02d}:{int(h % 1 * 60):02d}", round(min(1, v), 2)])
with open(KIT / "tables/flows.csv", "w", newline="") as out:
    rows = csv.writer(out)
    rows.writerow(["from", "to", "volume"])
    for f in [("Tram stop", "School", 420), ("Tram stop", "Library", 260), ("Tram stop", "Clinic", 150), ("School", "Playground", 180), ("Library", "Café", 140), ("Café", "Tram stop", 90), ("Clinic", "Tram stop", 120)]:
        rows.writerow(f)
with open(KIT / "tables/links.csv", "w", newline="") as out:
    rows = csv.writer(out)
    rows.writerow(["from", "to"])
    for l in [("School", "Library"), ("School", "Playground"), ("Library", "Café"), ("Café", "Tram stop"), ("Clinic", "Tram stop"), ("Library", "Tram stop")]:
        rows.writerow(l)

# ---- An image with bounds (raster overlay) and a slideshow -----------------------

shutil.copy(SAMPLE / "slideshow" / "terrain.png", KIT / "overlay.png")
sw, ne = lonlat(-WIDTH_M / 2, -HEIGHT_M / 2), lonlat(WIDTH_M / 2, HEIGHT_M / 2)
write("overlay.json", {"image": "overlay.png", "bounds": {"west": sw[0], "south": sw[1], "east": ne[0], "north": ne[1]}, "crs": "EPSG:4326"})
(KIT / "slideshow").mkdir(exist_ok=True)
shutil.copy(SAMPLE / "slideshow" / "terrain.png", KIT / "slideshow" / "terrain.png")
write("slideshow/slideshow.json", {"slides": [
    {"type": "image", "media": "terrain.png", "duration": 6000, "fitMode": "stretch", "metadata": {"title": "The lie of the land", "source": "Sample kit"}},
    {"type": "geojson", "media": "../zones.geojson", "duration": 8000, "metadata": {"title": "Who lives where", "description": "Residents per zone", "source": "Sample kit",
     "style": {"colorProperty": "population", "fillOpacity": 0.55, "strokeWidth": 1, "strokeOpacity": 0.8}}},
    {"type": "geojson", "media": "../buildings.geojson", "duration": 8000, "metadata": {"title": "What the buildings are used for", "source": "Sample kit",
     "legend": {"items": [{"color": "#ff8a3d", "label": "Housing"}, {"color": "#4dabf7", "label": "Offices"}, {"color": "#f7d154", "label": "Shops"}, {"color": "#b197fc", "label": "Public buildings"}]},
     "style": {"colorProperty": "kind", "colorMap": {"housing": "#ff8a3d", "office": "#4dabf7", "shop": "#f7d154", "public": "#b197fc"}, "fillOpacity": 0.6, "strokeWidth": 1, "strokeOpacity": 0.9}}},
    {"type": "wms", "enabled": False, "duration": 8000, "url": "https://minkarta.lantmateriet.se/map/ortofoto/", "layers": "Ortofoto_0.5", "metadata": {"title": "Aerial photo (needs a Lantmäteriet key)", "source": "Lantmäteriet"}},
]})

# ---- Broken on purpose -------------------------------------------------------------

# 3.1 km north-west of the table, as in the 2026-11-15 feedback.
shift = lambda x, y: lonlat((x - ORIGIN[0]) * M_LON - 2200, (y - ORIGIN[1]) * M_LAT + 2200)
write("broken/buildings-3km-away.geojson", {**buildings, "features": [{**f, "geometry": map_coords(f["geometry"], shift)} for f in buildings["features"]]})
# Latitude and longitude swapped.
write("broken/buildings-lat-lon-swapped.geojson", {**buildings, "features": [{**f, "geometry": map_coords(f["geometry"], lambda x, y: [y, x])} for f in buildings["features"]]})
# No heights at all, and one as text.
nohe = json.loads(json.dumps(buildings))
for f in nohe["features"]:
    f["properties"].pop("height"); f["properties"].pop("levels")
nohe["features"][0]["properties"]["height"] = "about 12 m"
write("broken/buildings-no-heights.geojson", nohe)
# Half the buildings off the table edge.
write("broken/buildings-half-off.geojson", {**buildings, "features": [{**f, "geometry": map_coords(f["geometry"], lambda x, y: lonlat((x - ORIGIN[0]) * M_LON + 500, (y - ORIGIN[1]) * M_LAT))} for f in buildings["features"]]})
# Points given as walking paths, and a CSV without position columns.
write("broken/walkways-are-points.geojson", trees)
(KIT / "broken/trees-no-position.csv").write_text("id,species,height\n1,Tilia cordata,9\n2,Quercus robur,14\n")
print("kit written to", KIT)
