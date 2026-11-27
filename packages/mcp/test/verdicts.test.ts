// The MCP server must accept and refuse the same site.json files the app does (#537). The cases
// live in crates/mrs-site/tests/fixtures/verdicts.json; mrs-site runs them too (tests/verdicts.rs).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadLive } from "../src/core.ts";
import { validateManifest } from "../src/site.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const file = JSON.parse(
  readFileSync(
    join(root, "crates", "mrs-site", "tests", "fixtures", "verdicts.json"),
    "utf8",
  ),
);

test("the MCP server and the app agree on every verdict", () => {
  const catalog = loadLive(root);
  assert.ok(catalog.siteJsonSchema, "docs/contracts/site.schema.json is read");
  const wrong: string[] = [];
  for (const c of file.cases) {
    const site: Record<string, unknown> = { ...file.base };
    for (const [key, value] of Object.entries(c.set)) {
      if (value === null) delete site[key];
      else site[key] = value;
    }
    const dir = mkdtempSync(join(tmpdir(), "mrs-verdict-"));
    writeFileSync(join(dir, "site.json"), JSON.stringify(site));
    const errors = validateManifest(site, dir, catalog).filter(
      (i) => i.level === "error",
    );
    rmSync(dir, { recursive: true, force: true });
    if ((errors.length === 0) !== c.valid)
      wrong.push(
        `${c.why}: expected ${c.valid ? "valid" : "refused"}, got ${JSON.stringify(errors)}`,
      );
  }
  assert.deepEqual(wrong, []);
});

test("a shape error says where and what it should be", () => {
  const catalog = loadLive(root);
  const site = {
    ...file.base,
    extent: { width_m: "1000", height_m: 600 },
    layers: [{ use: "sunlight", id: "sun", button: { colour: "red" } }],
  };
  const errors = validateManifest(site, null, catalog).filter(
    (i) => i.level === "error",
  );
  assert.ok(
    errors.some(
      (i) => i.path === "extent.width_m" && /must be a number/.test(i.message),
    ),
    JSON.stringify(errors),
  );
  assert.ok(
    errors.some(
      (i) =>
        i.path === "layers[0].button.colour" &&
        /not allowed here/.test(i.message),
    ),
    JSON.stringify(errors),
  );
});
