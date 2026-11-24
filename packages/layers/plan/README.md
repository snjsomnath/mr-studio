# Masterplan

A plan drawing over the table, revealed one phase at a time (#193), as the Chalmers demo's "Campus Vision" did.

Bring an SVG in from the editor (Add data, a dataset of your own, such as `masterplan`). The host reads it in Rust (`crates/mrs-site/src/plan.rs`):

- Its top-level groups are its phases: one Inkscape or Illustrator layer each. A single group around everything is looked inside. A phase is named by its layer name (`inkscape:label` or `data-name`), else its id ("primary_routes" reads "Primary routes").
- It is made safe: scripts, embedded pages, event handlers and links to other files are taken out, so a drawing can only draw.
- It covers the whole table, its top along the table's top. A drawing of another shape is stretched, and the import says so.

On the table, what is outside every phase is always drawn first. Turned on, the layer shows the whole plan. The first Next dims it to a faint outline and brings in the first phase with a reveal that grows from the middle of the table; each Next after that brings in the next phase, and the newest one glows briefly. Previous takes phases back out. With "Next reveals one phase at a time" off, the whole plan shows and Next moves on. The controller's legend lists the phases in their colours and follows the reveal; the phase names can be translated in the site's `branding.translations`.

Params: `dataset` (the drawing's dataset name; empty takes the table's first SVG), `reveal`, `opacity`.
