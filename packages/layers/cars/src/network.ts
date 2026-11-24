import { StreetGraph, byHighway, highwayClass } from '@mrstudio/sdk';
import type { Placed, XY } from '@mrstudio/sdk';

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

/** The streets cars drive, as a graph. */
export function carNetwork(lines: Placed<XY[]>[]): StreetGraph {
  return new StreetGraph(lines, { include: forCars, major: byHighway(MAJOR_ROADS, false), shortestPieceM: SHORTEST_PIECE_M });
}

/** The streets buses drive; when the data has no classes, the same as the cars'. */
export function busNetwork(lines: Placed<XY[]>[]): StreetGraph {
  const classed = lines.some((l) => highwayClass(l.properties) !== undefined);
  return new StreetGraph(lines, { include: classed ? byHighway(BUS_ROADS) : forCars, shortestPieceM: SHORTEST_PIECE_M });
}
