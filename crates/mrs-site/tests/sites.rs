//! The site packages in the repository load and bake to what they describe.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use mrs_site::{Site, SiteError};
use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
use tiff::tags::Tag;

fn site(id: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sites").join(id)
}

#[test]
fn sample_site_bakes() {
    let (scene, stats) = Site::load(site("sample")).unwrap().bake().unwrap();
    assert_eq!((scene.grid.width, scene.grid.height), (1000, 600));
    assert!(stats.buildings > 50 && stats.trees > 50);
}

#[test]
fn chalmers_bakes_from_mesh_and_geotiff() {
    let site = Site::load(site("chalmers")).unwrap();
    let (scene, stats) = site.bake().unwrap();
    let grid = scene.grid;
    assert_eq!((grid.width, grid.height), (1250, 750));

    // The terrain raster covers the table area exactly, and keeps its elevation range.
    assert_eq!(stats.terrain_missing_cells, 0);
    let (low, high) = scene.dtm.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    assert!((32.0..33.0).contains(&low) && (84.0..85.0).contains(&high), "{low} {high}");

    // The mesh covers it too, and gives the buildings their heights.
    assert!(stats.mesh_coverage > 0.99, "{}", stats.mesh_coverage);
    assert!((0.18..0.27).contains(&stats.solid_fraction), "{}", stats.solid_fraction);
    assert!((95.0..100.0).contains(&stats.max_height_m), "{}", stats.max_height_m);
    assert!(scene.dsm.iter().zip(&scene.dtm).all(|(dsm, dtm)| dsm >= dtm));
    assert!(stats.trees > 7000);

    // The footprints are only drawn, yet they must sit on the mesh's buildings: most
    // cells at a footprint's centre are solid. A mesh placed a few metres off fails this.
    let projection = site.projection();
    let text = std::fs::read_to_string(site.dir.join("data/buildings.geojson")).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    let (mut inside, mut solid) = (0, 0);
    for feature in doc["features"].as_array().unwrap() {
        let ring = feature["geometry"]["coordinates"][0][0].as_array().unwrap();
        let n = ring.len() as f64;
        let lon = ring.iter().map(|p| p[0].as_f64().unwrap()).sum::<f64>() / n;
        let lat = ring.iter().map(|p| p[1].as_f64().unwrap()).sum::<f64>() / n;
        let (east, north) = projection.to_local(lon, lat);
        let (col, row) = grid.local_to_cell(east, north);
        if col < 0.0 || row < 0.0 || col >= grid.width as f64 || row >= grid.height as f64 {
            continue;
        }
        let i = row as usize * grid.width as usize + col as usize;
        inside += 1;
        solid += usize::from(scene.dsm[i] - scene.dtm[i] > 2.0);
    }
    assert!(inside > 700 && solid * 10 > inside * 7, "{solid} of {inside} footprint centres are on a mesh building");

    // The table calibration from the old app comes along.
    let calibration = site.info().calibration.expect("calibration.json");
    assert!((calibration.bearing - site.manifest.extent.rotation_deg).abs() < 0.1);
    assert!((calibration.center.lon - site.manifest.origin.lon).abs() < 1e-4);
}

/// Writes a site whose terrain is a GeoTIFF: 4 x 3 pixels of 10 m in UTM 33N, rising 1 m per pixel eastwards.
fn geotiff_site(dir: &Path, keys: &[u16], crs: Option<&str>) {
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
        let mut image = encoder.new_image::<Gray32Float>(4, 3).unwrap();
        image.encoder().write_tag(Tag::ModelPixelScaleTag, &[10.0f64, 10.0, 0.0][..]).unwrap();
        // The top-left corner of the image is 20 m west and 15 m north of the zone's central meridian at 6 400 000 m north.
        image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0f64, 0.0, 0.0, 499_980.0, 6_400_015.0, 0.0][..]).unwrap();
        image.encoder().write_tag(Tag::GeoKeyDirectoryTag, keys).unwrap();
        let data: Vec<f32> = (0..12).map(|i| (i % 4) as f32).collect();
        image.write_data(&data).unwrap();
    }
    std::fs::create_dir_all(dir.join("data")).unwrap();
    std::fs::write(dir.join("data/terrain.tif"), bytes.into_inner()).unwrap();
    // The origin is the raster's centre; the site is 30 x 20 m inside the 40 x 30 m raster.
    let (lon, lat) = mrs_site::Crs::from_epsg(32633).unwrap().inverse(500_000.0, 6_400_000.0);
    let mut terrain = serde_json::json!({ "path": "data/terrain.tif" });
    if let Some(crs) = crs {
        terrain["crs"] = crs.into();
    }
    let manifest = serde_json::json!({
        "format": 1, "id": "tiff", "name": "GeoTIFF test",
        "origin": { "lon": lon, "lat": lat },
        "extent": { "width_m": 30, "height_m": 20 },
        "scene": { "cell_m": 10, "terrain": terrain }
    });
    std::fs::write(dir.join("site.json"), manifest.to_string()).unwrap();
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mrs-site-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn geotiff_terrain_is_placed_by_its_georeference() {
    let dir = temp("geotiff");
    // GeoKeys: projected model, PixelIsArea, EPSG:32633.
    geotiff_site(&dir, &[1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32633], None);
    let (scene, stats) = Site::load(&dir).unwrap().bake().unwrap();
    assert_eq!(stats.terrain_missing_cells, 0);
    // Cell centres are 10 m apart around the origin, which sits on the border of pixel columns 1 and 2.
    for (i, value) in scene.dtm.iter().enumerate() {
        let expected = [0.5, 1.5, 2.5][i % 3];
        assert!((value - expected).abs() < 1e-3, "cell {i}: {value}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn geotiff_without_a_coordinate_system_asks_for_one() {
    let dir = temp("geotiff-nocrs");
    let keys = [1, 1, 0, 2, 1024, 0, 1, 1, 1025, 0, 1, 1];
    geotiff_site(&dir, &keys, None);
    match Site::load(&dir).unwrap().bake() {
        Err(SiteError::Parse { message, .. }) => assert!(message.contains("\"crs\""), "{message}"),
        other => panic!("expected a parse error, got {other:?}"),
    }
    // Naming it in the manifest is enough.
    geotiff_site(&dir, &keys, Some("EPSG:32633"));
    assert!(Site::load(&dir).unwrap().bake().is_ok());
    // An unknown code is caught when the site loads.
    geotiff_site(&dir, &keys, Some("EPSG:2154"));
    assert!(matches!(Site::load(&dir), Err(SiteError::Invalid(_))));
    std::fs::remove_dir_all(&dir).unwrap();
}
