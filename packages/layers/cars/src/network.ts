import { byHighway, readStreetGraph, readSiteGeometry } from '@mrstudio/sdk';
import type { SiteInfo, StreetGraph, StreetGraphSpec } from '@mrstudio/sdk';

/**
 * OpenStreetMap classes cars drive on, as the interactive_map traffic did, without `service`:
 * parking aisles and driveways are short stubs that cars would only bounce along (#201).
 */
export const MOTOR_ROADS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
]);
const MAJOR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link']);
/** Where buses run, as in the interactive map: the bigger streets. */
const BUS_ROADS = new Set([...MAJOR_ROADS, 'tertiary', 'tertiary_link']);

/** Pieces of street network shorter than this in all are left out: a car there could only turn round and round. */
export const SHORTEST_PIECE_M = 250;

/** Whether cars drive on a street: any street, unless its OpenStreetMap class says it is not for cars. */
export const forCars = byHighway(MOTOR_ROADS);

/** The streets cars drive, as plain data for the SDK's data worker (#484). */
export const CAR_STREETS: StreetGraphSpec = { include: { highway: [...MOTOR_ROADS] }, major: { highway: [...MAJOR_ROADS], unclassed: false }, shortestPieceM: SHORTEST_PIECE_M };
/** The streets buses drive. */
export const BUS_STREETS: StreetGraphSpec = { include: { highway: [...BUS_ROADS] }, shortestPieceM: SHORTEST_PIECE_M };

/**
 * The streets cars and buses drive, as graphs built in the data worker and kept per file (#484);
 * when the data has no classes, buses drive the cars' streets. Null without a `roads` dataset.
 */
export async function carNetworks(site: SiteInfo): Promise<{ cars: StreetGraph; buses: StreetGraph } | null> {
  const roads = await readSiteGeometry(site, 'roads');
  if (!roads) return null;
  const classed = roads.lines.some((l) => typeof l.properties.highway === 'string');
  const [cars, buses] = await Promise.all([readStreetGraph(site, CAR_STREETS), readStreetGraph(site, classed ? BUS_STREETS : CAR_STREETS)]);
  return cars && buses ? { cars, buses } : null;
}
