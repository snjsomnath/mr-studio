import { setSessionSound } from '@mrstudio/sdk';
import type { Connection, LayerManifest, LayerState, Participant, SessionState, TvConfig, Welcome, DisplayQuality } from '@mrstudio/sdk';

type LayerListener = (layer: string, state: LayerState, previous: LayerState | undefined) => void;

/** The surface's copy of the session state. It only changes when the host says so. */
export class Store {
  state: SessionState;
  manifests: LayerManifest[];
  surface: number;
  /** A phone that joined a full table (#462): it looks, and joins again for a seat when one frees up. */
  watching: boolean;
  /** Puts a manifest in the visitors' language (#80). Unset: as written, in English. */
  private translate: ((manifest: LayerManifest) => LayerManifest) | null = null;
  private translated = new WeakMap<LayerManifest, LayerManifest>();
  private layerListeners = new Set<LayerListener>();
  private participantListeners = new Set<(participants: Participant[]) => void>();
  private sceneListeners = new Set<(scene: string[]) => void>();
  private removedListeners = new Set<(layer: string) => void>();
  private tvListeners = new Set<(tv: TvConfig | null) => void>();
  private displayListeners = new Set<(quality: DisplayQuality) => void>();
  private catalogListeners = new Set<(layer: string) => void>();
  private settingsListeners = new Set<() => void>();

  constructor(connection: Connection, welcome: Welcome) {
    this.state = welcome.state;
    this.manifests = welcome.manifests;
    this.surface = welcome.surface;
    this.watching = welcome.watching === true;
    connection.on('state.layer', (p: { layer: string; state: LayerState }) => this.setLayer(p.layer, p.state));
    connection.on('state.scene', (p: { scene: string[]; layers: Record<string, LayerState> }) => this.setScene(p.scene, p.layers));
    connection.on('state.participants', (p: { participants: Participant[] }) => {
      this.state.participants = p.participants;
      for (const listener of this.participantListeners) listener(p.participants);
    });
    // The controller's table settings changed (a theme picked in the setup guide).
    // Phones join somewhere else now: through the relay, or back on the local network (#89).
    setSessionSound(this.state.session?.sound !== false);
    connection.on('session.changed', (p: { session: SessionState['session'] }) => {
      this.state.session = p.session;
      setSessionSound(p.session?.sound !== false);
      for (const listener of this.participantListeners) listener(this.state.participants);
    });
    connection.on('site.tv', (p: { tv: TvConfig | null }) => {
      this.state.site.tv = p.tv;
      for (const listener of this.tvListeners) listener(p.tv);
    });
    // How the table renders changed (the quality on the editor's Display tab, #134).
    connection.on('site.display', (p: { display: SessionState['site']['display'] }) => {
      this.state.site = { ...this.state.site, display: p.display };
      for (const listener of this.displayListeners) listener(p.display?.quality ?? 'good');
    });
    // A custom layer was saved or removed (the layer builder), or the table's palette changed.
    connection.on('catalog.changed', (p: { manifest: LayerManifest }) => {
      const at = this.manifests.findIndex((m) => m.id === p.manifest.id);
      if (at >= 0) this.manifests[at] = p.manifest;
      else this.manifests.push(p.manifest);
      for (const listener of this.catalogListeners) listener(p.manifest.id);
    });
    connection.on('catalog.removed', (p: { id: string }) => {
      this.manifests = this.manifests.filter((m) => m.id !== p.id);
      for (const listener of this.catalogListeners) listener(p.id);
    });
    // The table's name, time zone or branding changed (Table settings, #73).
    connection.on('site.settings', (p: Pick<SessionState['site'], 'name' | 'timezone' | 'branding'>) => {
      this.state.site = { ...this.state.site, name: p.name, timezone: p.timezone, branding: p.branding };
      for (const listener of this.settingsListeners) listener();
    });
    connection.on('palette.changed', (p: { palette: SessionState['site']['palette'] }) => {
      this.state.site = { ...this.state.site, palette: p.palette };
      for (const listener of this.catalogListeners) listener('');
    });
    // After a reconnect or a resync, take the host's state wholesale.
    const replace = (message: Welcome) => {
      this.surface = message.surface ?? this.surface;
      this.state = { ...message.state, scene: this.state.scene, layers: this.state.layers };
      this.manifests = message.manifests ?? this.manifests;
      this.setScene(message.state.scene, message.state.layers);
      for (const listener of this.participantListeners) listener(this.state.participants);
    };
    connection.on('welcome', (message: Welcome) => message !== welcome && replace(message));
    connection.on('resync', replace);
  }

