param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$studioPython = Join-Path $projectRoot '.venv\Scripts\python.exe'

Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath $studioPython)) {
        if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
            throw 'Install Windows Python 3.12 or 3.13 and the Python Launcher before running start.ps1.'
        }
        & py.exe -3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
        if ($LASTEXITCODE -ne 0) { throw 'Windows Python 3.11+ is required. See README.md.' }
        & py.exe -3 -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the virtual environment.' }
    }

    & $studioPython -m pip install --disable-pip-version-check -q -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. See the pip output above.' }

    if (-not (Test-Path -LiteralPath '.env')) {
        Copy-Item -LiteralPath '.env.example' -Destination '.env'
        Write-Host 'Created .env. See the Model Setup page for API key settings.'
    }
    & $studioPython -m uvicorn studio.app:app --host 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'The web server exited with an error.' }
} finally {
    Pop-Location
}
