/**
 * Maps that come with MR Studio (#200): open WMS services that need no key, so a layer or a
 * slide can show them by name. The first set is SLU's open mirror of Lantmäteriet's maps
 * (hades.slu.se), the same services the interactive_map slideshows at Chalmers and
 * Lindholmen use. Their ids are the options of the `map` control in layer.json; a test keeps
 * the two lists the same.
 */
export interface Preset {
  /** The service address, without a query. */
  url: string;
  layers: string;
  styles?: string;
  /** `image/png` unless set: photos come smaller as JPEG. */
  format?: string;
  /** The credit shown with the map. */
  source: string;
}

const SLU = 'https://hades.slu.se/lm';
const LM = '© Lantmäteriet, via SLU';

export const PRESETS: Record<string, Preset> = {
  'slu-ortofoto': { url: `${SLU}/ortofoto/wms/v1.3`, layers: 'Ortofoto_0.5', format: 'image/jpeg', source: LM },
  'slu-ortofoto-ir': { url: `${SLU}/ortofoto/wms/v1.3`, layers: 'Ortofoto_IR', format: 'image/jpeg', source: LM },
  'slu-ortofoto-1960': { url: `${SLU}/historiska-ortofoton/wms/v1`, layers: 'OI.Histortho_60', format: 'image/jpeg', source: LM },
  'slu-ortofoto-1975': { url: `${SLU}/historiska-ortofoton/wms/v1`, layers: 'OI.Histortho_75', format: 'image/jpeg', source: LM },
  'slu-topowebb': { url: `${SLU}/topowebb/wms/v1`, layers: 'topowebbkartan', source: LM },
  'slu-topowebb-grey': { url: `${SLU}/topowebb/wms/v1`, layers: 'topowebbkartan_nedtonad', source: LM },
  'slu-hillshade': { url: `${SLU}/hojdmodell/wms/v1.1`, layers: 'terrangskuggning', source: LM },
  'slu-slope': { url: `${SLU}/hojdmodell/wms/v1.1`, layers: 'terranglutning', source: LM },
  'slu-property': { url: `${SLU}/fastighet/wms/v1.1`, layers: 'granser,text', source: LM },
  'slu-water': { url: `${SLU}/inspire/hy/wms/v1`, layers: 'HY.PhysicalWaters.Waterbodies,HY.Network', source: LM },
};

/** What the layer asks the host for: a built-in map, or the address and layers given by hand. */
export function resolve(params: { map?: string; url: string; layers: string; styles: string; source: string; signin?: string }): {
  url: string;
  layers: string;
  styles: string;
  format?: string;
  source: string;
  signin?: string;
} {
  const preset = params.map ? PRESETS[params.map] : undefined;
  if (!preset) return { url: params.url, layers: params.layers, styles: params.styles, source: params.source, signin: params.signin };
  // A built-in map is open: no sign-in, and its own credit unless the author wrote one.
  return { url: preset.url, layers: preset.layers, styles: preset.styles ?? '', format: preset.format, source: params.source.trim() || preset.source };
}
