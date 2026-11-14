import type { Connection, ProjectorCalibration, Role } from '@mrstudio/sdk';

import type { TableView } from '../table.ts';
import { CalibrationTool } from './calibrate.ts';

/**
 * Turns the model surface on for a table view: loads the twin, follows the host's projector
 * calibration, and makes the calibration tool reachable. The tool opens with `?calibrate` in
 * the address, with Shift+C on the surface, or when a controller sends `calibration.mode`.
 */
export async function installModel(view: TableView, connection: Connection, role: Role): Promise<void> {
  const model = await view.attachModel();
  if (!model) return;
  // The projected table uses the calibration. The dev surface is a flat preview unless asked otherwise.
  const query = new URLSearchParams(location.search);
  const follow = role === 'table' || query.has('projector');
  const load = async () => {
    const result = await connection.request<{ projector: ProjectorCalibration | null }>('calibration.get').catch(() => ({ projector: null }));
    model.setCalibration(result.projector, follow);
  };
  await load();
  connection.on('calibration', (p: { projector: ProjectorCalibration | null }) => model.setCalibration(p.projector, follow));
  connection.on('welcome', () => void load());

  const tool = new CalibrationTool(view.container, model, connection, view.site, role === 'table');
  connection.on('calibration.mode', (p: { active: boolean }) => (p.active ? tool.open() : tool.close()));
  if (query.has('calibrate')) tool.open();
  window.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
    if (event.key === 'C' && event.shiftKey && !event.ctrlKey && !event.metaKey && !typing) tool.toggle();
  });
}
