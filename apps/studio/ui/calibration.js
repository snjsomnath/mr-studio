// The Calibration tab. The tool itself runs on the table surface, where the person can see
// the projector's light on the model; this tab opens and closes it and shows what is saved.
(() => {
  async function loadCalibration() {
    try {
      const state = await invoke('calibration_state');
      const saved = state.projector;
      let status;
      if (!state.site) status = 'Nothing is running. Start a site on the Setup tab first.';
      else if (!saved) status = `${state.site} is not calibrated. The table is shown flat.`;
      else {
        const when = saved.saved_at ? ` on ${new Date(saved.saved_at).toLocaleString()}` : '';
        const error = typeof saved.error_px === 'number' ? `, average error ${saved.error_px.toFixed(1)} px` : '';
        status = `${state.site} was calibrated${when}${error}.`;
      }
      $('calibration-status').textContent = status;
      $('calibration-start').textContent = saved ? 'Calibrate again on the table' : 'Start calibrating on the table';
      $('calibration-start').disabled = $('calibration-stop').disabled = !state.table;
      $('calibration-clear').disabled = !saved;
      $('calibration-hint').textContent = state.site && !state.table ? 'No window is showing the table. Give a display the table on the Setup tab and start.' : '';
    } catch (e) {
      showError(String(e));
    }
  }
  window.loadCalibration = loadCalibration;

  const run = (command, args) => async () => {
    showError();
    try {
      await invoke(command, args);
    } catch (e) {
      showError(String(e));
    }
    await loadCalibration();
  };
  $('calibration-start').addEventListener('click', run('calibration_mode', { active: true }));
  $('calibration-stop').addEventListener('click', run('calibration_mode', { active: false }));
  $('calibration-clear').addEventListener('click', run('calibration_clear'));
  // Saving happens on the table; pick it up when the person comes back to this window.
  window.addEventListener('focus', () => !$('tab-calibration').hidden && loadCalibration());
})();
