param(
    [string]$Executable = ".\Nextra.exe",
    [int]$Port = 31847
)

$ErrorActionPreference = 'Stop'
$env:AUTO_PUBLIC_TUNNEL = 'false'
$env:OPEN_BROWSER = 'false'
$env:PORT = "$Port"
$env:NEXTRA_SMOKE_TEST = '1'
$process = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden

try {
    $baseUrl = "http://127.0.0.1:$Port"
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-RestMethod -Uri "$baseUrl/readyz" -TimeoutSec 2
            $requiredComponentsReady = @($response.components.PSObject.Properties.Value) |
                Where-Object { $_.required -and $_.status -ne 'ready' }
            if ($response.status -eq 'ready' -and $requiredComponentsReady.Count -eq 0) {
                $ready = $true
                break
            }
        } catch {}
    }
    if (-not $ready) { throw 'Packaged executable did not become ready.' }

    $index = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing -TimeoutSec 5
    if ($index.StatusCode -ne 200 -or $index.Content -notmatch '<div id="root"') {
        throw 'Packaged static application shell was not served.'
    }

    $socketHandshake = Invoke-WebRequest -Uri "$baseUrl/socket.io/?EIO=4&transport=polling" -UseBasicParsing -TimeoutSec 5
    if ($socketHandshake.StatusCode -ne 200 -or $socketHandshake.Content -notmatch '^0\{') {
        throw 'Socket.IO handshake failed.'
    }

    $packageInfo = Invoke-RestMethod -Uri "$baseUrl/api/package-info" -TimeoutSec 5
    foreach ($required in @('license', 'notices', 'sourceInstructions', 'sbom')) {
        if (-not $packageInfo.artifacts.$required) { throw "Packaged artifact is missing $required." }
    }

    Invoke-RestMethod -Method Post -Uri "$baseUrl/api/test/shutdown" -TimeoutSec 5 | Out-Null
    if (-not $process.WaitForExit(10000)) { throw 'Packaged executable did not shut down gracefully.' }
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
    Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $process.Id } |
        ForEach-Object { throw "Child cloudflared process remained after shutdown (PID $($_.ProcessId))." }
}
