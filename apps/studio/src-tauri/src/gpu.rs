//! The fast graphics chip on Windows laptops with two (#652).
//!
//! A laptop with Intel graphics for its own panel and an NVIDIA chip for the outputs (the studio
//! PC: Intel UHD, Quadro RTX 3000 driving the projector and the TV) lets Windows draw a program
//! on the power-saving chip unless told otherwise. The app's windows are WebView2 pages: drawn
//! on the Intel chip and copied to the NVIDIA outputs, they flicker black. Two things tell
//! Windows to use the fast chip, both before the first window opens:
//! - the per-program graphics preference that Settings › Display › Graphics writes
//!   (`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, `GpuPreference=2;` under the
//!   program's path), set only when the person has not chosen one themselves;
//! - Chromium's `--force_high_performance_gpu` for the WebView2 browser processes, which are
//!   programs of their own the preference above does not reach.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    RRF_RT_REG_SZ,
};

const PREFERENCES: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
const HIGH_PERFORMANCE: &str = "GpuPreference=2;";
/// What Tauri passes WebView2 by default; the variable replaces it, so it is kept. Also: windows on
/// a second screen are never taken for covered (`CalculateNativeWinOcclusion`), which stops their
/// frames and timers, so a controller on the TV stops answering (#655).
const TAURI_DEFAULTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

fn wide(text: &str) -> Vec<u16> {
    std::ffi::OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// Asks for the fast chip, once, before any window opens. Failing is not fatal: it is logged.
pub fn prefer_fast_gpu() {
    let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if !args.contains("--force_high_performance_gpu") {
        if args.is_empty() {
            args = TAURI_DEFAULTS.to_string();
        }
        args.push_str(" --force_high_performance_gpu");
        // SAFETY: called at the start of main, before any other thread exists.
        unsafe { std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args.trim()) };
    }
    match std::env::current_exe() {
        Ok(exe) => {
            if let Err(e) = set_preference(&exe) {
                tracing::warn!("could not ask Windows for the fast graphics chip: {e}");
            }
        }
        Err(e) => tracing::warn!("could not find this program's path for the graphics preference: {e}"),
    }
}

/// Writes `GpuPreference=2;` for `exe`, unless a preference for it is already there.
fn set_preference(exe: &Path) -> Result<(), String> {
    let key = wide(PREFERENCES);
    let name = wide(&exe.display().to_string());
    let mut size = 0u32;
    // SAFETY: the key and value names are NUL-terminated UTF-16; a null buffer asks for the size only.
    let found = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if found == ERROR_SUCCESS {
        return Ok(());
    }
    let data = wide(HIGH_PERFORMANCE);
    let mut handle: HKEY = std::ptr::null_mut();
    // SAFETY: NUL-terminated UTF-16 names; the key is created if Windows has none yet, and closed below.
    let opened = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut handle,
            std::ptr::null_mut(),
        )
    };
    if opened != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyExW failed with {opened}"));
    }
    // SAFETY: `data` holds `data.len()` UTF-16 units including the NUL.
    let status = unsafe { RegSetValueExW(handle, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32) };
    // SAFETY: `handle` was opened above.
    unsafe { RegCloseKey(handle) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("RegSetValueExW failed with {status}"))
    }
}
