// Prints the app's version: `version` under [workspace.package] in Cargo.toml, the one place it is set.
import { readFileSync } from 'node:fs';

const cargo = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
const section = cargo.slice(cargo.indexOf('[workspace.package]'));
const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
if (!version) throw new Error('no version under [workspace.package] in Cargo.toml');
console.log(version);
