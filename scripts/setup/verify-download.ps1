# Download integrity for the Windows setup scripts (Step 9.4). Dot-source this file, then call
#   Assert-UsapDownload -Url <url> -Path <file>
# after a download completes and before the file is used. The URL is looked up in
# scripts/config/download-digests.txt:
#   * listed   -> size and SHA-256 must match; otherwise the file is deleted and an exception whose
#                 message starts with "USAP_INTEGRITY:" is thrown (callers do not retry it)
#   * unlisted -> a warning and the file's SHA-256 are printed ("unverified") and setup continues.
#                 This happens for overridden versions and for sources without pinned digests.
# A missing digest list fails closed.

$script:UsapDigests = if ($env:USAP_DIGESTS) { $env:USAP_DIGESTS } else { Join-Path (Split-Path -Parent $PSScriptRoot) "config\download-digests.txt" }

function Assert-UsapDownload {
    param([Parameter(Mandatory = $true)][string]$Url, [Parameter(Mandatory = $true)][string]$Path)
    $name = Split-Path -Leaf $Path
    if (-not (Test-Path -LiteralPath $script:UsapDigests)) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "USAP_INTEGRITY: download digest list missing ($($script:UsapDigests)); refusing to install unverified files."
    }
    if (-not (Test-Path -LiteralPath $Path)) { throw "USAP_INTEGRITY: $name is missing after download." }

    $entry = $null
    foreach ($line in [System.IO.File]::ReadAllLines($script:UsapDigests)) {
        $t = $line.Trim()
        if ($t -eq "" -or $t.StartsWith("#")) { continue }
        $f = $t -split '\s+'
        if ($f.Length -ge 3 -and $f[2] -ceq $Url) { $entry = $f; break }
    }

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $entry) {
        Write-Host "   !!  $name is not in the pinned digest list; installing it UNVERIFIED (publisher not authenticated)." -ForegroundColor Yellow
        Write-Host "   !!  SHA-256: $actual" -ForegroundColor Yellow
        return
    }
    $size = (Get-Item -LiteralPath $Path).Length
    if ([string]$size -ne $entry[1]) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "USAP_INTEGRITY: $name is $size bytes, expected $($entry[1]) (incomplete or replaced download). Discarded."
    }
    if ($actual -ne $entry[0]) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "USAP_INTEGRITY: $name failed SHA-256 verification (expected $($entry[0]), got $actual). Discarded."
    }
    Write-Host "   OK  SHA-256 verified: $name" -ForegroundColor Green
}
