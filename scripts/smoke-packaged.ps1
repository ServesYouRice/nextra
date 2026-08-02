param(
    [string]$Executable = ".\Nextra.exe",
    [int]$Port = 31847
)

$ErrorActionPreference = 'Stop'
$env:AUTO_PUBLIC_TUNNEL = 'false'
$env:OPEN_BROWSER = 'false'
$env:PORT = "$Port"
$env:NEXTRA_SMOKE_TEST = '1'
$env:LOCAL_HTTPS = 'false'
$env:BIND_HOST = '127.0.0.1'
$env:WORKER_RECOVERY_MIN_UPTIME_SECONDS = '0'
$resolvedExecutable = [IO.Path]::GetFullPath($Executable)

function Get-SmokeProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $resolvedExecutable, [StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine -match '[\\/]caxa[\\/]applications[\\/]nextra-')
    })
}

function Wait-Ready([string]$BaseUrl, [int]$Attempts = 60) {
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-RestMethod -Uri "$BaseUrl/readyz" -TimeoutSec 2
            $requiredComponentsReady = @($response.components.PSObject.Properties.Value) |
                Where-Object { $_.required -and $_.status -ne 'ready' }
            if ($response.status -eq 'ready' -and $requiredComponentsReady.Count -eq 0) {
                return $response
            }
        } catch {}
    }
    throw 'Packaged executable did not become ready.'
}

$baselineProcessIds = @(Get-SmokeProcesses | ForEach-Object ProcessId)
$baselineCloudflaredIds = @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object ProcessId)
Write-Host "Starting packaged executable on port $Port..."
$process = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden

try {
    $baseUrl = "http://127.0.0.1:$Port"
    Wait-Ready $baseUrl | Out-Null
    Write-Host 'Initial packaged readiness passed.'

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

    $beforeRestart = Invoke-RestMethod -Uri "$baseUrl/api/metrics" -TimeoutSec 5
    $restart = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/test/kill-media-worker" -TimeoutSec 5
    if ($restart.status -ne 'terminating' -or $restart.workerPid -ne $beforeRestart.mediaWorker.pid) {
        throw 'Packaged media-worker replacement was not accepted.'
    }

    $replacementReady = $false
    $replacementDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $replacementDeadline) {
        Start-Sleep -Milliseconds 250
        try {
            $metrics = Invoke-RestMethod -Uri "$baseUrl/api/metrics" -TimeoutSec 1
            $readiness = Invoke-RestMethod -Uri "$baseUrl/readyz" -TimeoutSec 1
            if ($readiness.status -eq 'ready' -and
                $metrics.process.pid -ne $beforeRestart.process.pid -and
                $metrics.mediaWorker.pid -ne $beforeRestart.mediaWorker.pid) {
                $replacementReady = $true
                break
            }
        } catch {}
    }
    if (-not $replacementReady) { throw 'Packaged executable did not replace the failed media worker.' }
    Write-Host 'Packaged process and mediasoup worker replacement passed.'

    $env:NEXTRA_PACKAGED_BASE_URL = $baseUrl
    & npx.cmd playwright test --config=playwright.packaged.config.mjs --project=chromium
    if ($LASTEXITCODE -ne 0) { throw "Packaged decoded-frame flow failed with code $LASTEXITCODE." }
    Write-Host 'Packaged decoded-frame flow passed.'

    Invoke-RestMethod -Method Post -Uri "$baseUrl/api/test/shutdown" -TimeoutSec 5 | Out-Null
    $stopped = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            Invoke-WebRequest -Uri "$baseUrl/healthz" -UseBasicParsing -TimeoutSec 1 | Out-Null
        } catch {
            $stopped = $true
            break
        }
    }
    if (-not $stopped) { throw 'Packaged executable did not shut down gracefully.' }
    Write-Host 'Packaged graceful shutdown passed.'
} finally {
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/test/shutdown" -TimeoutSec 2 | Out-Null } catch {}
    Start-Sleep -Milliseconds 500

    $remaining = @(Get-SmokeProcesses | Where-Object { $baselineProcessIds -notcontains $_.ProcessId })
    foreach ($candidate in $remaining) {
        Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500

    $stale = @(Get-SmokeProcesses | Where-Object { $baselineProcessIds -notcontains $_.ProcessId })
    if ($stale.Count -gt 0) {
        throw "Packaged smoke left stale extraction processes: $($stale.ProcessId -join ', ')."
    }

    Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $baselineCloudflaredIds -notcontains $_.ProcessId } |
        ForEach-Object { throw "Child cloudflared process remained after shutdown (PID $($_.ProcessId))." }
}
