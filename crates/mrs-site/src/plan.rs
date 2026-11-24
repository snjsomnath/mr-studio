//! Plan drawings (#193): an SVG drawn over the table, such as a masterplan, whose layers a
//! table reveals one phase at a time.
//!
//! The drawing covers the table's frame: its view box is stretched over the table, top to the
//! table's top. Its top-level groups are its phases (an Inkscape or Illustrator layer each; a
//! single group around everything is looked inside), except a group named "Base" or
//! "Background", which is drawn under the phases like shapes outside every group. Reading a drawing makes it safe to show:
//! scripts, embedded pages, event handlers and links to anything outside the file are removed,
//! so a drawing can only draw. Each phase group gets `data-mrs-phase` (its index from 0),
//! `data-mrs-name` and, when it has one, `data-mrs-colour` for the legend.

use quick_xml::events::{BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer, XmlVersion};

/// One phase of a plan: a top-level group.
#[derive(Debug, Clone, PartialEq)]
pub struct Phase {
    pub name: String,
    /// The first fill or stroke colour drawn in it, for the legend.
    pub colour: Option<String>,
    /// Shapes in it: paths, lines, circles, text, images.
    pub shapes: usize,
}

/// A drawing read and made safe.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The drawing to save.
    pub svg: String,
    pub phases: Vec<Phase>,
    /// Shapes outside every phase, always shown under them.
    pub base_shapes: usize,
    /// The drawing's width and height in its own units.
    pub size: (f64, f64),
    /// What was removed to make it safe, in words.
    pub removed: Vec<String>,
}

/// Elements that run code or show other documents. They and everything inside them are dropped.
const UNSAFE: &[&str] =
    &["script", "foreignobject", "iframe", "object", "embed", "handler", "listener", "audio", "video", "set", "animate"];
/// Elements that draw something, counted per phase.
const SHAPES: &[&str] = &["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image", "use"];
/// Names of a top-level group that is not a phase but the drawing under them (#286), such as the
/// line work of an artwork whose viewpoints are the phases. Compared without case.
const BASE_NAMES: &[&str] = &["base", "background", "underlay", "basis", "bakgrund", "underlag"];

fn is_base_name(name: Option<&str>) -> bool {
    name.is_some_and(|n| BASE_NAMES.contains(&n.trim().to_ascii_lowercase().as_str()))
}

/// Not drawn, so never phases.
const NOT_DRAWN: &[&str] = &["defs", "style", "metadata", "title", "desc", "namedview", "sodipodi:namedview", "clippath", "mask", "symbol"];

/// Reads `text` as an SVG plan drawing.
pub fn read(text: &str) -> Result<Plan, String> {
    // A first pass finds where the phases are: the root's groups, or inside its only group.
    let top = top_groups(text)?;
    let mut rewritten = rewrite(text, if top == 1 { 2 } else { 1 })?;
    if top == 1 && rewritten.1.is_empty() {
        // The one group has no groups inside: it is the only phase.
        rewritten = rewrite(text, 1)?;
    }
    let (svg, phases, base_shapes, size, removed) = rewritten;
    if phases.is_empty() {
        return Err("The drawing has no groups to reveal. Put each phase on its own layer (a group) and export again.".into());
    }
    Ok(Plan { svg, phases, base_shapes, size, removed })
}

