// The SDK's types and the host's messages must agree (#538). docs/contracts/protocol.schema.json is
// written by the host from its own types (mrs-host `protocol_schema`); this walks `SessionState` in
// src/types.ts beside it and names every field one side has and the other does not.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const schema = JSON.parse(
  readFileSync(join(root, "docs", "contracts", "protocol.schema.json"), "utf8"),
);

type Schema = boolean | Record<string, any>;

function resolveRef(s: Schema): Schema {
  for (
    let hops = 0;
    typeof s === "object" && typeof s.$ref === "string" && hops < 32;
    hops++
  )
    s = schema.$defs[s.$ref.replace("#/$defs/", "")] ?? true;
  return s;
}

/** The schema without its null option (Option<T> is anyOf [T, null] or type [T, null]). */
function nonNull(s: Schema): Schema[] {
  const r = resolveRef(s);
  if (typeof r !== "object") return [r];
  const options = (r.anyOf ?? r.oneOf) as Schema[] | undefined;
  if (options)
    return options
      .flatMap(nonNull)
      .filter((o) => !(typeof o === "object" && o.type === "null"));
  return [r];
}

const program = ts.createProgram([join(here, "..", "src", "types.ts")], {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(join(here, "..", "src", "types.ts"))!;
const exported = new Map(
  checker
    .getExportsOfModule(checker.getSymbolAtLocation(source)!)
    .map((s) => [s.name, s]),
);

/** The TypeScript type without null and undefined, split into its union members. */
function members(type: ts.Type): ts.Type[] {
  const all = type.isUnion() ? type.types : [type];
  return all.filter(
    (t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
  );
}

const isObject = (t: ts.Type) =>
  Boolean(t.flags & ts.TypeFlags.Object) &&
  !checker.isArrayType(t) &&
  !checker.isTupleType(t);

/** Every place the two disagree, by path. */
function compare(
  s: Schema,
  type: ts.Type,
  path: string,
  out: string[],
  depth = 0,
): void {
  if (depth > 12) return;
  const rust = nonNull(s).filter(
    (o): o is Record<string, any> => typeof o === "object",
  );
  const tsTypes = members(type);
  // An object with named fields on both sides: the names must match.
  const rustObject = rust.find((o) => o.properties);
  const tsObject = tsTypes.find(
    (t) =>
      isObject(t) &&
      checker.getPropertiesOfType(t).length > 0 &&
      !checker.getIndexInfosOfType(t).length,
  );
  if (rustObject && tsObject) {
    const rustKeys = Object.keys(rustObject.properties);
    const tsProps = new Map(
      checker.getPropertiesOfType(tsObject).map((p) => [p.name, p]),
    );
    for (const key of rustKeys) {
      const prop = tsProps.get(key);
      if (!prop)
        out.push(
          `${path}.${key}: the host sends it, types.ts has no such field`,
        );
      else
        compare(
          rustObject.properties[key],
          checker.getTypeOfSymbol(prop),
          `${path}.${key}`,
          out,
          depth + 1,
        );
    }
    for (const key of tsProps.keys())
      if (!rustKeys.includes(key))
        out.push(`${path}.${key}: types.ts has it, the host never sends it`);
    return;
  }
  // A map by id on both sides: compare the values.
  const rustMap = rust.find(
    (o) => o.additionalProperties && typeof o.additionalProperties === "object",
  );
  const tsMap = tsTypes
    .map((t) => checker.getIndexInfosOfType(t)[0])
    .find(Boolean);
  if (rustMap && tsMap)
    return compare(
      rustMap.additionalProperties,
      tsMap.type,
      `${path}{}`,
      out,
      depth + 1,
    );
  // A list on both sides: compare the items.
  const rustList = rust.find(
    (o) => o.items && !Array.isArray(o.items) && typeof o.items === "object",
  );
  const tsList = tsTypes.find((t) => checker.isArrayType(t));
  if (rustList && tsList)
    return compare(
      rustList.items,
      checker.getTypeArguments(tsList as ts.TypeReference)[0]!,
      `${path}[]`,
      out,
      depth + 1,
    );
}

test("SessionState in types.ts has the fields the host sends, and no others", () => {
  const state = exported.get("SessionState");
  assert.ok(state, "types.ts exports SessionState");
  const out: string[] = [];
  compare(schema, checker.getDeclaredTypeOfSymbol(state), "SessionState", out);
  assert.deepEqual(
    out,
    [],
    "Fix types.ts (or the host) so both have the same fields; the schema is docs/contracts/protocol.schema.json",
  );
});

test("the comparison notices a renamed field", () => {
  const renamed = structuredClone(schema);
  const clock = renamed.$defs.LayerClock.properties;
  clock.when = clock.at;
  delete clock.at;
  const saved = schema.$defs;
  schema.$defs = renamed.$defs;
  const out: string[] = [];
  compare(
    renamed,
    checker.getDeclaredTypeOfSymbol(exported.get("SessionState")!),
    "SessionState",
    out,
  );
  schema.$defs = saved;
  assert.deepEqual(out.sort(), [
    "SessionState.layers{}.clock.at: types.ts has it, the host never sends it",
    "SessionState.layers{}.clock.when: the host sends it, types.ts has no such field",
  ]);
});

test("the contract numbers match the host", () => {
  const types = readFileSync(join(here, "..", "src", "types.ts"), "utf8");
  assert.equal(
    Number(/export const PROTOCOL = (\d+)/.exec(types)?.[1]),
    schema.properties.protocol.const,
  );
});
