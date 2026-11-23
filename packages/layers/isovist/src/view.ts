// What the controller and the TV show of a view: its parts in the demo's colours, and the
// words for how green it is. Pure, so the hero, the panel and the tests share them.

/** The demo's colours (controller/isovist-dashboard.js): open sky, trees, and Lantmäteriet building types. */
export const PART_COLOURS: Record<string, string> = {
  'Open view': '#87CEEB',
  Trees: '#2D5A27',
  Bostad: '#E57373',
  Verksamhet: '#00ACC1',
  Samhällsfunktion: '#9C27B0',
  Komplementbyggnad: '#FF9800',
  Unknown: '#888888',
};

/** Building types in plain words for the controller. Types not listed keep their own name. */
export const TYPE_WORDS: Record<string, string> = {
  Bostad: 'Homes',
  Verksamhet: 'Business',
  Samhällsfunktion: 'Public',
  Komplementbyggnad: 'Outbuildings',
  Industri: 'Industry',
  'Övrig byggnad': 'Other',
  Ekonomibyggnad: 'Farm',
  Unknown: 'Buildings',
};

export const partColour = (name: string) => PART_COLOURS[name] ?? PART_COLOURS.Unknown!;

/** One part of the view, as a share of the rays. */
export interface ViewPart {
  name: string;
  label: string;
  share: number;
  colour: string;
}

/** The parts of a view in the demo's order (sky, trees, then buildings by type), leaving out empty ones. */
export function viewParts(open: number, trees: number, byType: Record<string, number>, rays: number): ViewPart[] {
  const n = Math.max(1, rays);
  const parts: ViewPart[] = [
    { name: 'Open view', label: 'Open sky', share: open / n, colour: partColour('Open view') },
    { name: 'Trees', label: 'Trees', share: trees / n, colour: partColour('Trees') },
  ];
  const order = ['Bostad', 'Verksamhet', 'Samhällsfunktion', 'Komplementbyggnad'];
  const types = Object.keys(byType).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const type of types) {
    parts.push({ name: type, label: TYPE_WORDS[type] ?? type, share: byType[type]! / n, colour: partColour(type) });
  }
  return parts.filter((p, i) => i < 2 || p.share > 0).map((p) => ({ ...p, share: Math.round(p.share * 1000) / 1000 }));
}

/** The demo's rating of a green view factor (0 to 1): 30% and up is good, 15% fair. */
export function greenWord(gvf: number): 'Good' | 'Fair' | 'Poor' {
  if (gvf >= 0.3) return 'Good';
  if (gvf >= 0.15) return 'Fair';
  return 'Poor';
}

/** What the soundscape is doing, in words for the controller. */
export function mixWord(mix: { nature: number; city: number } | null | undefined): string {
  if (!mix) return 'Soundscape off';
  const total = mix.nature + mix.city;
  if (total < 0.01) return 'Quiet';
  const share = mix.nature / total;
  if (share > 0.7) return 'Mostly birdsong';
  if (share > 0.4) return 'Birds and traffic';
  if (share > 0.15) return 'Traffic, a few birds';
  return 'Traffic';
}

/** The Street View Static picture for a place and a heading (Google's own address; the host adds the key). */
export function streetViewImageUrl(lonLat: readonly [number, number], heading: number, size = '640x400', fov = 100): string {
  const [lon, lat] = lonLat;
  return `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${lat.toFixed(6)},${lon.toFixed(6)}&heading=${Math.round(heading)}&pitch=0&fov=${fov}&source=outdoor&return_error_code=true`;
}

/** The Street View metadata for a place: where the nearest panorama was taken. Free of charge. */
export function streetViewMetadataUrl(lonLat: readonly [number, number]): string {
  const [lon, lat] = lonLat;
  return `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat.toFixed(6)},${lon.toFixed(6)}&source=outdoor`;
}

/** A request to a service through the host, which signs it with the key kept in Sources. */
export function throughSource(source: string, url: string): string {
  return `/api/sources/${encodeURIComponent(source)}/proxy?url=${encodeURIComponent(url)}`;
}
