#!/usr/bin/env python3
"""Drawings for the drawing reveal, the Magnifier and the Reveal line (#286, #287, #288).

Made from the synthetic district in sites/sample, in table metres (the drawing's viewBox is the
table, 1000 x 600 m), so they land on the sample table without corners:

  drawing/viewpoints.svg         white line work, with four viewpoints as layers: what can be
                                 seen from a spot (a ray cast against the buildings) and a mark
  drawing/viewpoints-colour.svg  the same district in colour, for the turn to colour
  drawing/underground.svg        made-up pipes, a tunnel and a metro line, for an X-ray

Python standard library only:  python3 samples/kit/tools/make_drawing.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.normpath(os.path.join(HERE, '..', 'drawing'))
SITE = os.path.join(ROOT, 'sites', 'sample')

LON0, LAT0, W, H = 11.97, 57.7, 1000.0, 600.0
A, E2 = 6378137.0, 6.69437999014e-3
PHI = math.radians(LAT0)
S = 1 - E2 * math.sin(PHI) ** 2
M_LAT = A * (1 - E2) / S ** 1.5 * math.pi / 180
M_LON = A / math.sqrt(S) * math.cos(PHI) * math.pi / 180


def table(lon, lat):
    """WGS84 to table metres, as tableFrame in the SDK does for a table without rotation."""
    return ((lon - LON0) * M_LON + W / 2, H / 2 - (lat - LAT0) * M_LAT)


def load(name):
    with open(os.path.join(SITE, 'data', name), encoding='utf-8') as f:
        return json.load(f)['features']


def rings(feature):
    g = feature['geometry']
    polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates'] if g['type'] == 'MultiPolygon' else []
    return [[table(*c[:2]) for c in poly[0]] for poly in polys]


def lines(feature):
    g = feature['geometry']
    ls = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates'] if g['type'] == 'MultiLineString' else []
    return [[table(*c[:2]) for c in line] for line in ls]


def d(points, close=False):
    s = 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in points)
    return s + (' Z' if close else '')


buildings = [r for f in load('buildings.geojson') for r in rings(f)]
heights = [float(f['properties'].get('height') or 12) for f in load('buildings.geojson') for _ in rings(f)]
roads = [l for f in load('roads.geojson') for l in lines(f)]
walks = [l for f in load('walkways.geojson') for l in lines(f)]


def hit(origin, angle, reach):
    """How far a ray from origin goes before it meets a building wall."""
    ox, oy = origin
    dx, dy = math.cos(angle), math.sin(angle)
    best = reach
    for ring in buildings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            ex, ey = x2 - x1, y2 - y1
            den = dx * ey - dy * ex
            if abs(den) < 1e-9:
                continue
            t = ((x1 - ox) * ey - (y1 - oy) * ex) / den
            u = ((x1 - ox) * dy - (y1 - oy) * dx) / den
            if 0 < t < best and 0 <= u <= 1:
                best = t
    return best


def isovist(origin, reach=190, rays=240):
    return [(origin[0] + math.cos(a) * hit(origin, a, reach), origin[1] + math.sin(a) * hit(origin, a, reach))
            for a in (k / rays * math.tau for k in range(rays))]


def inside(point, ring):
    x, y = point
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def open_spot(x, y):
    """The nearest spot to (x, y) that is not inside a building."""
    for r in range(0, 200, 4):
        for k in range(16):
            p = (x + r * math.cos(k * math.tau / 16), y + r * math.sin(k * math.tau / 16))
            if not any(inside(p, ring) for ring in buildings):
                return p
    return (x, y)


VIEWPOINTS = [
    ('Viewpoint 1', open_spot(300, 330), '#ffb86b'),
    ('Viewpoint 2', open_spot(520, 250), '#ff7eb6'),
    ('Viewpoint 3', open_spot(700, 410), '#7ee0ff'),
    ('Viewpoint 4', open_spot(820, 190), '#b5f27e'),
]

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 1000 600" width="1000" height="600">\n'


def line_work():
    out = ['<g id="base" inkscape:label="Base" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">']
    for line in roads:
        out.append(f'<path d="{d(line)}" stroke-width="1.6" stroke-opacity="0.8"/>')
    for line in walks:
        out.append(f'<path d="{d(line)}" stroke-width="0.6" stroke-opacity="0.55" stroke-dasharray="3 3"/>')
    for ring in buildings:
        out.append(f'<path d="{d(ring, True)}" stroke-width="1.1"/>')
    # Hatching inside the taller buildings, as a hand drawing would have it.
    for ring, h in zip(buildings, heights):
        if h < 20:
            continue
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        for k in range(int(min(xs)) - 40, int(max(xs)) + 40, 5):
            seg = [(k + t, min(ys) + t) for t in range(0, int(max(ys) - min(ys)) + 1, 1) if inside((k + t, min(ys) + t), ring)]
            if len(seg) > 2:
                out.append(f'<path d="M{seg[0][0]:.1f} {seg[0][1]:.1f} L{seg[-1][0]:.1f} {seg[-1][1]:.1f}" stroke-width="0.4" stroke-opacity="0.6"/>')
    out.append('</g>')
    return out


def viewpoints():
    out = []
    for name, spot, colour in VIEWPOINTS:
        fan = isovist(spot)
        x, y = spot
        out.append(f'<g inkscape:groupmode="layer" inkscape:label="{name}">')
        out.append(f'<path d="{d(fan, True)}" fill="{colour}" fill-opacity="0.34" stroke="{colour}" stroke-width="1.4"/>')
        for r, o in ((14, 0.9), (24, 0.5), (36, 0.25)):
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="none" stroke="{colour}" stroke-width="1.6" stroke-opacity="{o}"/>')
        star = [(x + (9 if k % 2 == 0 else 4) * math.cos(k * math.pi / 5 - math.pi / 2), y + (9 if k % 2 == 0 else 4) * math.sin(k * math.pi / 5 - math.pi / 2)) for k in range(10)]
        out.append(f'<path d="{d(star, True)}" fill="#ffffff" stroke="{colour}" stroke-width="1"/>')
        out.append('</g>')
    return out


def colour():
    out = ['<g id="colour" stroke-linejoin="round">']
    out.append('<rect x="0" y="0" width="1000" height="600" fill="#101826"/>')
    for line in roads:
        out.append(f'<path d="{d(line)}" fill="none" stroke="#2f3e5c" stroke-width="9" stroke-linecap="round"/>')
    for line in walks:
        out.append(f'<path d="{d(line)}" fill="none" stroke="#3f6f4f" stroke-width="2.5" stroke-linecap="round"/>')
    ramp = ['#f4d58d', '#f2a65a', '#e76f51', '#c8553d', '#8f2d56']
    for ring, h in zip(buildings, heights):
        c = ramp[min(len(ramp) - 1, int(h // 9))]
        out.append(f'<path d="{d(ring, True)}" fill="{c}" stroke="#ffffff" stroke-width="0.8" stroke-opacity="0.7"/>')
    out.append('</g>')
    return out


def underground():
    out = ['<g id="underground" fill="none" stroke-linecap="round" stroke-linejoin="round">']
    out.append('<rect x="0" y="0" width="1000" height="600" fill="#130d08"/>')
    # Soil strata as soft bands.
    for k, c in enumerate(['#2a1a0e', '#33210f', '#3b2611', '#2d1e10']):
        y = 40 + k * 150
        out.append(f'<path d="M-20 {y} C 250 {y - 40}, 600 {y + 50}, 1020 {y - 10} L1020 {y + 150} C 600 {y + 190}, 250 {y + 110}, -20 {y + 150} Z" fill="{c}" stroke="none"/>')
    # Water mains under the streets, a little off their middle.
    for line in roads:
        out.append(f'<path d="{d([(x + 3, y + 3) for x, y in line])}" stroke="#4cc9f0" stroke-width="2.4" stroke-opacity="0.9"/>')
    # District heating along the footpaths.
    for line in walks[::3]:
        out.append(f'<path d="{d(line)}" stroke="#ff9f1c" stroke-width="1.4" stroke-dasharray="6 4" stroke-opacity="0.85"/>')
    # A metro line in a tunnel, with three stations.
    tunnel = [(-20, 470), (200, 430), (420, 360), (600, 300), (800, 220), (1020, 160)]
    out.append(f'<path d="{d(tunnel)}" stroke="#ffd166" stroke-width="22" stroke-opacity="0.18"/>')
    out.append(f'<path d="{d(tunnel)}" stroke="#ffd166" stroke-width="5"/>')
    for x, y in tunnel[1:5:1][::1]:
        out.append(f'<rect x="{x - 16:.0f}" y="{y - 7:.0f}" width="32" height="14" rx="7" fill="#ffd166" stroke="#ffffff" stroke-width="1.5"/>')
    out.append('</g>')
    return out


os.makedirs(OUT, exist_ok=True)
for name, body in (('viewpoints.svg', line_work() + viewpoints()), ('viewpoints-colour.svg', colour()), ('underground.svg', underground())):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(HEAD + '\n'.join(body) + '\n</svg>\n')
    print('wrote', os.path.relpath(os.path.join(OUT, name), ROOT))
