import type { LayerModule } from '@mrstudio/sdk';

// Core layers are bundled with the runtime. Each package's default export is a LayerModule.
const found = import.meta.glob<{ default: LayerModule }>('../../layers/*/src/index.ts', { eager: true });

const modules = new Map<string, LayerModule>();
for (const [path, module] of Object.entries(found)) {
  const layer = module.default;
  if (!layer?.manifest?.id) {
    console.error(`${path} does not default-export a layer`);
    continue;
  }
  modules.set(layer.manifest.id, layer);
}

/** The code for a layer id, if this build includes it. */
export function layerModule(id: string): LayerModule | undefined {
  return modules.get(id);
}
