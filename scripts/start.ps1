param([switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# cmd.exe can inherit the module path of PowerShell 7 when launching Windows PowerShell.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$runtime = Join-Path $root '.runtime'
[IO.Directory]::CreateDirectory($runtime) | Out-Null

function Install-Archive($url, $hash, $destination, $member, $exe) {
    if (Test-Path -LiteralPath (Join-Path $destination $exe)) { return }
    $temp = Join-Path $runtime ([Guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($temp) | Out-Null
    try {
        $archive = Join-Path $temp 'download.zip'
        Write-Host "Downloading $url"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $hash) {
            throw "SHA256 mismatch for $url"
        }
        $extract = Join-Path $temp 'files'
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $source = if ($member) { Join-Path $extract $member } else { $extract }
        if (!(Test-Path -LiteralPath (Join-Path $source $exe))) { throw "Missing $exe in archive" }
        [IO.Directory]::Move($source, $destination)
    } finally {
        if ((Split-Path -Parent ([IO.Path]::GetFullPath($temp))) -eq $runtime) {
            Remove-Item -LiteralPath $temp -Recurse -Force
        }
    }
}
function Invoke-Checked($program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program exited with code $LASTEXITCODE." }
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime 'python'
$env:UV_CACHE_DIR = Join-Path $runtime 'uv-cache'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $runtime 'browsers'
$nodeName = 'node-v24.14.0-win-x64'
$nodeDir = Join-Path $runtime $nodeName
$node = Join-Path $nodeDir 'node.exe'
$uvDir = Join-Path $runtime 'uv-0.9.18'
$uv = Join-Path $uvDir 'uv.exe'
$venv = Join-Path $runtime 'venv'
$env:LANDMARK_PYTHON = Join-Path $venv 'Scripts\python.exe'
$env:PATH = "$nodeDir;$env:PATH"
$lock = [IO.File]::Open((Join-Path $runtime 'setup.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    Install-Archive "https://nodejs.org/dist/v24.14.0/$nodeName.zip" '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66' $nodeDir $nodeName 'node.exe'
    Install-Archive 'https://github.com/astral-sh/uv/releases/download/0.9.18/uv-x86_64-pc-windows-msvc.zip' '28cbe5d30907a774bfe27a517a39b494ec6f7d3816bda8bbf6f9645490449182' $uvDir '' 'uv.exe'
    if (!(Test-Path -LiteralPath $env:LANDMARK_PYTHON)) {
        Invoke-Checked $uv @('venv','--managed-python','--python','3.13.9',$venv)
    }
    $stamp = Join-Path $runtime 'installed.txt'
    $version = ((Get-FileHash -LiteralPath 'package-lock.json','requirements.txt',$PSCommandPath).Hash -join '-')
    $ready = (Test-Path $stamp) -and ((Get-Content -Raw $stamp).Trim() -eq $version)
    if ($ready) {
        & $node -e "process.exit(require('fs').existsSync(require('playwright').chromium.executablePath()) ? 0 : 1)"
        $ready = $LASTEXITCODE -eq 0
        & $env:LANDMARK_PYTHON -c "import PIL; assert PIL.__version__ == '12.2.0'"
        $ready = $ready -and $LASTEXITCODE -eq 0
    }
    if (!$ready) {
        Invoke-Checked $uv @('pip','install','--python',$env:LANDMARK_PYTHON,'--require-hashes','--only-binary',':all:','-r','requirements.txt')
        Invoke-Checked $node @((Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'),'ci','--ignore-scripts','--no-audit','--no-fund')
        Invoke-Checked $node @('node_modules/playwright/cli.js','install','chromium')
        Set-Content -LiteralPath $stamp -Value $version -Encoding Ascii
    }
} finally {
    $lock.Dispose()
}
if ($InstallOnly) { Write-Host 'LandmarkDesk runtime ready.'; exit 0 }
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
& $node 'app/config.cjs'
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Enter your API settings and CVAT job URL in .env. Save and close Notepad to continue.'
    Start-Process -FilePath notepad.exe -ArgumentList ('"{0}"' -f (Join-Path $root '.env')) -Wait
    Invoke-Checked $node @('app/config.cjs')
}
Invoke-Checked $node @('app/studio.cjs')
