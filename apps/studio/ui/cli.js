// The Command line tab (#370): puts the mrstudio command that ships inside the app on this
// computer's PATH, or takes it off again. Commands in src-tauri/src/cli_tool.rs.
(() => {
  let busy = false;

  async function loadCli() {
    const state = await invoke('cli_state');
    const windows = state.os === 'windows';
    let status;
    let note = '';
    if (!state.bundled) {
      status = 'This copy of MR Studio has no mrstudio command beside it. The installed app has one.';
    } else if (state.installed) {
      status = windows ? `Installed. ${state.target} is on your PATH, so new terminals find mrstudio.` : `Installed. ${state.target} points at the command inside this app, and follows it through updates.`;
      note = windows ? 'Open a new terminal and type mrstudio --help. Terminals that were open before do not see it yet.' : 'Open a new Terminal window and type mrstudio --help.';
    } else {
      status = windows ? 'Not installed. Install adds the MR Studio folder to your PATH; it needs no administrator.' : `Not installed. Install makes a link at ${state.target}.`;
      if (state.other) status += ` Right now ${state.other}; Install replaces it.`;
      if (state.found) note = `Another mrstudio is already on the PATH: ${state.found}.`;
      else if (state.needs_admin) note = 'macOS asks for your password once, because that folder belongs to the system.';
    }
    $('cli-status').textContent = status;
    $('cli-note').textContent = note;
    $('cli-install').hidden = !state.bundled || state.installed;
    $('cli-install').disabled = busy;
    $('cli-remove').hidden = !state.installed;
    $('cli-remove').disabled = busy;
  }
  window.loadCli = () => loadCli().catch((e) => showError(String(e)));

  async function run(command) {
    showError();
    busy = true;
    window.loadCli();
    try {
      await invoke(command);
    } catch (e) {
      showError(String(e));
    }
    busy = false;
    window.loadCli();
  }
  $('cli-install').addEventListener('click', () => run('install_cli'));
  $('cli-remove').addEventListener('click', () => run('remove_cli'));
})();
