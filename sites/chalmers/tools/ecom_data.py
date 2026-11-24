"""Copy the ECOM export from an interactive_map checkout into this site (#192).

    python tools/ecom_data.py ../interactive_map

interactive_map's media/ecom holds what its ECOM backend last exported for the campus
(scripts/export_mr_layer.py): buildings, nodes and flows. The buildings keep their numbers
under an `ecom` object; MR Studio's entities read top-level properties, so those are
lifted up (name, owner, pv_kw, self_sufficiency and the hourly series). Nodes and flows
are copied as they are. Run it again after a new export.
"""
import json
import sys
from pathlib import Path

LIFTED = ["name", "owner", "pv_kw", "self_sufficiency", "demand_kwh", "grid_kwh", "solar_kwh", "demand_hourly", "solar_hourly"]


def main() -> None:
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "../interactive_map") / "media" / "ecom"
    out = Path(__file__).resolve().parents[1] / "data" / "ecom"
    out.mkdir(parents=True, exist_ok=True)
    buildings = json.loads((source / "ecom-buildings.geojson").read_text(encoding="utf-8"))
    for feature in buildings["features"]:
        p = feature["properties"]
        ecom = p.pop("ecom", None) or {}
        p.pop("lantmateriet_ids", None)
        for key in LIFTED:
            if key in ecom:
                p[key] = ecom[key]
        p.setdefault("name", p.get("id"))
    (out / "buildings.geojson").write_text(json.dumps(buildings, ensure_ascii=False), encoding="utf-8")
    for name in ("nodes", "flows"):
        data = json.loads((source / f"ecom-{name}.geojson").read_text(encoding="utf-8"))
        (out / f"{name}.geojson").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"{len(buildings['features'])} buildings, nodes and flows written to {out}")


if __name__ == "__main__":
    main()
