# Self-test for host/capture.ps1  (ASCII only on purpose: Windows PowerShell 5.1 reads a
# BOM-less .ps1 as ANSI, so any non-ASCII literal in this file would break the parser --
# and a non-ASCII literal is exactly what a Chinese user name in a hardcoded path is.
# That is why every path below is *derived*, never typed.)
#
# It checks three things and prints PASS/FAIL for each:
#   1. Hide=0  -> an image comes out
#   2. Hide=1  -> an image comes out, and the DSH window is NOT in it (pixel probe)
#   3. the window rect and its maximized state are IDENTICAL before and after.
#      This is the regression that a certain other screenshot plugin shipped:
#      restoring with SW_RESTORE un-maximizes the window, so every capture kicked
#      the user out of fullscreen. This script is the guard against that.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\selftest-capture.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace T -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

# ..\host\capture.ps1, relative to this script -- no hardcoded user name anywhere.
$script = (Resolve-Path (Join-Path $PSScriptRoot '..\host\capture.ps1')).Path
$dir = Join-Path $env:TEMP 'dsh-snip-selftest'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Get-Own {
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { return $null }
  $r = New-Object T.W+RECT
  [void][T.W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  return [pscustomobject]@{
    Hwnd    = [int64]$p.MainWindowHandle
    Rect    = "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
    Zoomed  = [T.W]::IsZoomed($p.MainWindowHandle)
    Visible = [T.W]::IsWindowVisible($p.MainWindowHandle)
  }
}

function Sample-Pixel([string]$png, [int]$x, [int]$y) {
  $b = [System.Drawing.Bitmap]::FromFile($png)
  $c = $b.GetPixel($x, $y)
  $b.Dispose()
  return "$($c.R),$($c.G),$($c.B)"
}

# One pixel proves nothing: whatever sits behind the window can be the same colour by
# coincidence (a light-grey browser page, say). Sample a grid instead and count how many
# points actually changed between the keep-run and the hide-run.
function Compare-Images([string]$a, [string]$b) {
  $ia = [System.Drawing.Bitmap]::FromFile($a)
  $ib = [System.Drawing.Bitmap]::FromFile($b)
  $w = [Math]::Min($ia.Width, $ib.Width); $h = [Math]::Min($ia.Height, $ib.Height)
  $diff = 0; $total = 0
  for ($i = 1; $i -le 10; $i++) {
    for ($j = 1; $j -le 10; $j++) {
      $x = [int]($w * $i / 11); $y = [int]($h * $j / 11)
      $ca = $ia.GetPixel($x, $y); $cb = $ib.GetPixel($x, $y)
      $total++
      if (([Math]::Abs($ca.R - $cb.R) + [Math]::Abs($ca.G - $cb.G) + [Math]::Abs($ca.B - $cb.B)) -gt 12) { $diff++ }
    }
  }
  $ia.Dispose(); $ib.Dispose()
  return @{ diff = $diff; total = $total }
}

Write-Host "script under test: $script"
$before = Get-Own
if ($before -eq $null) { Write-Host 'SKIP: no DeepSeek Harness window found (is the app running?)'; exit 0 }
Write-Host "BEFORE: $($before | ConvertTo-Json -Compress)"
$failed = 0

# Precondition for the "did hiding change the screen?" check: DSH has to be the window on
# top. If something else covers it, hiding DSH is a visual no-op and that check simply
# cannot conclude anything -- say so instead of calling it a failure.
$fg = [T.W]::GetForegroundWindow()
$fgPid = [uint32]0
if ($fg -ne [IntPtr]::Zero) { [void][T.W]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
$fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
$ownWasFront = ($fgProc -ne $null -and $fgProc.ProcessName -eq 'DeepSeek Harness')
Write-Host "front window belongs to: $(if ($fgProc) { $fgProc.ProcessName } else { '?' })  ->  screen-change check is $(if ($ownWasFront) { 'MEANINGFUL' } else { 'INCONCLUSIVE (bring DSH to the front and rerun to make it meaningful)' })"

# Probe a pixel that is definitely inside the DSH window's own rectangle: 40px in from its
# left edge, mid height. Assumes the capture monitor's origin is (0,0), which holds for a
# single-monitor desktop and for the primary monitor otherwise.
$r = ($before.Rect -split ',') | ForEach-Object { [int]$_ }
$probeX = [Math]::Max(0, $r[0] + 40)
$probeY = [Math]::Max(0, [int](($r[1] + $r[3]) / 2))
Write-Host "pixel probe inside the window: ($probeX, $probeY)"
$probeKeep = $null

foreach ($hide in 0, 1) {
  $out = Join-Path $dir "test-hide$hide.png"
  Remove-Item $out -ErrorAction SilentlyContinue
  $t0 = Get-Date
  $line = & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Out $out -Hide $hide -Screen window
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  Write-Host ''
  Write-Host "--- Hide=$hide   stdout: $line   ($ms ms incl. process start) ---"
  if (-not (Test-Path $out)) { Write-Host '  FAIL: no file produced'; $failed++; continue }
  $fi = Get-Item $out
  $bmp = [System.Drawing.Bitmap]::FromFile($out)
  $w = $bmp.Width; $h = $bmp.Height
  $bmp.Dispose()
  Write-Host ("  image: {0}x{1}  {2} KB" -f $w, $h, [int]($fi.Length / 1KB))
  $px = Sample-Pixel $out ([Math]::Min($probeX, $w - 1)) ([Math]::Min($probeY, $h - 1))
  Write-Host ("  pixel at the probe = {0}" -f $px)
  if ($hide -eq 0) { $probeKeep = $px }
  $after = Get-Own
  Write-Host ("  AFTER: {0}" -f ($after | ConvertTo-Json -Compress))
  if ($before.Rect -eq $after.Rect -and $before.Zoomed -eq $after.Zoomed) {
    Write-Host '  PASS: window rect and maximized state unchanged'
  } else {
    Write-Host "  FAIL: window state changed!  before=$($before.Rect)/zoom=$($before.Zoomed)  after=$($after.Rect)/zoom=$($after.Zoomed)"
    $failed++
  }
}

Write-Host ''
$keepPng = Join-Path $dir 'test-hide0.png'
$hidePng = Join-Path $dir 'test-hide1.png'
if ((Test-Path $keepPng) -and (Test-Path $hidePng)) {
  $cmp = Compare-Images $keepPng $hidePng
  Write-Host ("grid sample: {0}/{1} points differ between the keep-run and the hide-run" -f $cmp.diff, $cmp.total)
  if (-not $ownWasFront) {
    Write-Host '  INCONCLUSIVE: DSH was not the front window, so hiding it need not change the'
    Write-Host '                screen at all. Bring DSH to the front and rerun for a real answer.'
  } elseif ($cmp.diff -ge [int]($cmp.total * 0.2)) {
    Write-Host '  OK: the two captures differ substantially, so hiding really did change the screen'
  } else {
    Write-Host '  WARN: the two captures are nearly identical -- hiding may not have taken effect'
    $failed++
  }
}

Write-Host ''
if ($failed -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$failed CHECK(S) FAILED"; exit 1 }
