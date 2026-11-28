import { coreWidgets } from '@mrstudio/dashboard';
import * as sdk from '@mrstudio/sdk';
import { LAYER_API, type LayerManifest, type LayerModule, type PanelSpec } from '@mrstudio/sdk';
import { describe, reportError } from './diagnostics.ts';

// Core layers are bundled with the runtime. Each package's default export is a LayerModule.
// Vite fills in `import.meta.env` and the glob when it builds; under plain Node (the unit tests,
// #742) neither exists, so the modules that import this one load with no core layers.
const found: Record<string, { default: LayerModule }> = import.meta.env
  ? import.meta.glob<{ default: LayerModule }>('../../layers/*/src/index.ts', { eager: true })
  : {};

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
 * Every widget the site can draw: the core ones and each layer package's own (#353), as
 * `<layer>/<type>`. One registry for the controller, the TV pages and the table's ribbon.
 */
export const widgets = coreWidgets();
const reportWidgets = (layer: string, mod: LayerModule) => {
  for (const problem of widgets.registerTeam(layer, mod.widgets)) console.error(problem);
};
for (const [id, mod] of modules) reportWidgets(id, mod);

/** A layer's panels with its own widgets named in full (`flow-meter` becomes `energy/flow-meter`). */
export function withTeamWidgets(layer: string, specs: readonly PanelSpec[]): PanelSpec[] {
  return specs.map((spec) => {
    const found = widgets.find(spec.widget, layer);
    return found && found.type !== spec.widget ? { ...spec, widget: found.type } : spec;
  });
}

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

/** Why a site layer's code did not load, by layer id (#510). Gone once it loads. */
const problems = new Map<string, string>();

/** Why the code of the site layer `id` did not load, if it did not. */
export function siteModuleProblem(id: string): string | undefined {
  return problems.get(id);
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
        reportWidgets(manifest.id, layer);
        loaded.set(manifest.id, manifest.module!);
        problems.delete(manifest.id);
      } catch (error) {
        console.error(`site layer '${manifest.id}' could not be loaded from ${manifest.module}:`, error);
        // Said where people look (#510): the app's log, and the layer's own trouble when it is on.
        problems.set(manifest.id, describe(error));
        reportError(`the code of the layer '${manifest.id}' could not be loaded: ${describe(error)}`);
      }
    }),
  );
}
