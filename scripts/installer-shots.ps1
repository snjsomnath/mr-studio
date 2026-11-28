# Pictures of the Windows setup pages (#695), taken on the CI runner from the installer that was
# just built: Welcome, the slideshow while the files copy, and Finish. It clicks Next itself, so
# it installs the app for the runner's user. Saved as PNGs in the given folder.
#   pwsh scripts/installer-shots.ps1 -Setup path\to\MR-Studio-setup.exe -Out installer-pages
param([Parameter(Mandatory)][string]$Setup, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
}
'@
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Shot([IntPtr]$hwnd, [string]$name) {
  $r = New-Object Win+RECT
  [Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  [Win]::PrintWindow($hwnd, $dc, 2) | Out-Null # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($dc)
  $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Saved $name.png"
}
function Next([IntPtr]$hwnd) {
  $button = [Win]::GetDlgItem($hwnd, 1)
  [Win]::PostMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null # BM_CLICK
}
function WaitFor([scriptblock]$ready, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) { if (& $ready) { return $true }; Start-Sleep -Milliseconds 200 }
  return $false
}

$p = Start-Process -FilePath $Setup -PassThru
$hwnd = [IntPtr]::Zero
WaitFor { $p.Refresh(); $script:hwnd = $p.MainWindowHandle; $script:hwnd -ne [IntPtr]::Zero } 60 | Out-Null
if ($hwnd -eq [IntPtr]::Zero) { throw 'The setup window did not open.' }
Write-Host "Setup window at $([Win]::GetDpiForWindow($hwnd)) dpi"
Start-Sleep -Seconds 2
Shot $hwnd '1-welcome'

Next $hwnd; Start-Sleep -Seconds 2
Shot $hwnd '2-folder'
Next $hwnd

# The progress page: a few pictures while the files copy, then the finished page (Next enabled).
for ($i = 1; $i -le 4; $i++) { Start-Sleep -Milliseconds 900; Shot $hwnd "3-installing-$i" }
$next = [Win]::GetDlgItem($hwnd, 1)
WaitFor { [Win]::IsWindowEnabled($next) } 180 | Out-Null
Start-Sleep -Seconds 3
Shot $hwnd '4-installed'
Start-Sleep -Seconds 3
Shot $hwnd '4-installed-later'

Next $hwnd; Start-Sleep -Seconds 2
Shot $hwnd '5-finish'
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue

# TEMPORARY (#695): print the pictures into the log, for a reviewer who can't download artifacts.
Get-ChildItem $Out -Filter *.png | ForEach-Object {
  Write-Host "MRS-SHOT-BEGIN $($_.Name)"
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
  for ($i = 0; $i -lt $b64.Length; $i += 8000) { Write-Host ("MRS-B64 " + $b64.Substring($i, [Math]::Min(8000, $b64.Length - $i))) }
  Write-Host "MRS-SHOT-END $($_.Name)"
}
