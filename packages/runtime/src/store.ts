import type { Connection, LayerManifest, LayerState, Participant, SessionState, Welcome } from '@mrstudio/sdk';

type LayerListener = (layer: string, state: LayerState, previous: LayerState | undefined) => void;

/** The surface's copy of the session state. It only changes when the host says so. */
export class Store {
  state: SessionState;
  manifests: LayerManifest[];
  surface: number;
  private layerListeners = new Set<LayerListener>();
  private participantListeners = new Set<(participants: Participant[]) => void>();
  private sceneListeners = new Set<(scene: string[]) => void>();
  private removedListeners = new Set<(layer: string) => void>();

  constructor(connection: Connection, welcome: Welcome) {
    this.state = welcome.state;
    this.manifests = welcome.manifests;
    this.surface = welcome.surface;
    connection.on('state.layer', (p: { layer: string; state: LayerState }) => this.setLayer(p.layer, p.state));
    connection.on('state.scene', (p: { scene: string[]; layers: Record<string, LayerState> }) => this.setScene(p.scene, p.layers));
    connection.on('state.participants', (p: { participants: Participant[] }) => {
      this.state.participants = p.participants;
      for (const listener of this.participantListeners) listener(p.participants);
    });
    // After a reconnect or a resync, take the host's state wholesale.
    const replace = (message: Welcome) => {
      this.surface = message.surface ?? this.surface;
      this.state = { ...message.state, scene: this.state.scene, layers: this.state.layers };
      this.setScene(message.state.scene, message.state.layers);
    };
    connection.on('welcome', (message: Welcome) => message !== welcome && replace(message));
    connection.on('resync', replace);
  }

  layer(id: string): LayerState {
    const state = this.state.layers[id];
    if (!state) throw new Error(`unknown layer '${id}'`);
    return state;
  }

  onLayer(listener: LayerListener): () => void {
    this.layerListeners.add(listener);
    return () => this.layerListeners.delete(listener);
  }

  /** The catalogue entry for a layer package. */
  manifest(layer: string): LayerManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === layer);
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
