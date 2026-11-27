# Expressions contract

A safe formula language in JSON (#669) for the bit of logic a table needs without code. It is in the spirit of MapLibre's style expressions. Use it to:
- work out a value from a feature's columns or the layer's live values
- pick a colour by thresholds
- keep only some features

It is data, so it travels in the table's files and the MCP server can write it. It can't loop, call anything, or read anything but the values it's given. Every surface evaluates it the same way (`packages/sdk/src/expression.ts`).

```jsonc
["/", ["get", "kwh"], ["get", "area"]]                         // a building's use per m²
[">", ["get", "year"], ["bind", "params.year"]]                // newer than the year on the slider
["step", ["get", "kwh_per_m2"], "@green", 100, "@warm", 200, "@warning"]
["interpolate", ["linear"], ["bind", "shared.share"], 0, "#2b83ba", 1, "#d7191c"]
```

An expression is either a literal (a number, text, `true`, `false` or `null`) or a list whose first item names the operator. A list used as a value is written `["literal", [1, 2, 3]]`.

## Where it is used

- **Panel props.** Any prop that can be bound (`bindable` in the widget's schema) may instead be `{ "expr": … }`. It reads live values with `["bind", "shared.<key>"]`, `params.<control>` or `site.<field>`. The result is held to the prop's limits like a bound value.

  ```json
  { "widget": "stat", "props": { "value": { "expr": ["round", ["/", ["bind", "shared.kwh"], ["bind", "site.area"]], 1] }, "unit": "kWh/m²" } }
  ```

- **Custom layer looks.** These two go in the look's `props`:
  - `columns` adds worked-out columns to every feature. The look can then paint, size, label and filter by them like any other column. They are worked out in order, so a later column may use an earlier one.
  - `where` keeps only the features it holds for. It applies before the controller's "show only" filters.

  ```json
  { "id": "homes", "block": "fill", "data": "buildings",
    "props": { "columns": { "kwh_per_m2": ["/", ["get", "kwh"], ["get", "area"]] },
               "where": [">=", ["get", "year"], ["bind", "params.from"]],
               "color": { "by": "kwh_per_m2", "kind": "number" } } }
  ```

- **In a layer's code:** `evaluateExpression(expr, { item, vars })`, or `expression(expr)` to compile once and evaluate per feature.

Later blocks build on this: conditional style (#672), text templates (#671), dataset sources (#670) and marker templates (#674).

## Rules

- **Mistakes never break the table.** A faulty expression is reported, and it evaluates to `null`, so its panel or column shows nothing. Reports go to:
  - the panel's `binding` issues
  - `lookExpressionProblems`
  - for custom layers, the MCP server's checks

  Maths on something that is not a number gives `null`, and so does dividing by zero.
- **It stays small.** An expression can nest at most 24 deep and hold at most 500 parts (`EXPRESSION_LIMITS`).
- **Names.** `get` reads a feature's property, and dotted names reach inside (`ecom.kwh`). `bind` reads only `params.`, `shared.` and `site.`. A worked-out column's name uses letters, digits and `_`.
- **Colours.** `match`, `case` and `step` may answer with palette slots (`"@warm"`). `interpolate` blends only `#rrggbb`.

## Operators

| Operator | What it gives |
| --- | --- |
| `literal` | a value as it is, such as a list: ["literal", [1, 2]] |
| `get` | a property of the feature or row: ["get", "kwh"]; dotted names reach inside |
| `has` | whether the feature or row has the property: ["has", "kwh"] |
| `bind` | a live value of the layer: ["bind", "shared.import_kw"], params.<control> or site.<field> |
| `+` | adds numbers |
| `-` | subtracts, or makes one number negative |
| `*` | multiplies numbers |
| `/` | divides; by zero is null |
| `%` | the remainder |
| `^` | a power |
| `min` | the smallest |
| `max` | the largest |
| `abs` | without its sign |
| `floor` | rounded down |
| `ceil` | rounded up |
| `sqrt` | the square root |
| `ln` | the natural logarithm |
| `log10` | the logarithm to base 10 |
| `round` | rounded, to a number of decimals if given: ["round", x, 1] |
| `clamp` | held between a low and a high: ["clamp", x, 0, 1] |
| `==` | equal (numbers as numbers, the rest as text) |
| `!=` | not equal |
| `<` | less than |
| `<=` | at most |
| `>` | more than |
| `>=` | at least |
| `all` | true when every part is |
| `any` | true when any part is |
| `!` | not |
| `case` | the first answer whose test holds, else the last: ["case", test, answer, ..., otherwise] |
| `match` | the answer for the value: ["match", value, "A", answer, ["B", "C"], answer, otherwise] |
| `coalesce` | the first part that has a value |
| `interpolate` | a smooth value between stops: ["interpolate", ["linear"], x, 0, "#2b83ba", 100, "#d7191c"] (numbers or #rrggbb colours) |
| `step` | steps at stops: ["step", x, below, 10, from10, 20, from20] |
| `concat` | joins text |
| `to-string` | as text |
| `to-number` | as a number, or null |
| `upcase` | in capitals |
| `downcase` | in small letters |
| `length` | how many letters, or items in a list |
| `in` | whether a value is in a list or a text: ["in", ["get", "use"], ["literal", ["school", "office"]]] |
