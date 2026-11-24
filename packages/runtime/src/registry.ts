import * as sdk from '@mrstudio/sdk';
import { LAYER_API, type LayerManifest, type LayerModule } from '@mrstudio/sdk';

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
const core = new Set(modules.keys());

/**
 * The SDK a site layer's module uses (#277). `mrstudio layer build` turns every
 * `import … from '@mrstudio/sdk'` into a read of this global, so a site layer runs against the
 * SDK of the app it is loaded in, never a copy of its own.
 */
declare global {
  // eslint-disable-next-line no-var
  var MRStudio: { api: number; sdk: typeof sdk } | undefined;
}
globalThis.MRStudio = { api: LAYER_API, sdk };

/** The code for a layer id, if this build includes it or it was loaded from the site. */
export function layerModule(id: string): LayerModule | undefined {
  return modules.get(id);
}

/** Where each site layer's module was loaded from, so a rebuilt one (a new address) loads again. */
const loaded = new Map<string, string>();

/**
 * Imports the code of the site's own layers (#277): every manifest with a `module` address.
 * Call it before layers start, and again when the catalogue changes. A module that fails to load
 * is reported and left out; the layer then draws nothing, as a layer missing from the build does.
 */
export async function loadSiteModules(manifests: readonly LayerManifest[]): Promise<void> {
  const wanted = manifests.filter((m) => m.module && !core.has(m.id) && loaded.get(m.id) !== m.module);
  await Promise.all(
    wanted.map(async (manifest) => {
      try {
        const imported = (await import(/* @vite-ignore */ manifest.module!)) as { default?: LayerModule };
        const layer = imported.default;
        if (!layer?.manifest?.id) throw new Error('it does not default-export a layer (defineLayer)');
        if (layer.manifest.id !== manifest.id) throw new Error(`its code is for '${layer.manifest.id}'`);
        if (layer.manifest.api !== LAYER_API) throw new Error(`it was built for layer api ${layer.manifest.api}, this app runs ${LAYER_API}`);
        modules.set(manifest.id, layer);
        loaded.set(manifest.id, manifest.module!);
      } catch (error) {
        console.error(`site layer '${manifest.id}' could not be loaded from ${manifest.module}:`, error);
      }
    }),
  );
}