  layer(id: string): LayerState {
    const state = this.state.layers[id];
    if (!state) throw new Error(`unknown layer '${id}'`);
    return state;
  }

  /** This surface's own seat, when it is a phone. */
  me(): Participant | undefined {
    return this.state.participants.find((p) => p.surface === this.surface);
  }

  onLayer(listener: LayerListener): () => void {
    this.layerListeners.add(listener);
    return () => this.layerListeners.delete(listener);
  }

  /** Hands out manifests through `translate` from now on (#80); null for as written. */
  useTranslation(translate: ((manifest: LayerManifest) => LayerManifest) | null): void {
    this.translate = translate;
    this.translated = new WeakMap();
  }

  /** The catalogue entry for a layer package, in the visitors' language on their screens. */
  manifest(layer: string): LayerManifest | undefined {
    const manifest = this.manifests.find((manifest) => manifest.id === layer);
    if (!manifest || !this.translate) return manifest;
    let done = this.translated.get(manifest);
    if (!done) this.translated.set(manifest, (done = this.translate(manifest)));
    return done;
  }

  /**
   * Runs when a layer of the catalogue was saved, added or removed (by its id), or with
   * an empty id when the table's palette changed. Returns a function that stops it.
   */
  /** The table's name, time zone or branding changed. Returns a function that stops listening. */
  onSettings(listener: () => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  onCatalog(listener: (layer: string) => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  /** Runs after layers were added to, removed from or reordered in the scene. */
  onScene(listener: (scene: string[]) => void): () => void {
    this.sceneListeners.add(listener);
    return () => this.sceneListeners.delete(listener);
  }

  /** Runs when a layer left the scene, before `onScene`. */
  onRemoved(listener: (layer: string) => void): void {
    this.removedListeners.add(listener);
  }

  /** Runs when the site's `tv` settings change. */
  /** Called with the table's quality whenever it changes. */
  onDisplay(listener: (quality: DisplayQuality) => void): () => void {
    this.displayListeners.add(listener);
    return () => this.displayListeners.delete(listener);
  }

  onTv(listener: (tv: TvConfig | null) => void): () => void {
    this.tvListeners.add(listener);
    return () => this.tvListeners.delete(listener);
  }

  onParticipants(listener: (participants: Participant[]) => void): void {
    this.participantListeners.add(listener);
  }

  private setScene(scene: string[], layers: Record<string, LayerState>): void {
    for (const layer of Object.keys(this.state.layers)) {
      if (layer in layers) continue;
      delete this.state.layers[layer];
      for (const listener of this.removedListeners) listener(layer);
    }
    const reordered = JSON.stringify(scene) !== JSON.stringify(this.state.scene);
    this.state.scene = scene;
    for (const layer of scene) this.setLayer(layer, layers[layer]!);
    if (reordered) for (const listener of this.sceneListeners) listener(scene);
  }

  private setLayer(layer: string, state: LayerState): void {
    const previous = this.state.layers[layer];
    this.state.layers[layer] = state;
    for (const listener of this.layerListeners) listener(layer, state, previous);
  }
}

/** The keys whose values differ between two flat records. */
export function changedKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a?.[key]) !== JSON.stringify(b[key]));
}
