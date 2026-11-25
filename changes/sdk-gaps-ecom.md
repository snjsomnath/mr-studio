---
bump: minor
issues: 373
---
### Layers read nested data, lists of flows and bound yes/no values

Several things a code layer needed workarounds for now work as they are:

- An entity set's `key`, `label`, `group` and facts can name a nested property by a dotted path, such as `ecom.name`.
- A widget's list prop can be bound as a whole, with its items checked as they arrive.
- A bound yes/no or number that a layer published as text is read correctly.
- A team widget can say its own words in the visitors' language with `env.say`.
- A network link can hold its whole day of flows as one list (`flow_hourly`), so the `network` motion plays it with no series table.

The shared play head is still to come.

![A network playing the flows held on each link](docs/screenshots/373-network-lists.png)
