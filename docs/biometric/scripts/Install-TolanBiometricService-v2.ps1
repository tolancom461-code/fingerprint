param(
    [switch]$Apply
)

# Tolan Biometric Service - WinSW installer v2
# Fix: PowerShell single-object collection handling during port checks.
# Safe by default: without -Apply it only validates and prints the plan.
# It never changes TiDB, never edits the source .env, never changes device mode,
# and contains no reboot/shutdown command.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------- Fixed values for this local-PC installation ----------
$SourceDir   = 'C:\Users\mh\Desktop\01\tolanworkforce\biometric-service'
$DeployDir   = 'C:\Tolan\BiometricService'
$NodeExe     = 'C:\Program Files\nodejs\node.exe'

$ServiceId   = 'TolanBiometricService'
$DisplayName = 'Tolan Biometric Service'
$TaskName    = 'Tolan Biometric Service'

# Pinned official WinSW stable release (do not auto-follow "latest")
$WinSWVersion = '2.12.0'
$WinSWUrl     = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$WinSWSha256  = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

$WrapperExe   = Join-Path $DeployDir "$ServiceId.exe"
$WrapperXml   = Join-Path $DeployDir "$ServiceId.xml"
$DeployEnv    = Join-Path $DeployDir '.env'
$SourceEnv    = Join-Path $SourceDir '.env'
$SourceState  = Join-Path $SourceDir 'var\web-bridge-state.json'
$DeployState  = Join-Path $DeployDir 'var\web-bridge-state.json'
$ServiceLogs  = Join-Path $DeployDir 'service-logs'
$ReportFile   = Join-Path $DeployDir 'INSTALLATION-REPORT.txt'

$taskExisted = $false
$taskWasEnabled = $false
$taskWasRunning = $false
$serviceInstalledByThisRun = $false
$deployDirCreatedByThisRun = $false

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Require-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }
}

function Get-EnvValue([string]$Path, [string]$Name) {
    $prefix = "$Name="
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            return $line.Substring($prefix.Length).Trim()
        }
    }
    return $null
}

function Get-ListeningPorts {
    @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in 9095,9096,9097 } |
      Select-Object LocalAddress,LocalPort,OwningProcess)
}

function Wait-PortsClosed([int]$TimeoutSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $ports = @(Get-ListeningPorts)
        if ($ports.Count -eq 0) { return }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)

    $details = (Get-ListeningPorts | Format-Table -AutoSize | Out-String)
    throw "Ports 9095/9096/9097 are still in use. Aborting to avoid a duplicate service.`n$details"
}