fn local(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// An attribute's value with entities resolved.
fn value_of(a: &quick_xml::events::attributes::Attribute) -> String {
    a.normalized_value(XmlVersion::default()).map(|v| v.into_owned()).unwrap_or_default()
}

fn is_unsafe(name: &str) -> bool {
    UNSAFE.contains(&name) || name.starts_with("animate")
}

/// How many groups sit directly under the root.
fn top_groups(text: &str) -> Result<usize, String> {
    let mut reader = Reader::from_str(text);
    let mut depth = 0usize;
    let mut skip = 0usize;
    let mut groups = 0;
    let mut root = false;
    loop {
        match reader.read_event().map_err(bad_xml)? {
            Event::Start(e) => {
                let name = local(e.name().as_ref());
                depth += 1;
                if depth == 1 {
                    root = name == "svg";
                } else if depth == 2 && skip == 0 && name == "g" {
                    groups += 1;
                }
                if skip > 0 || (depth >= 2 && (is_unsafe(&name) || NOT_DRAWN.contains(&name.as_str()))) {
                    skip += 1;
                }
            }
            Event::End(_) => {
                skip = skip.saturating_sub(1);
                depth = depth.saturating_sub(1);
            }
            Event::Empty(e) if depth == 0 => root = local(e.name().as_ref()) == "svg",
            Event::Eof => break,
            _ => {}
        }
    }
    if !root {
        return Err("This is not an SVG drawing.".into());
    }
    Ok(groups)
}

fn bad_xml(e: quick_xml::Error) -> String {
    format!("The drawing could not be read: {e}.")
}

/// A link kept: one inside the file, or an embedded raster image.
fn safe_link(value: &str) -> bool {
    let v = value.trim_start().to_ascii_lowercase();
    v.starts_with('#') || ["data:image/png", "data:image/jpeg", "data:image/gif", "data:image/webp"].iter().any(|p| v.starts_with(p))
}

/// CSS with every `url(...)` that leaves the file replaced by `none`, and `@import` removed.
fn safe_css(css: &str) -> (String, bool) {
    let mut out = String::with_capacity(css.len());
    let mut changed = false;
    let mut rest = css;
    while let Some(at) = rest.to_ascii_lowercase().find("url(") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 4..];
        let end = after.find(')').map_or(after.len(), |e| e + 1);
        let inner = after[..end.saturating_sub(1)].trim().trim_matches(|c| c == '"' || c == '\'');
        if safe_link(inner) {
            out.push_str(&rest[at..at + 4 + end]);
        } else {
            out.push_str("none");
            changed = true;
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    // An @import statement runs to its semicolon.
    while let Some(at) = out.to_ascii_lowercase().find("@import") {
        changed = true;
        let end = out[at..].find(';').map_or(out.len(), |e| at + e + 1);
        out.replace_range(at..end, "");
    }
    (out, changed)
}

/// A colour from `fill`/`stroke` attributes or a style, if it is a plain colour.
fn colour_of(e: &BytesStart) -> Option<String> {
    let plain = |v: &str| {
        let v = v.trim();
        let lower = v.to_ascii_lowercase();
        (!v.is_empty() && !["none", "transparent", "currentcolor", "inherit"].contains(&lower.as_str()) && !lower.starts_with("url("))
            .then(|| v.to_string())
    };
    let mut found = None;
    for a in e.attributes().flatten() {
        let key = local(a.key.as_ref());
        let value = value_of(&a);
        match key.as_str() {
            "style" => {
                for decl in value.split(';') {
                    if let Some((k, v)) = decl.split_once(':') {
                        if matches!(k.trim(), "fill" | "stroke") {
                            if let Some(c) = plain(v) {
                                return Some(c);
                            }
                        }
                    }
                }
            }
            "fill" | "stroke" if found.is_none() => found = plain(&value),
            _ => {}
        }
    }
    found
}

/// "primary_routes", "Primary-Routes" or Illustrator's "Primary_x20_routes" as "Primary routes".
fn pretty(id: &str) -> String {
    let spaced = id.replace("_x20_", " ").replace(['_', '-'], " ");
    let words: Vec<&str> = spaced.split_whitespace().collect();
    let mut name = words.join(" ").to_lowercase();
    if let Some(first) = name.get(0..1) {
        name = first.to_uppercase() + &name[1..];
    }
    name
}

fn number(value: &str) -> Option<f64> {
    let digits: String = value.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    digits.parse().ok().filter(|v: &f64| v.is_finite() && *v > 0.0)
}

type Rewritten = (String, Vec<Phase>, usize, (f64, f64), Vec<String>);

fn rewrite(text: &str, phase_depth: usize) -> Result<Rewritten, String> {
    let mut reader = Reader::from_str(text);
    let mut writer = Writer::new(Vec::new());
    let mut depth = 0usize;
    // While inside a dropped element, how deep into it.
    let mut skip = 0usize;
    // While inside a <style>, its text is made safe too.
    let mut in_style = false;
    // The phase being read, and the depth of its group.
    let mut phase: Option<usize> = None;
    let mut phases: Vec<Phase> = Vec::new();
    let mut base_shapes = 0;
    let mut size = None;
    let mut removed: Vec<String> = Vec::new();
    let mut note = |what: String| {
        if !removed.contains(&what) {
            removed.push(what);
        }
    };

    loop {
        let event = reader.read_event().map_err(bad_xml)?;
        let (start, empty) = match &event {
            Event::Start(e) => (Some(e.clone()), false),
            Event::Empty(e) => (Some(e.clone()), true),
            _ => (None, false),
        };
        if let Some(e) = start {
            let name = local(e.name().as_ref());
            let level = depth + 1;
            if !empty {
                depth += 1;
            }
            if skip > 0 {
                if !empty {
                    skip += 1;
                }
                continue;
            }
            if is_unsafe(&name) {
                note(format!("<{name}> elements"));
                if !empty {
                    skip = 1;
                }
                continue;
            }
            // Attributes: no event handlers, no links out of the file.
            let mut out = BytesStart::new(e.name().as_ref().to_string());
            let mut id = None;
            let mut label = None;
            let mut view_box = None;
            let (mut width, mut height) = (None, None);
            for a in e.attributes().flatten() {
                let key = a.key.as_ref().to_string();
                let lower = key.to_ascii_lowercase();
                let value = value_of(&a);
                if lower.starts_with("on") {
                    note("event handlers".into());
                    continue;
                }
                if (lower == "href" || lower.ends_with(":href")) && !safe_link(&value) {
                    note("links to other files".into());
                    continue;
                }
                if lower.starts_with("data-mrs-") || (level == 1 && lower == "preserveaspectratio") {
                    continue;
                }
                let value = if lower == "style" || value.to_ascii_lowercase().contains("url(") {
                    let (css, changed) = safe_css(&value);
                    if changed {
                        note("links to other files".into());
                    }
                    css
                } else {
                    value
                };
                match lower.as_str() {
                    "id" => id = Some(value.clone()),
                    "inkscape:label" | "data-name" => label = Some(value.clone()),
                    "viewbox" => view_box = Some(value.clone()),
                    "width" => width = number(&value),
                    "height" => height = number(&value),
                    _ => {}
                }
                out.push_attribute((key.as_str(), value.as_str()));
            }
            if level == 1 {
                if name != "svg" {
                    return Err("This is not an SVG drawing.".into());
                }
                let from_box = view_box.as_deref().and_then(|v| {
                    let n: Vec<f64> = v.split(|c: char| c == ',' || c.is_whitespace()).filter_map(|s| s.parse().ok()).collect();
                    (n.len() == 4 && n[2] > 0.0 && n[3] > 0.0).then(|| (n[2], n[3]))
                });
                let measured = from_box.or(width.zip(height));
                let (w, h) = measured.ok_or("The drawing has no size: give it a viewBox, or a width and a height.")?;
                if from_box.is_none() {
                    out.push_attribute(("viewBox", format!("0 0 {w} {h}").as_str()));
                }
                // Stretched over the table's frame.
                out.push_attribute(("preserveAspectRatio", "none"));
                size = Some((w, h));
            }
            if level == phase_depth + 1 && phase.is_none() && name == "g" && !empty && !is_base_name(label.as_deref().or(id.as_deref())) {
                let k = phases.len();
                let name = label
                    .or_else(|| id.as_deref().map(pretty))
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| format!("Part {}", k + 1));
                out.push_attribute(("data-mrs-phase", k.to_string().as_str()));
                out.push_attribute(("data-mrs-name", name.as_str()));
                phases.push(Phase { name, colour: colour_of(&e), shapes: 0 });
                phase = Some(level);
            } else if SHAPES.contains(&name.as_str()) {
                match phase {
                    Some(_) => {
                        let p = phases.last_mut().expect("a phase");
                        p.shapes += 1;
                        if p.colour.is_none() {
                            p.colour = colour_of(&e);
                        }
                    }
                    None if level > 1 => base_shapes += 1,
                    None => {}
                }
            }
            in_style = name == "style" && !empty;
            let written = if empty { Event::Empty(out) } else { Event::Start(out) };
            writer.write_event(written).map_err(|e| e.to_string())?;
            continue;
        }
        match event {
            Event::End(e) => {
                let level = depth;
                depth = depth.saturating_sub(1);
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                if phase == Some(level) {
                    phase = None;
                }
                in_style = false;
                writer.write_event(Event::End(e)).map_err(|e| e.to_string())?;
            }
            Event::Text(t) if skip == 0 => {
                if in_style {
                    let css = t.xml10_content().into_owned();
                    let (css, changed) = safe_css(&css);
                    if changed {
                        note("links to other files".into());
                    }
                    writer.write_event(Event::Text(BytesText::new(&css))).map_err(|e| e.to_string())?;
                } else {
                    writer.write_event(Event::Text(t)).map_err(|e| e.to_string())?;
                }
            }
            Event::CData(t) if skip == 0 => {
                if in_style {
                    let css = t.into_inner().into_owned();
                    let (css, changed) = safe_css(&css);
                    if changed {
                        note("links to other files".into());
                    }
                    writer.write_event(Event::Text(BytesText::new(&css))).map_err(|e| e.to_string())?;
                } else {
                    writer.write_event(Event::CData(t)).map_err(|e| e.to_string())?;
                }
            }
            // Processing instructions can point at style sheets elsewhere; a doctype can define entities.
            Event::PI(_) | Event::DocType(_) => note("instructions to the reader".into()),
            Event::Decl(d) if skip == 0 => writer.write_event(Event::Decl(d)).map_err(|e| e.to_string())?,
            Event::Comment(_) => {}
            Event::Eof => break,
            other if skip == 0 => writer.write_event(other).map_err(|e| e.to_string())?,
            _ => {}
        }
    }
    let size = size.ok_or("This is not an SVG drawing.")?;
    let svg = String::from_utf8(writer.into_inner()).map_err(|e| e.to_string())?;
    Ok((svg, phases, base_shapes, size, removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = r##"<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1250 750" onload="alert(1)">
  <style>@import url(https://evil.example/x.css); .r { fill: url(#grad); stroke: url(https://evil.example/a.svg) }</style>
  <defs><linearGradient id="grad"/></defs>
  <rect width="1250" height="750" fill="#f4f1ea"/>
  <g id="Project_x20_boundary" inkscape:label="Project boundary"><path d="M0 0L10 10" stroke="#e03131" fill="none"/></g>
  <g id="primary_routes"><g><path d="M0 0" style="fill:none;stroke:#1971c2"/><line x1="0" y1="0" x2="5" y2="5"/></g></g>
  <g data-name="Green spaces"><script>alert(2)</script><circle r="4" fill="#2f9e44" onclick="x()"/>
    <image xlink:href="https://evil.example/tracker.png"/><image href="data:image/png;base64,AAAA"/></g>
  <foreignObject><div>hi</div></foreignObject>
</svg>"##;

    #[test]
    fn groups_become_named_phases_and_the_drawing_is_made_safe() {
        let plan = read(PLAN).unwrap();
        let names: Vec<&str> = plan.phases.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Project boundary", "Primary routes", "Green spaces"]);
        assert_eq!(plan.phases[0].colour.as_deref(), Some("#e03131"));
        assert_eq!(plan.phases[1].colour.as_deref(), Some("#1971c2"));
        assert_eq!(plan.phases[1].shapes, 2);
        assert_eq!(plan.phases[2].shapes, 3);
        assert_eq!(plan.base_shapes, 1);
        assert_eq!(plan.size, (1250.0, 750.0));
        let svg = &plan.svg;
        for gone in ["alert", "onload", "onclick", "evil.example", "foreignObject", "@import", "<?xml-stylesheet"] {
            assert!(!svg.contains(gone), "{gone} is still in {svg}");
        }
        assert!(svg.contains("url(#grad)"), "links inside the file stay");
        assert!(svg.contains("data:image/png"), "embedded images stay");
        assert!(svg.contains(r#"data-mrs-phase="2" data-mrs-name="Green spaces""#));
        assert!(svg.contains(r#"preserveAspectRatio="none""#));
        assert!(plan.removed.iter().any(|r| r.contains("script")));
    }

    #[test]
    fn a_single_wrapping_group_is_looked_inside() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="400px" height="300px"><g id="Layer_1"><g id="roads"><path d="M0 0"/></g><g id="parks"><rect/></g></g></svg>"#;
        let plan = read(svg).unwrap();
        assert_eq!(plan.phases.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Roads", "Parks"]);
        assert_eq!(plan.size, (400.0, 300.0));
        assert!(plan.svg.contains(r#"viewBox="0 0 400 300""#));
    }

    #[test]
    fn what_cannot_be_a_plan_is_refused() {
        assert!(read("<html><body/></html>").unwrap_err().contains("not an SVG"));
        assert!(read(r#"<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>"#).unwrap_err().contains("no size"));
        assert!(read(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0"/></svg>"#)
            .unwrap_err()
            .contains("no groups"));
        assert!(read("<svg").is_err());
    }

    #[test]
    fn a_group_named_base_is_drawn_under_the_phases() {
        let plan = read(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g id="Base"><path d="M0 0L1 1" stroke="#fff"/><path d="M1 1L2 2" stroke="#fff"/></g><g id="viewpoint_1"><circle r="1"/></g></svg>"##,
        )
        .unwrap();
        assert_eq!(plan.phases.len(), 1);
        assert_eq!(plan.phases[0].name, "Viewpoint 1");
        assert_eq!(plan.base_shapes, 2);
        assert!(!plan.svg.contains(r#"id="Base" data-mrs-phase"#));
    }
}
