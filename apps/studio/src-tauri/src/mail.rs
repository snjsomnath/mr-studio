//! Share by email (#372): a new message in the computer's own mail app with a table file
//! already attached.
//!
//! A `mailto:` link cannot carry a file, so each system's own way is used:
//! - macOS: the share service "Compose Email", which opens the default mail app (Mail,
//!   Outlook...). Outlook may offer to send a large file as a OneDrive link; that is its call.
//! - Windows: Simple MAPI `MAPISendMailW`, which the default desktop mail app answers
//!   (Outlook, Thunderbird...). The new Outlook and the Mail app do not answer MAPI.
//! - Linux: `xdg-email --attach`.
//!
//! When that fails, the caller shows the file in the file manager and opens a `mailto:` with the
//! subject and text filled in, so the person drags the file into the message.

use std::path::Path;

/// The text of the message.
pub struct Letter {
    pub subject: String,
    pub body: String,
}

/// What the table's author sends with the file: what it is and how to open it.
pub fn letter(name: &str) -> Letter {
    Letter {
        subject: format!("MR Studio table: {name}"),
        body: format!(
            "Here is the MR Studio table \u{201c}{name}\u{201d}.\n\n\
             To open it, double-click the attached file on a computer with MR Studio, or choose Open a table file on MR Studio's Home. \
             If this table is already there, MR Studio offers to update it and keeps that computer's own calibration.\n\n\
             Keys for outside services are not in the file. MR Studio says which ones to set up.\n\n\
             MR Studio: https://github.com/snjsomnath/mr-studio/releases\n"
        ),
    }
}

/// What goes with a starter pack (#450): what it is and where to start.
pub fn starter_letter(name: &str) -> Letter {
    Letter {
        subject: format!("MR Studio starter pack: {name}"),
        body: format!(
            "Here is a starter pack for the MR Studio table \u{201c}{name}\u{201d}: its outline, tiles, buildings and streets, \
             ready to draw on in QGIS, Illustrator, Photoshop or PowerPoint.\n\n\
             Unzip it and open README.md first. It says how to use the files in each program, and how to bring what you make back into the table.\n\n\
             MR Studio: https://github.com/snjsomnath/mr-studio/releases\n"
        ),
    }
}

/// A `mailto:` link with the subject and text filled in, for when nothing can attach the file.
pub fn mailto(letter: &Letter) -> String {
    format!("mailto:?subject={}&body={}", encode(&letter.subject), encode(&letter.body))
}

/// Percent-encodes everything but the characters RFC 3986 leaves unreserved.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Opens a new message with `file` attached in the default mail app. Must be called on the
/// main thread on macOS. `Err` says why it could not, and the caller falls back.
#[cfg(target_os = "macos")]
pub fn compose(file: &Path, letter: &Letter) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSSharingService, NSSharingServiceNameComposeEmail};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let path = file.to_str().ok_or("the file's path is not text")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let body = NSString::from_str(&letter.body);
    // SAFETY: the name is a constant AppKit exports.
    let service = NSSharingService::sharingServiceNamed(unsafe { NSSharingServiceNameComposeEmail })
        .ok_or("this Mac has no Compose Email service")?;
    service.setSubject(Some(&NSString::from_str(&letter.subject)));
    let items: Vec<Retained<AnyObject>> =
        vec![Retained::into_super(Retained::into_super(body)), Retained::into_super(Retained::into_super(url))];
    let items = NSArray::from_retained_slice(&items);
    // SAFETY: the items are an NSString and a file NSURL, both NSPasteboardWriting.
    unsafe {
        if !service.canPerformWithItems(Some(&items)) {
            return Err("no mail app is set up on this Mac".into());
        }
        service.performWithItems(&items);
    }
    Ok(())
}

#[cfg(windows)]
pub fn compose(file: &Path, letter: &Letter) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Mapi::{MapiFileDescW, MapiMessageW, MAPI_DIALOG, MAPI_E_USER_ABORT, MAPI_LOGON_UI, SUCCESS_SUCCESS};

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }
    let mut path = wide(file.as_os_str());
    let mut name = wide(file.file_name().unwrap_or_default());
    let mut subject = wide(std::ffi::OsStr::new(&letter.subject));
    // MAPI clients expect Windows line ends in the text.
    let mut body = wide(std::ffi::OsStr::new(&letter.body.replace('\n', "\r\n")));
    let mut attachment =
        MapiFileDescW { nPosition: u32::MAX, lpszPathName: path.as_mut_ptr(), lpszFileName: name.as_mut_ptr(), ..Default::default() };
    let message = MapiMessageW {
        lpszSubject: subject.as_mut_ptr(),
        lpszNoteText: body.as_mut_ptr(),
        nFileCount: 1,
        lpFiles: &mut attachment,
        ..Default::default()
    };
    let library: Vec<u16> = "mapi32.dll\0".encode_utf16().collect();
    // SAFETY: plain Win32 calls with NUL-terminated strings that outlive the call; the function
    // pointer is MAPISendMailW's documented signature.
    unsafe {
        let module = LoadLibraryW(library.as_ptr());
        if module.is_null() {
            return Err("this computer has no MAPI mail app".into());
        }
        let Some(address) = GetProcAddress(module, c"MAPISendMailW".as_ptr().cast()) else {
            return Err("the mail app does not take files from other apps".into());
        };
        type SendMail = unsafe extern "system" fn(usize, usize, *const MapiMessageW, u32, u32) -> u32;
        let send = std::mem::transmute::<unsafe extern "system" fn() -> isize, SendMail>(address);
        let code = send(0, 0, &message, MAPI_DIALOG | MAPI_LOGON_UI, 0);
        match code {
            SUCCESS_SUCCESS | MAPI_E_USER_ABORT => Ok(()),
            other => Err(format!("the mail app answered MAPI error {other}")),
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn compose(file: &Path, letter: &Letter) -> Result<(), String> {
    let status = std::process::Command::new("xdg-email")
        .arg("--subject")
        .arg(&letter.subject)
        .arg("--body")
        .arg(&letter.body)
        .arg("--attach")
        .arg(file)
        .status()
        .map_err(|e| format!("xdg-email could not start ({e})"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdg-email failed ({status})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_link_carries_the_subject_and_text() {
        let link = mailto(&letter("Lindholmen & co"));
        assert!(link.starts_with("mailto:?subject=MR%20Studio%20table%3A%20Lindholmen%20%26%20co&body="));
        assert!(!link.contains(' ') && !link.contains('\n'));
        assert!(link.contains("%E2%80%9CLindholmen%20%26%20co%E2%80%9D"));
    }
}
