# Builds the Windows app the way it is meant to ship: trimmed, self-contained, one file. Needs Windows and the
# .NET 10 SDK. It runs the app's self-test on the result and refuses to package it if the file is over the
# size limit (100 MB). Output: dist\Votive-win-x64.zip and its .sha256.
#
#   powershell -ExecutionPolicy Bypass -File windows\build.ps1
#
# The first publish downloads the .NET runtime pack from nuget.org (the project itself has no packages and
# its nuget.config lists no source, so the source is given here on the command line, build time only).
param([string]$Out = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$env:DOTNET_NOLOGO = '1'; $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$proj = Join-Path $PSScriptRoot 'Votive.Win'
$app = Join-Path $Out 'app'
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }

dotnet publish $proj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=false `
  -p:PublishTrimmed=true -p:_SuppressWinFormsTrimError=true -p:TrimMode=partial `
  --source https://api.nuget.org/v3/index.json -o $app
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

$exe = Join-Path $app 'VotiveWin.exe'
& $exe --self-test | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'the app self-test failed, not packaging' }

$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
if ($mb -gt 100) { throw "the app is $mb MB, over the 100 MB limit" }

$stage = Join-Path $Out 'stage'
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $exe $stage
@"
Votive for Windows

Run VotiveWin.exe. It shows one dot per agent session in a small pill inside the taskbar (or
at the top of the screen, your choice in the tray menu) and a tray icon. It sends nothing anywhere.

It reads the folder %USERPROFILE%\.votive, which the hook scripts fill. To wire your agents up,
use the scripts in the source repository:  node Scripts\install-windows.js
Start with Windows, pop-ups, sounds and the pill's position are in the tray icon's right-click menu.
"@ | Set-Content (Join-Path $stage 'README.txt') -Encoding UTF8

$zip = Join-Path $Out 'Votive-win-x64.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() + '  Votive-win-x64.zip' | Set-Content (Join-Path $Out 'Votive-win-x64.zip.sha256') -Encoding ASCII
Remove-Item $stage -Recurse -Force
'built {0} ({1} MB exe, zip {2} MB)' -f $zip, $mb, [math]::Round((Get-Item $zip).Length / 1MB, 1)
