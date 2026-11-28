// Written by scripts/app-commands.mjs from apps/studio/src-tauri/build.rs (#544). Do not edit.
// The app's own pages call these through window.__TAURI__.core.invoke.

/** A command the app answers, as build.rs permits and main.rs registers it. */
type AppCommand =
  | 'launcher_state'
  | 'add_site'
  | 'remove_site'
  | 'delete_table'
  | 'duplicate_table'
  | 'import_table'
  | 'take_opened_file'
  | 'update_waiting_now'
  | 'starter_pack'
  | 'identify'
  | 'start'
  | 'open_site'
  | 'open_site_read_only'
  | 'create_site'
  | 'present'
  | 'stop_presenting'
  | 'presenting_state'
  | 'save_displays'
  | 'save_settings'
  | 'open_home'
  | 'open_settings'
  | 'open_view'
  | 'new_table'
  | 'quit'
  | 'colour_state'
  | 'set_colour'
  | 'save_preset'
  | 'delete_preset'
  | 'test_card'
  | 'set_layer_intensity'
  | 'calibration_state'
  | 'calibration_mode'
  | 'calibration_clear'
  | 'update_state'
  | 'check_updates'
  | 'set_update_check'
  | 'install_update'
  | 'dismiss_whats_new'
  | 'open_link'
  | 'file_action'
  | 'table_details'
  | 'recordings_list'
  | 'recording_update'
  | 'recording_delete'
  | 'recording_reveal'
  | 'recording_open'
  | 'open_sources'
  | 'cli_state'
  | 'install_cli'
  | 'remove_cli'
  | 'sources_page'
  | 'sources_save'
  | 'sources_remove'
  | 'sources_test'
  | 'open_operator_log'
  | 'diagnostics_report'
  | 'save_diagnostics'
  | 'open_operator'
  | 'operator_state'
  | 'operator_present'
  | 'operator_restart_screens'
  | 'operator_set_pin'
  | 'operator_exit'
  | 'operator_password'
  | 'set_operator_start';

interface Window {
  __TAURI__: {
    core: {
      invoke<T = any>(command: AppCommand, args?: Record<string, unknown>): Promise<T>;
    };
    event: {
      listen<T = any>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
    };
  };
}
