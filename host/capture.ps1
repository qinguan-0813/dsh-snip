# dsh-screenshot capture helper (ASCII-only on purpose: Windows PowerShell 5.1 reads
# a BOM-less .ps1 as ANSI, so any non-ASCII literal here would be mangled).
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File capture.ps1 `
#       -Out <png path> -Hide 1 -Screen window
#
# Prints exactly one ASCII line on stdout:
#   OK <width> <height> <x> <y> <hidden>
#   ERR <message>
#
# Exit code 0 on OK, 1 on ERR.

param(
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Hide = 0,
    [string]$Screen = 'window'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace DshShot -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@

$SW_HIDE = 0
$SW_SHOW = 5

function Get-DshTargetWindow {
    # "Current window" = the foreground window when it belongs to the DSH process,
    # otherwise the DSH process's own main window.
    $fg = [DshShot.Win]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero) {
        $fgPid = [uint32]0
        [void][DshShot.Win]::GetWindowThreadProcessId($fg, [ref]$fgPid)
        $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'DeepSeek Harness') { return $fg }
    }
    $main = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($main) { return $main.MainWindowHandle }
    return [IntPtr]::Zero
}

function Get-DshRect($target, [string]$mode) {
    if ($mode -eq 'all') {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        return @{ X = $vs.X; Y = $vs.Y; W = $vs.Width; H = $vs.Height }
    }
    $b = $null
    if ($mode -eq 'primary' -or $target -eq [IntPtr]::Zero) {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    } else {
        $b = [System.Windows.Forms.Screen]::FromHandle($target).Bounds
    }
    return @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height }
}

try {
    # Physical pixels: without this the desktop is virtualized by the display scale
    # factor and the PNG comes out smaller and blurry.
    [void][DshShot.Win]::SetProcessDPIAware()

    $target = Get-DshTargetWindow
    $rect = Get-DshRect $target $Screen
    $hidden = 0

    $bmp = New-Object System.Drawing.Bitmap($rect.W, $rect.H)
    $g = $null
    try {
        if ($Hide -eq 1 -and $target -ne [IntPtr]::Zero -and [DshShot.Win]::IsWindowVisible($target)) {
            [void][DshShot.Win]::ShowWindow($target, $SW_HIDE)
            $hidden = 1
            # Give the compositor a moment to repaint what was underneath the window.
            Start-Sleep -Milliseconds 260
        }
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($rect.X, $rect.Y, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally {
        # Never leave the DSH window hidden, even when the capture itself failed.
        if ($hidden -eq 1) {
            [void][DshShot.Win]::ShowWindow($target, $SW_SHOW)
            [void][DshShot.Win]::BringWindowToTop($target)
            [void][DshShot.Win]::SetForegroundWindow($target)
        }
        if ($g -ne $null) { $g.Dispose() }
    }

    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Output ("OK {0} {1} {2} {3} {4}" -f $rect.W, $rect.H, $rect.X, $rect.Y, $hidden)
    exit 0
} catch {
    $msg = $_.Exception.Message -replace '[\r\n]+', ' '
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
    Write-Output ("ERR {0}" -f $msg)
    exit 1
}
