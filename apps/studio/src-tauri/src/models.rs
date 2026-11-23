//! The make and model of each display on Windows, where the system name of a display is
//! `\\.\DISPLAY1` and says nothing about what is plugged in (#188).

use std::mem::{size_of, zeroed};
use windows_sys::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;

fn text(wide: &[u16]) -> String {
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end]).trim().to_string()
}

/// Each active display's system name (`\\.\DISPLAY1`, what Tauri reports) with the
/// model name its EDID gives (`EPSON PJ`), which is what people recognise.
pub fn models() -> Vec<(String, String)> {
    // SAFETY: the buffers are sized as Windows asks and every struct is plain data.
    unsafe {
        let (mut path_count, mut mode_count) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count) != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![zeroed(); path_count as usize];
        let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![zeroed(); mode_count as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            std::ptr::null_mut(),
        ) != ERROR_SUCCESS
        {
            return Vec::new();
        }
        paths.truncate(path_count as usize);
        paths
            .iter()
            .filter_map(|path| {
                let mut source: DISPLAYCONFIG_SOURCE_DEVICE_NAME = zeroed();
                source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
                source.header.size = size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
                source.header.adapterId = path.sourceInfo.adapterId;
                source.header.id = path.sourceInfo.id;
                if DisplayConfigGetDeviceInfo(&mut source.header) != 0 {
                    return None;
                }
                let mut target: DISPLAYCONFIG_TARGET_DEVICE_NAME = zeroed();
                target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
                target.header.size = size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
                target.header.adapterId = path.targetInfo.adapterId;
                target.header.id = path.targetInfo.id;
                if DisplayConfigGetDeviceInfo(&mut target.header) != 0 {
                    return None;
                }
                let model = text(&target.monitorFriendlyDeviceName);
                (!model.is_empty()).then(|| (text(&source.viewGdiDeviceName), model))
            })
            .collect()
    }
}