function Wait-ServiceHealthy([int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
        $ports = @(Get-ListeningPorts)
        $portNumbers = @($ports | Select-Object -ExpandProperty LocalPort -Unique)

        if ($svc -and $svc.Status -eq 'Running' -and
            (9095 -in $portNumbers) -and
            (9096 -in $portNumbers) -and
            (9097 -in $portNumbers)) {
            return
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)

    $svcText = (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue | Format-List * | Out-String)
    $portText = (Get-ListeningPorts | Format-Table -AutoSize | Out-String)
    throw "Service did not become healthy within $TimeoutSeconds seconds.`nSERVICE:`n$svcText`nPORTS:`n$portText"
}

try {
    Write-Step "Pre-flight validation"

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run PowerShell as Administrator.'
    }

    Require-File $NodeExe 'Node.js'
    Require-File $SourceEnv 'Source .env'
    Require-File (Join-Path $SourceDir 'src\index.js') 'biometric-service entry point'
    Require-File (Join-Path $SourceDir 'package.json') 'package.json'
    Require-File (Join-Path $SourceDir 'node_modules\mysql2\package.json') 'installed mysql2 dependency'
    Require-File $SourceState 'Web Bridge cursor state file'

    $nodeVersion = (& $NodeExe -v).Trim()
    $major = [int](($nodeVersion.TrimStart('v')).Split('.')[0])
    if ($major -lt 20) {
        throw "Node.js 20+ is required. Found $nodeVersion"
    }

    $bridgeEnabled = Get-EnvValue $SourceEnv 'BIOMETRIC_WEB_BRIDGE_ENABLED'
    $bridgeTarget  = Get-EnvValue $SourceEnv 'BIOMETRIC_WEB_BRIDGE_TARGET_URL'
    if ($bridgeEnabled -ne 'true') {
        throw 'BIOMETRIC_WEB_BRIDGE_ENABLED is not true. No changes were made.'
    }
    if ($bridgeTarget -ne 'https://www.tolanhr.com') {
        throw "Unexpected Web Bridge target: $bridgeTarget. Expected https://www.tolanhr.com"
    }

    if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
        throw "Windows service '$ServiceId' already exists. Stop and review before reinstalling."
    }

    if (Test-Path -LiteralPath $DeployDir) {
        throw "Deployment folder already exists: $DeployDir. Stop and review before overwriting anything."
    }

    $task = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $taskExisted = $true
        $taskWasEnabled = ($task.State -ne 'Disabled')
        $taskWasRunning = ($task.State -eq 'Running')
    }

    Write-Host "Node:              $nodeVersion"
    Write-Host "Source:            $SourceDir"
    Write-Host "Deploy target:     $DeployDir"
    Write-Host "Web Bridge:        enabled"
    Write-Host "Web Bridge target: https://www.tolanhr.com"
    Write-Host "Cursor state:      present"
    Write-Host "Installer script:  v2 (single-object port-check fix)"
    Write-Host "WinSW:             $WinSWVersion (pinned x64)"
    Write-Host "Windows service:   $ServiceId"
    Write-Host "Start mode:        Automatic"
    Write-Host "Failure action:    Restart service only after 10 seconds"
    Write-Host "Reboot action:     NONE"
    Write-Host "Old scheduled task will be disabled only AFTER the new service is healthy."

    if (-not $Apply) {
        Write-Host ""
        Write-Host "REVIEW MODE ONLY: no changes were made." -ForegroundColor Yellow
        Write-Host "When approved, run this same script with:  -Apply" -ForegroundColor Yellow
        exit 0
    }

    Write-Step "Stopping the old Task Scheduler instance, if running"
    if ($taskExisted -and $taskWasRunning) {
        Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName
        Wait-PortsClosed 20
    } else {
        # If ports are occupied by something else, do not guess or kill it.
        $portsNow = @(Get-ListeningPorts)
        if ($portsNow.Count -gt 0) {
            $details = ($portsNow | Format-Table -AutoSize | Out-String)
            throw "Biometric ports are already in use by another process. No process will be killed automatically.`n$details"
        }
    }

    Write-Step "Creating fixed deployment directory"
    New-Item -ItemType Directory -Path (Split-Path $DeployDir -Parent) -Force | Out-Null
    New-Item -ItemType Directory -Path $DeployDir | Out-Null
    $deployDirCreatedByThisRun = $true

    # Restrict the deployment directory BEFORE copying .env/secrets into it.
    $deployAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $deployAcl.SetAccessRuleProtection($true, $false)

    $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $adminsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $userSid   = $identity.User

    foreach ($sid in @($systemSid, $adminsSid, $userSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$deployAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $DeployDir -AclObject $deployAcl

    # /E copies source, node_modules, .env, var, and the current bridge cursor.
    # No /MIR is used, so the script will never mirror-delete source/deploy files.
    & robocopy.exe $SourceDir $DeployDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NP /NJH /NJS | Out-Host
    $rc = $LASTEXITCODE
    if ($rc -gt 7) {
        throw "robocopy failed with exit code $rc"
    }

    Require-File $DeployEnv 'Deployed .env'
    Require-File $DeployState 'Deployed Web Bridge cursor state'

    $sourceStateHash = (Get-FileHash -LiteralPath $SourceState -Algorithm SHA256).Hash
    $deployStateHash = (Get-FileHash -LiteralPath $DeployState -Algorithm SHA256).Hash
    if ($sourceStateHash -ne $deployStateHash) {
        throw 'Web Bridge cursor state changed during copy. Aborting.'
    }

    Write-Step "Protecting the deployed .env permissions"
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)

    foreach ($sid in @($systemSid, $adminsSid, $userSid)) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $DeployEnv -AclObject $acl

    Write-Step "Downloading pinned WinSW from the official GitHub release"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $WrapperExe -UseBasicParsing

    $actualHash = (Get-FileHash -LiteralPath $WrapperExe -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actualHash -ne $WinSWSha256) {
        Remove-Item -LiteralPath $WrapperExe -Force -ErrorAction SilentlyContinue
        throw "WinSW SHA-256 mismatch. Expected $WinSWSha256 but got $actualHash"
    }

    New-Item -ItemType Directory -Path $ServiceLogs -Force | Out-Null

    Write-Step "Creating WinSW service configuration"
    $xml = @"
<service>
  <id>$ServiceId</id>
  <name>$DisplayName</name>
  <description>Tolan local biometric bridge service. Device remains governed by the existing biometric-service configuration.</description>

  <startmode>Automatic</startmode>
  <delayedAutoStart/>

  <workingdirectory>$DeployDir</workingdirectory>
  <executable>$NodeExe</executable>
  <arguments>--env-file=.env src/index.js</arguments>

  <stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>

  <logpath>$ServiceLogs</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
    Set-Content -LiteralPath $WrapperXml -Value $xml -Encoding UTF8

    Write-Step "Installing the real Windows service"
    & $WrapperExe install
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW install failed with exit code $LASTEXITCODE"
    }
    $serviceInstalledByThisRun = $true

    Write-Step "Starting the Windows service"
    & $WrapperExe start
    if ($LASTEXITCODE -ne 0) {
        throw "WinSW start failed with exit code $LASTEXITCODE"
    }

    Wait-ServiceHealthy 45

    Write-Step "Disabling the old Task Scheduler task only after success"
    if ($taskExisted -and $taskWasEnabled) {
        Disable-ScheduledTask -TaskPath '\' -TaskName $TaskName | Out-Null
    }

    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceId'"
    $ports = @(Get-ListeningPorts | Sort-Object LocalPort)

    $report = @"
