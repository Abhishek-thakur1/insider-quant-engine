$success = $false
while (-not $success) {
    Write-Host "Running fetch..."
    $output = npx tsx backtest/run.ts fetch --days 5 2>&1
    $output | Write-Host
    if ($output -match "symbol\(s\) failed") {
        Write-Host "Some symbols failed. Waiting 60 seconds before retrying..."
        Start-Sleep -Seconds 60
    } else {
        Write-Host "Fetch completed successfully!"
        $success = $true
    }
}
