#!/usr/bin/env python3
"""Copies the Chalmers campus data out of a checkout of Nodal-Works/interactive_map (branch main).

    python3 sites/chalmers/tools/import.py /path/to/interactive_map

It only reads the checkout. The mesh and the terrain are copied byte for byte;
the GeoJSON files are rewritten compactly with the properties MR Studio uses.
Rerun it when the campus data changes upstream, then run `mrstudio validate sites/chalmers`.
"""
import json
import shutil
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"

# Building properties worth keeping for labels and later layers.
BUILDING_PROPERTIES = ["objektidentitet", "objekttyp", "andamal1", "byggnadsnamn1"]


def coordinates(value):
    """Rounds to 7 decimals, about a centimetre."""
    if isinstance(value, list):
        return [coordinates(v) for v in value]
    return round(value, 7)


def geojson(source, target, keep):
    doc = json.loads(source.read_text(encoding="utf-8"))
    features = [
        {
            "type": "Feature",
            "properties": {k: f["properties"][k] for k in keep if f["properties"].get(k) is not None},
            "geometry": {"type": f["geometry"]["type"], "coordinates": coordinates(f["geometry"]["coordinates"])},
        }
        for f in doc["features"]
    ]
    text = json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))
    target.write_text(text + "\n", encoding="utf-8")
    print(f"  {target.name}: {len(features)} features")


def main():
    if len(sys.argv) != 2 or not (Path(sys.argv[1]) / "map-calibration.json").exists():
        sys.exit(__doc__)
    media = Path(sys.argv[1]) / "media"
    DATA.mkdir(exist_ok=True)
    shutil.copyfile(media / "mesh.stl", DATA / "mesh.stl")
    shutil.copyfile(media / "clipped_dem.geotiff.tif", DATA / "terrain.tif")
    print("  mesh.stl, terrain.tif: copied")
    geojson(media / "building-footprints.geojson", DATA / "buildings.geojson", BUILDING_PROPERTIES)
    geojson(media / "trees.geojson", DATA / "trees.geojson", ["id", "name", "height"])


if __name__ == "__main__":
    main()