Tolan Biometric Service installation report
Created: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')

ServiceId: $ServiceId
DisplayName: $DisplayName
State: $($svc.State)
StartMode: $($svc.StartMode)
ServiceAccount: $($svc.StartName)
Node: $nodeVersion
NodePath: $NodeExe
DeployDir: $DeployDir
WinSWVersion: $WinSWVersion
WinSWSha256: $actualHash
WebBridgeEnabled: true
WebBridgeTarget: https://www.tolanhr.com
OldTaskSchedulerTask: $(if ($taskExisted) { 'disabled after successful service start' } else { 'not found' })
RebootActionConfigured: false
"@
    Set-Content -LiteralPath $ReportFile -Value $report -Encoding UTF8

    Write-Step "SUCCESS"
    Write-Host "Service state:     $($svc.State)"
    Write-Host "Start mode:        $($svc.StartMode)"
    Write-Host "Service account:   $($svc.StartName)"
    Write-Host "Ports:"
    $ports | Format-Table -AutoSize
    Write-Host "Install report:    $ReportFile"
    Write-Host ""
    Write-Host "No SQL was executed. Source .env was not edited. No reboot/shutdown command was used." -ForegroundColor Green
    Write-Host "Next step should be a controlled crash/recovery test before any Windows reboot test." -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "INSTALLATION STOPPED: $($_.Exception.Message)" -ForegroundColor Red

    # Best-effort rollback of the new service only.
    if ($serviceInstalledByThisRun) {
        try { & $WrapperExe stop | Out-Null } catch {}
        try { & $WrapperExe uninstall | Out-Null } catch {}
        Start-Sleep -Seconds 2
    }

    # Remove only the fresh deployment folder created by THIS run.
    # Never remove or modify the source project directory.
    if ($deployDirCreatedByThisRun -and (Test-Path -LiteralPath $DeployDir)) {
        try { Remove-Item -LiteralPath $DeployDir -Recurse -Force -ErrorAction Stop } catch {}
    }

    # Restore the old scheduled task if this run had changed its runtime situation.
    if ($taskExisted) {
        try {
            if ($taskWasEnabled) {
                Enable-ScheduledTask -TaskPath '\' -TaskName $TaskName | Out-Null
            }
            if ($taskWasRunning) {
                Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
            }
        } catch {}
    }

    Write-Host "The old Task Scheduler configuration was preserved/restored when possible." -ForegroundColor Yellow
    Write-Host "No reboot command and no SQL command were executed." -ForegroundColor Yellow
    exit 1
}
