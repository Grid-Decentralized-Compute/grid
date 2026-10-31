# One-shot setup for a Grid GPU host on Windows 10 or 11 with an NVIDIA graphics card, through WSL2.
# Safe to run again: every step checks before it changes anything. If Windows needs a restart in the
# middle, restart and run the same command again; it picks up where it stopped.
#
# NOT TESTED END TO END. Nobody has run this on a real gaming PC yet. The checks, the settings-file
# editing and the command plumbing were tried on one Windows 11 PC that has no WSL, and the Linux
# half is the existing scripts/host-setup.sh. Installing WSL and the distro, the GPU passthrough, the
# firewall and port rules and the scheduled task are written from the documentation and are unproven.
# Read all of it before you run it, and expect to have to fix something.
#
# Run it from an elevated PowerShell (right-click Start, then "Terminal (Admin)"). Download, read, run:
#
#   Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Grid-Decentralized-Compute/grid/main/scripts/host-setup.ps1 -OutFile host-setup.ps1
#   notepad host-setup.ps1
#   $env:GRID_PUBLIC_URL = "https://node1.example.com"; powershell -NoProfile -ExecutionPolicy Bypass -File .\host-setup.ps1
#
# Switches:
#   -CheckOnly   run the checks and say what would change; changes nothing and needs no administrator rights
#   -Uninstall   remove the startup task, the port rules and the firewall rules (the Ubuntu distro stays;
#                the end of the output says how to remove it)
#
# Settings (environment variables, set in the same PowerShell window before you run it). The first six are
# handed to scripts/host-setup.sh unchanged and are described at the top of that file:
#   GRID_PUBLIC_URL      https address of this node's API, served by a Cloudflare tunnel   (required)
#   GRID_NAME            how the machine shows up in the market      (default host-1)
#   GRID_PRICE_PER_HOUR  ETH per hour for a direct rental            (default 0.0005)
#   GRID_TUNNEL_NAME     Cloudflare tunnel name                      (default grid-node1)
#   GRID_REF             git tag or commit to run                    (default main)
#   PUBLIC_IP            this network's public IPv4 address          (default: detected)
#   GRID_PRIVATE_KEY     optional: use this wallet (0x and 64 hex characters) as the host wallet instead of
#                        a new one. host-setup.sh does not read it; this script writes it into node/.env
#                        after host-setup.sh has run and restarts the node. It is sent to Ubuntu on
#                        standard input, never printed and never put on a command line.
# Any other GRID_ setting (hours, swarm limits, auto-pricing) goes into /opt/grid/node/.env inside Ubuntu.
#
# What it does: checks Windows, the NVIDIA driver and virtualization; installs WSL2 and Ubuntu 24.04 if
# missing; turns on systemd in Ubuntu and, on Windows 11 22H2 or newer, mirrored networking so that the
# ports 2222 (renters' SSH) and 4001 (peer to peer) reach Ubuntu directly (older Windows gets netsh
# portproxy rules and a firewall rule instead); creates a "gridadmin" user in Ubuntu for the setup; runs
# scripts/host-setup.sh from a fresh clone of the repository inside Ubuntu, which installs Docker Engine
# (not Docker Desktop), the NVIDIA Container Toolkit, Node.js and cloudflared and starts the node as a
# systemd service; and registers a scheduled task that starts Ubuntu at every logon and keeps it running.
# The GPU driver stays on Windows. WSL2 passes the GPU through for CUDA; no Linux driver is installed.
#
# What it changes about Ubuntu, because renters' code runs in containers inside it: it turns off the
# mounting of your Windows drives and the launching of Windows programs from inside Ubuntu. That limits
# what a container escape could reach. WSL2 is still a virtual machine on your everyday PC, not a
# dedicated host.
#
# Only this file and scripts/host-setup.sh need to be read to know everything it does. The port 7777 of
# the node's API is deliberately not opened: host-setup.sh keeps it on loopback behind the tunnel.

#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$Distro        = 'Ubuntu-24.04'
$RepoUrl       = 'https://github.com/Grid-Decentralized-Compute/grid'
$SetupUser     = 'gridadmin'
$TaskName      = 'Grid node (WSL)'
$Ports         = @(2222, 4001)
$WatchedPorts  = @(2222, 4001, 7777)
$DataDir       = Join-Path $env:ProgramData 'Grid'
$StartScript   = Join-Path $DataDir 'start-wsl.ps1'
$HyperVRule    = 'Grid-WSL-Inbound'
$FirewallRule  = 'Grid-WSL-Portproxy'
$HyperVCreator = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
$Wsl           = Join-Path $env:SystemRoot 'System32\wsl.exe'
$PassThrough   = @('GRID_PUBLIC_URL', 'GRID_NAME', 'GRID_PRICE_PER_HOUR', 'GRID_TUNNEL_NAME', 'GRID_REF', 'PUBLIC_IP')

$script:Build         = 0
$script:WslVersion    = $null
$script:Mode          = ''
$script:DistroWasNew  = $false
$script:ConfigChanged = $false
$script:HostAddress   = ''
$script:TunnelReady   = $false
$script:CheckProblems = 0

# --------------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------------

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "   $Text" }
function Warn([string]$Text) { Write-Host "   warning: $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { throw "GRIDSTOP: $Text" }

function Confirm-Yes([string]$Question, [switch]$DefaultYes) {
  $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
  try { $answer = Read-Host "   $Question $hint" } catch { return $false }
  if ([string]::IsNullOrWhiteSpace($answer)) { return [bool]$DefaultYes }
  return ($answer.Trim() -match '^(y|yes)$')
}

# --------------------------------------------------------------------------------------------------
# Running programs. wsl.exe writes its own messages in UTF-16 and Linux programs write UTF-8, so
# everything is read as UTF-8 and the NUL bytes of UTF-16 are dropped, which leaves plain text.
# --------------------------------------------------------------------------------------------------

function Invoke-Exe {
  param(
    [string]$File,
    [string[]]$Arguments = @(),
    $Stdin = $null,
    [switch]$Stream
  )
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $collected = New-Object System.Collections.Generic.List[string]
  $state = @{ Progress = $false }
  $hasStdin = $null -ne $Stdin
  $handle = {
    $line = ("$_").Replace([string][char]0, '').TrimEnd("`r")
    $line = [regex]::Replace($line, '\x1b\[[0-9;?]*[A-Za-z]', '')
    [void]$collected.Add($line)
    if ($Stream -and $line.Trim().Length -gt 0) {
      if ($line -match '\d+(\.\d+)?\s*%') {
        if (-not $state.Progress) { Write-Host '   ... (progress output hidden)'; $state.Progress = $true }
      } else {
        $state.Progress = $false
        Write-Host $line
      }
    }
  }
  try {
    if ($hasStdin) { $Stdin | & $File @Arguments 2>&1 | ForEach-Object -Process $handle }
    else { & $File @Arguments 2>&1 | ForEach-Object -Process $handle }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPref
  }
  if ($null -eq $code) { $code = 0 }
  return [pscustomobject]@{ ExitCode = [int]$code; Text = (($collected -join "`n").Trim()) }
}

function ConvertTo-ShQuoted([string]$Value) { return "'" + $Value.Replace("'", "'\''") + "'" }

# Runs a bash script inside the distro. The script travels as base64 on the command line (no quoting
# problems, no temporary file) and is read through process substitution, so standard input stays free
# for data such as the wallet key. Variables in -Vars are exported before the script starts.
function Invoke-Wsl {
  param(
    [string]$Script,
    [string]$User = 'root',
    [hashtable]$Vars = @{},
    $Stdin = $null,
    [switch]$Stream
  )
  $prelude = "set -eu`nset -o pipefail`n"
  foreach ($name in $Vars.Keys) { $prelude += "export $name=" + (ConvertTo-ShQuoted ([string]$Vars[$name])) + "`n" }
  $text = ($prelude + $Script) -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
  $wslArgs = @('-d', $Distro, '-u', $User, '--cd', '~', '--exec', '/bin/bash', '-c', "bash <(echo $b64 | base64 -d)")
  if ($null -ne $Stdin) { return Invoke-Exe -File $Wsl -Arguments $wslArgs -Stdin $Stdin -Stream:$Stream }
  return Invoke-Exe -File $Wsl -Arguments $wslArgs -Stream:$Stream
}

# --------------------------------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------------------------------

function Format-Ini([string]$Text) {
  $t = $Text -replace "`r`n", "`n" -replace "`r", "`n"
  $t = $t.TrimEnd([char[]]@(10, 32, 9))
  if ($t.Length -eq 0) { return '' }
  return $t + "`n"
}

# Returns the INI text with Key=Value set inside [Section]. Everything else in the file is kept.
function Set-IniValue {
  param([string]$Text, [string]$Section, [string]$Key, [string]$Value)
  $lines = New-Object System.Collections.Generic.List[string]
  $norm = Format-Ini $Text
  if ($norm.Length -gt 0) { foreach ($l in $norm.TrimEnd("`n").Split("`n")) { [void]$lines.Add($l) } }
  $start = -1
  $end = $lines.Count
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*\[([^\]]+)\]\s*$') {
      if ($start -ge 0) { $end = $i; break }
      if ($Matches[1].Trim() -ieq $Section) { $start = $i }
    }
  }
  $entry = "$Key=$Value"
  if ($start -lt 0) {
    if ($lines.Count -gt 0) { [void]$lines.Add('') }
    [void]$lines.Add("[$Section]")
    [void]$lines.Add($entry)
  } else {
    $found = $false
    for ($j = $start + 1; $j -lt $end; $j++) {
      if ($lines[$j] -match '^\s*([^#;\s=][^=]*?)\s*=' -and $Matches[1].Trim() -ieq $Key) {
        $lines[$j] = $entry
        $found = $true
        break
      }
    }
    if (-not $found) {
      $at = $end
      while ($at -gt $start + 1 -and $lines[$at - 1].Trim() -eq '') { $at-- }
      $lines.Insert($at, $entry)
    }
  }
  return (($lines -join "`n") + "`n")
}

function Get-WslDistros {
  $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path -LiteralPath $root)) { return @() }
  $found = @()
  foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.PSObject.Properties['DistributionName']) {
      $version = 0
      if ($p.PSObject.Properties['Version']) { $version = [int]$p.Version }
      $found += [pscustomobject]@{ Name = [string]$p.DistributionName; Version = $version }
    }
  }
  return $found
}

function Get-InstalledDistro {
  return (Get-WslDistros | Where-Object { $_.Name -eq $Distro } | Select-Object -First 1)
}

# The WSL package version, or $null when wsl.exe has no --version (not installed, or the old built-in one).
function Get-WslVersion {
  $r = Invoke-Exe -File $Wsl -Arguments @('--version')
  if ($r.ExitCode -ne 0) { return $null }
  $m = [regex]::Match($r.Text, '\d+\.\d+\.\d+(\.\d+)?')
  if ($m.Success) { return [version]$m.Value }
  return $null
}

function Test-RebootPending {
  foreach ($k in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')) {
    if (Test-Path -LiteralPath $k) { return $true }
  }
  return $false
}

function Get-LanAddress {
  try {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
      Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
    $addr = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
      Select-Object -First 1
    return [string]$addr.IPAddress
  } catch { return $null }
}

# --------------------------------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------------------------------

function Test-ThisPc {
  $problems = New-Object System.Collections.Generic.List[string]

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Note 'running as administrator'
  } elseif ($CheckOnly) {
    Note 'not running as administrator (fine for -CheckOnly, which changes nothing)'
  } else {
    [void]$problems.Add('this needs an administrator PowerShell. Right-click the Start button, choose Terminal (Admin) or Windows PowerShell (Admin), and run the command again.')
  }
  if (-not [Environment]::Is64BitProcess) {
    [void]$problems.Add('this is a 32-bit PowerShell. Open the normal 64-bit one.')
  }

  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  $script:Build = $build
  if ($build -ge 22000) {
    Note "$($os.Caption), build $build"
  } elseif ($build -ge 19045) {
    Note "$($os.Caption), build $build (Windows 10 22H2 works, but it cannot use mirrored networking)"
  } else {
    [void]$problems.Add("Windows build $build is too old. WSL2 with GPU support needs Windows 11, or Windows 10 22H2 (build 19045) with all updates installed.")
  }

  $smi = $null
  foreach ($p in @("$env:SystemRoot\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe")) {
    if (Test-Path -LiteralPath $p) { $smi = $p; break }
  }
  if (-not $smi) {
    [void]$problems.Add('no NVIDIA driver found (nvidia-smi.exe is missing). Install the current driver from nvidia.com/drivers or the NVIDIA app, restart, and run this again. The driver goes on Windows; nothing is installed for the GPU inside Linux.')
  } else {
    $r = Invoke-Exe -File $smi -Arguments @('--query-gpu=name,driver_version', '--format=csv,noheader')
    $major = $null
    if ($r.ExitCode -eq 0) {
      foreach ($line in ($r.Text -split "`n")) {
        if ($line -match '^(?<gpu>.+),\s*(?<major>\d+)\.(?<minor>\d+)\s*$') {
          Note ("GPU: " + $Matches['gpu'].Trim() + ", driver " + $Matches['major'] + "." + $Matches['minor'])
          if ($null -eq $major) { $major = [int]$Matches['major'] }
        }
      }
    }
    if ($null -eq $major) {
      Warn 'could not read the NVIDIA driver version (on some PCs nvidia-smi only runs from an elevated prompt). Continuing; the Linux side checks it again.'
    } elseif ($major -lt 570) {
      [void]$problems.Add("the NVIDIA driver is too old (version $major). RTX 50-series cards and CUDA 12.8 need 570 or newer. Update it from nvidia.com/drivers or the NVIDIA app, then run this again.")
    }
  }

  $cs = Get-CimInstance Win32_ComputerSystem
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  # With a hypervisor already running, the firmware flag reads False, so either one counts.
  if ($cs.HypervisorPresent -or $cpu.VirtualizationFirmwareEnabled) {
    Note 'virtualization is on'
  } else {
    [void]$problems.Add('virtualization is switched off. Restart into the BIOS/UEFI setup, turn on Intel Virtualization Technology (VT-x), or SVM Mode on AMD, then run this again.')
  }

  $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB)
  if ($ramGb -lt 16) { Warn "only $ramGb GB of memory; WSL gets half of it by default, and renters' work needs room (32 GB is comfortable)" }
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" -ErrorAction SilentlyContinue
  if ($disk) {
    $freeGb = [math]::Floor($disk.FreeSpace / 1GB)
    if ($freeGb -lt 60) { Warn "only $freeGb GB free on $($env:SystemDrive); Ubuntu, container images and renters' work need room (100 GB or more is comfortable)" }
    else { Note "$freeGb GB free on $($env:SystemDrive)" }
  }

  try {
    $busy = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $WatchedPorts -contains $_.LocalPort } |
      Select-Object -ExpandProperty LocalPort -Unique)
    if ($busy.Count -gt 0) {
      Warn ("something on Windows already listens on TCP " + ($busy -join ', ') + ". The node needs 2222, 4001 and 7777 inside Ubuntu, and with mirrored networking Windows and Ubuntu share them. Stop that program first.")
    }
  } catch { }

  if (Test-RebootPending) { Warn 'Windows has a restart pending. If a step below asks for a restart, that is why.' }
  return $problems
}

function Get-HostSettings {
  $problems = New-Object System.Collections.Generic.List[string]
  $rules = @(
    @{ Name = 'GRID_PUBLIC_URL';     Required = $true;  Pattern = '^https://[A-Za-z0-9.-]+\z';        Hint = 'the https address this node will have, for example https://node1.example.com' },
    @{ Name = 'GRID_NAME';           Required = $false; Pattern = '^[A-Za-z0-9 ._-]{1,48}\z';         Hint = 'letters, digits, spaces, dots, dashes and underscores (48 at most)' },
    @{ Name = 'GRID_PRICE_PER_HOUR'; Required = $false; Pattern = '^[0-9]+(\.[0-9]+)?\z';             Hint = 'a number of ETH, for example 0.0005' },
    @{ Name = 'GRID_TUNNEL_NAME';    Required = $false; Pattern = '^[A-Za-z0-9._-]{1,64}\z';          Hint = 'letters, digits, dots, dashes and underscores (64 at most)' },
    @{ Name = 'GRID_REF';            Required = $false; Pattern = '^[A-Za-z0-9._/-]+\z';              Hint = 'a git tag, branch or commit' },
    @{ Name = 'PUBLIC_IP';           Required = $false; Pattern = '^[0-9]{1,3}(\.[0-9]{1,3}){3}\z';   Hint = 'an IPv4 address such as 203.0.113.7' },
    @{ Name = 'GRID_PRIVATE_KEY';    Required = $false; Pattern = '^0x[0-9a-fA-F]{64}\z';             Hint = '0x followed by 64 hexadecimal characters'; Secret = $true }
  )
  foreach ($rule in $rules) {
    $value = [Environment]::GetEnvironmentVariable($rule.Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
      if ($rule.Required) {
        [void]$problems.Add("set $($rule.Name) to $($rule.Hint). In PowerShell: `$env:$($rule.Name) = 'https://node1.example.com'")
      }
      continue
    }
    $value = $value.Trim()
    if ($value -notmatch $rule.Pattern) {
      [void]$problems.Add("$($rule.Name) must be $($rule.Hint)")
      continue
    }
    [Environment]::SetEnvironmentVariable($rule.Name, $value)
    if ($rule.ContainsKey('Secret')) { Note "$($rule.Name) is set (it will be imported; the value is never shown)" }
    else { Note "$($rule.Name) = $value" }
  }
  $known = $PassThrough + @('GRID_PRIVATE_KEY')
  foreach ($item in (Get-ChildItem Env: | Where-Object { $_.Name -like 'GRID_*' -and $known -notcontains $_.Name })) {
    Warn "$($item.Name) is not read by the installer. Put it in /opt/grid/node/.env inside Ubuntu afterwards."
  }
  return $problems
}

# --------------------------------------------------------------------------------------------------
# Installing
# --------------------------------------------------------------------------------------------------

function Install-Wsl {
  Step "WSL2 and $Distro"
  $existing = Get-InstalledDistro
  $script:DistroWasNew = $false
  if (-not $existing) {
    Note "installing WSL and $Distro (a download of a few hundred megabytes; several minutes)"
    $r = Invoke-Exe -File $Wsl -Arguments @('--install', '-d', $Distro, '--no-launch') -Stream
    $existing = Get-InstalledDistro
    if (-not $existing) {
      # Some WSL builds register the distro only when its launcher first runs; --root skips the user prompt.
      $launcher = Get-Command 'ubuntu2404.exe' -ErrorAction SilentlyContinue
      if ($launcher) {
        Note 'registering the distro through its launcher'
        [void](Invoke-Exe -File $launcher.Source -Arguments @('install', '--root') -Stream)
        $existing = Get-InstalledDistro
      }
    }
    if (-not $existing) {
      if ($r.ExitCode -eq 3010 -or $r.Text -match '(?i)reboot|restart' -or (Test-RebootPending)) {
        throw "GRIDREBOOT: Windows has to restart before WSL can finish installing. Restart now, then run the same command again; it continues from here."
      }
      Fail "wsl --install did not finish (exit code $($r.ExitCode)); read the messages above. You can try 'wsl --install -d $Distro' by hand, then run this again."
    }
    $script:DistroWasNew = $true
    Note "$Distro is installed"
  } else {
    Note "$Distro is installed (WSL $($existing.Version))"
  }

  if ($existing.Version -eq 1) {
    Note 'converting the distro to WSL 2 (a few minutes)'
    $r = Invoke-Exe -File $Wsl -Arguments @('--set-version', $Distro, '2') -Stream
    if ($r.ExitCode -ne 0) { Fail "could not convert $Distro to WSL 2 (exit code $($r.ExitCode))" }
  }

  $v = Get-WslVersion
  if (-not $v -or $v -lt [version]'2.0.0') {
    Note 'updating WSL (systemd and the network settings need a current version)'
    $r = Invoke-Exe -File $Wsl -Arguments @('--update') -Stream
    if ($r.ExitCode -ne 0) { $r = Invoke-Exe -File $Wsl -Arguments @('--update', '--web-download') -Stream }
    $v = Get-WslVersion
  }
  if (-not $v) { Fail "WSL is too old and could not be updated. Run 'wsl --update' by hand (or install the current WSL from github.com/microsoft/WSL/releases), then run this again." }
  $script:WslVersion = $v
  Note "WSL $v"

  # Start the distro once. Right after WSL's Windows features are switched on, this fails until Windows restarts.
  $boot = Invoke-Wsl -Script 'true'
  if ($boot.ExitCode -ne 0) {
    if ($boot.Text -match '0x80370102') {
      Fail 'virtualization is switched off in the firmware. Restart into the BIOS/UEFI setup, turn on Intel VT-x (or SVM Mode on AMD), then run this again.'
    }
    if ($boot.Text -match '(?i)virtual machine platform|0x8007019e|0x80370114|reboot|restart' -or (Test-RebootPending)) {
      throw "GRIDREBOOT: Windows has to restart before WSL can run. Restart now, then run the same command again; it continues from here."
    }
    Fail "$Distro did not start (exit code $($boot.ExitCode)): $($boot.Text)"
  }
}

# Returns $true when the file changed.
function Set-WslConfig {
  $path = Join-Path $env:USERPROFILE '.wslconfig'
  $old = ''
  if (Test-Path -LiteralPath $path) { $old = [System.IO.File]::ReadAllText($path) }
  $new = Set-IniValue -Text $old -Section 'wsl2' -Key 'networkingMode' -Value 'mirrored'
  if ((Format-Ini $old) -eq $new) { return $false }
  if ($old.Length -gt 0) { Copy-Item -LiteralPath $path -Destination "$path.grid-backup" -Force }
  [System.IO.File]::WriteAllText($path, $new.Replace("`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

function Set-NetworkMode {
  Step 'How Windows reaches Ubuntu (TCP 2222 and 4001)'
  if ($script:Build -ge 22621) {
    $script:Mode = 'mirrored'
    Note 'Windows 11 22H2 or newer: using mirrored networking, so Ubuntu shares this PC''s network and the ports reach it directly'
    if (Set-WslConfig) {
      $script:ConfigChanged = $true
      Note "set networkingMode=mirrored in $(Join-Path $env:USERPROFILE '.wslconfig') (the old file, if any, is kept as .wslconfig.grid-backup)"
    } else {
      Note 'networkingMode=mirrored is already set'
    }
  } else {
    $script:Mode = 'portproxy'
    Warn "this Windows build ($script:Build) cannot use mirrored networking (it needs Windows 11 22H2, build 22621). Using the fallback: 'netsh interface portproxy' rules plus a Windows Firewall rule."
    Note 'Ubuntu gets a new internal address every time it starts, so the startup task refreshes the rules at each logon.'
  }
}

$ConfBootstrap = @'
cat /etc/wsl.conf 2>/dev/null || true
'@

$PrepScript = @'
export DEBIAN_FRONTEND=noninteractive
echo "set up by Grid host-setup.ps1" > /etc/grid-wsl-setup

if ! id "$SETUP_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups sudo "$SETUP_USER"
  echo "   created the user $SETUP_USER (no password; for admin work use: wsl -d $DISTRO -u root)"
fi
# The setup runs sudo many times without a terminal, so the user may use it without a password while
# this script runs. The file is removed again when the script ends.
tmp="$(mktemp)"
{
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$SETUP_USER"
  printf 'Defaults:%s env_keep += "DEBIAN_FRONTEND NEEDRESTART_MODE"\n' "$SETUP_USER"
} > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/90-grid-setup
rm -f "$tmp"

apt-get update -qq
apt-get install -y -qq ca-certificates curl git >/dev/null

if [ ! -e /usr/lib/wsl/lib/nvidia-smi ]; then
  echo "   Ubuntu does not see the GPU: /usr/lib/wsl/lib/nvidia-smi is missing." >&2
  exit 20
fi
# The node runs nvidia-smi from a systemd service whose PATH does not include /usr/lib/wsl/lib.
ln -sf /usr/lib/wsl/lib/nvidia-smi /usr/local/bin/nvidia-smi
nvidia-smi -L >/tmp/grid-gpu.txt 2>&1 || { cat /tmp/grid-gpu.txt >&2; exit 21; }
sed 's/^/   GPU in Ubuntu: /' /tmp/grid-gpu.txt
rm -f /tmp/grid-gpu.txt
'@

$WriteConfScript = @'
printf '%s' "$CONF_B64" | base64 -d > /etc/wsl.conf
'@

$SystemdScript = @'
for i in $(seq 1 30); do
  [ "$(cat /proc/1/comm)" = systemd ] && break
  sleep 1
done
[ "$(cat /proc/1/comm)" = systemd ] || exit 30
timeout 120 systemctl is-system-running --wait >/dev/null 2>&1 || true
'@

function Initialize-Distro {
  Step "Preparing $Distro"

  if (-not $script:DistroWasNew) {
    $marker = Invoke-Wsl -Script 'test -f /etc/grid-wsl-setup'
    if ($marker.ExitCode -ne 0) {
      Warn "$Distro was already installed here and was not set up by this script."
      Note 'The node runs strangers'' jobs in Docker inside this distro. To do that, this script will'
      Note "create the user $SetupUser, turn on systemd, and turn off the mounting of your Windows drives"
      Note 'and the launching of Windows programs from inside it. It installs Docker there and runs the node.'
      if (-not (Confirm-Yes "Use the existing $Distro for the Grid node?")) {
        Fail "stopped without changing $Distro. To keep your own Ubuntu separate, export it first (wsl --export $Distro backup.tar), remove it (wsl --unregister $Distro), and run this again to get a fresh one."
      }
    }
  }

  $r = Invoke-Wsl -Script $PrepScript -Vars @{ SETUP_USER = $SetupUser; DISTRO = $Distro } -Stream
  if ($r.ExitCode -eq 20) {
    Fail "Ubuntu cannot see the GPU. Make sure the NVIDIA driver on Windows is 570 or newer (restart after updating it), run 'wsl --update', then run this again."
  }
  if ($r.ExitCode -ne 0) { Fail "preparing $Distro failed (exit code $($r.ExitCode)); read the messages above, then run this again." }

  $currentConf = (Invoke-Wsl -Script $ConfBootstrap).Text
  $conf = $currentConf
  foreach ($setting in @(
      @('boot', 'systemd', 'true'),
      @('automount', 'enabled', 'false'),
      @('interop', 'enabled', 'false'),
      @('interop', 'appendWindowsPath', 'false'),
      @('user', 'default', $SetupUser))) {
    $conf = Set-IniValue -Text $conf -Section $setting[0] -Key $setting[1] -Value $setting[2]
  }
  if ((Format-Ini $currentConf) -ne $conf) {
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($conf))
    $w = Invoke-Wsl -Script $WriteConfScript -Vars @{ CONF_B64 = $b64 }
    if ($w.ExitCode -ne 0) { Fail "could not write /etc/wsl.conf in $Distro" }
    $script:ConfigChanged = $true
    Note '/etc/wsl.conf: systemd on; Windows drives and Windows programs off inside Ubuntu'
  } else {
    Note '/etc/wsl.conf is already right'
  }

  $needsRestart = $script:ConfigChanged
  if (-not $needsRestart) {
    $init = Invoke-Wsl -Script 'test "$(cat /proc/1/comm)" = systemd'
    if ($init.ExitCode -ne 0) { $needsRestart = $true }
  }
  if ($needsRestart) {
    Note 'restarting WSL so the settings apply (this stops every WSL distribution on this PC)'
    [void](Invoke-Exe -File $Wsl -Arguments @('--shutdown'))
    Start-Sleep -Seconds 8
    $up = $null
    foreach ($attempt in 1..5) {
      $up = Invoke-Wsl -Script 'true'
      if ($up.ExitCode -eq 0) { break }
      Start-Sleep -Seconds 4
    }
    if ($up.ExitCode -ne 0) { Fail "$Distro did not start again after the restart. Run 'wsl --shutdown', then run this again." }
  }
  $sd = Invoke-Wsl -Script $SystemdScript
  if ($sd.ExitCode -ne 0) {
    Fail "systemd is not running in $Distro. Check that /etc/wsl.conf has [boot] systemd=true, that 'wsl --version' works (run 'wsl --update' if not), and run 'wsl --shutdown' before trying again."
  }
  Note 'systemd is running'
}

function Open-WindowsPorts {
  Step 'Windows firewall and port rules'
  $portList = $Ports -join ' and '
  if ($script:Mode -eq 'mirrored') {
    try {
      if (Get-NetFirewallHyperVRule -Name $HyperVRule -ErrorAction SilentlyContinue) {
        Remove-NetFirewallHyperVRule -Name $HyperVRule -ErrorAction SilentlyContinue
      }
      New-NetFirewallHyperVRule -Name $HyperVRule -DisplayName 'Grid node (renter SSH and peer to peer)' `
        -Direction Inbound -VMCreatorId $HyperVCreator -Protocol TCP -LocalPorts $Ports | Out-Null
      Note "Hyper-V firewall rule '$HyperVRule': inbound TCP $portList may reach Ubuntu (WSL blocks inbound traffic from the network by default)"
    } catch {
      Warn "could not add the Hyper-V firewall rule: $($_.Exception.Message)"
      Note "Add it by hand in an administrator PowerShell, or renters cannot connect:"
      Note "New-NetFirewallHyperVRule -Name $HyperVRule -DisplayName 'Grid node' -Direction Inbound -VMCreatorId '$HyperVCreator' -Protocol TCP -LocalPorts 2222,4001"
    }
  } else {
    $ip = ((Invoke-Wsl -Script 'hostname -I').Text.Trim() -split '\s+')[0]
    if ($ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Fail 'could not read the address of Ubuntu inside WSL, which the port rules need.' }
    foreach ($p in $Ports) {
      & netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$p 2>&1 | Out-Null
      & netsh.exe interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$p connectaddress=$ip connectport=$p | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "netsh could not add the port rule for $p" }
    }
    if (Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $FirewallRule }
    New-NetFirewallRule -Name $FirewallRule -DisplayName 'Grid node (renter SSH and peer to peer)' -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort $Ports -Profile Any | Out-Null
    Note "portproxy: Windows TCP $portList -> Ubuntu at $ip (refreshed at every logon)"
    Note "Windows Firewall rule '$FirewallRule': inbound TCP $portList allowed on every network profile"
  }
}

$RunScript = @'
home="$(getent passwd "$(id -un)" | cut -d: -f6)"
src="$home/grid-setup"
rm -rf "$src"
git clone --quiet "$REPO_URL" "$src"
ref="${GRID_REF:-main}"
git -C "$src" checkout --quiet "$ref"
echo "   host-setup.sh from $(git -C "$src" log -1 --format=%h) ($ref)"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
exec bash "$src/scripts/host-setup.sh"
'@

$TunnelCheckScript = @'
if [ -f /etc/cloudflared/config.yml ] && grep -q "hostname: $TUNNEL_HOST" /etc/cloudflared/config.yml; then
  echo ready
else
  echo pending
fi
'@

function Invoke-HostSetupPass {
  # GRID_* settings reach the Linux side through WSLENV; the wallet key is not among them.
  $names = @($PassThrough | Where-Object { -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
  $env:WSLENV = ($names -join ':')
  $r = Invoke-Wsl -User $SetupUser -Vars @{ REPO_URL = $RepoUrl } -Script $RunScript -Stdin '' -Stream
  if ($r.ExitCode -ne 0) {
    Fail "host-setup.sh stopped (exit code $($r.ExitCode)). The messages above say why. Fix that and run this script again; it continues where it stopped."
  }
}

function Invoke-HostSetup {
  Step 'Installing the Grid node (scripts/host-setup.sh, from a fresh clone)'
  Note 'This installs Docker Engine, the NVIDIA Container Toolkit, Node.js and cloudflared inside Ubuntu.'
  Note 'The first run takes a while and prints a lot.'
  Invoke-HostSetupPass

  $tunnelHost = $env:GRID_PUBLIC_URL -replace '^https://', ''
  $t = Invoke-Wsl -Vars @{ TUNNEL_HOST = $tunnelHost } -Script $TunnelCheckScript
  if ($t.Text -match 'ready') { $script:TunnelReady = $true; return }

  Step "Cloudflare tunnel for $($env:GRID_PUBLIC_URL)"
  Note 'The tunnel gives the node its https address. Creating it needs one login to the Cloudflare account'
  Note "that owns the domain of $tunnelHost; you open a link in your browser and approve."
  if (Confirm-Yes 'Log in to Cloudflare now?' -DefaultYes) {
    Note 'Open the link that appears below, choose the zone that holds the hostname, and approve.'
    $login = Invoke-Wsl -User $SetupUser -Script 'cloudflared tunnel login' -Stream
    if ($login.ExitCode -eq 0) {
      Note 'logged in; running host-setup.sh again to create the tunnel'
      Invoke-HostSetupPass
      $t = Invoke-Wsl -Vars @{ TUNNEL_HOST = $tunnelHost } -Script $TunnelCheckScript
      if ($t.Text -match 'ready') { $script:TunnelReady = $true }
    } else {
      Warn "the Cloudflare login did not finish (exit code $($login.ExitCode))."
    }
  }
  if (-not $script:TunnelReady) {
    Note "Later: wsl -d $Distro -u $SetupUser -- cloudflared tunnel login"
    Note 'then run this script again.'
  }
}

$KeyImportScript = @'
IFS= read -r key || true
key="$(printf '%s' "$key" | tr -d '\r\n ')"
printf '%s' "$key" | grep -Eq '^0x[0-9a-fA-F]{64}$' || { echo "not a valid key" >&2; exit 2; }
envfile=/opt/grid/node/.env
[ -f "$envfile" ] || { echo "$envfile does not exist yet" >&2; exit 3; }
current="$(grep -m1 '^GRID_PRIVATE_KEY=' "$envfile" | cut -d= -f2 || true)"
if [ "$current" = "$key" ]; then
  echo same
  exit 0
fi
cp -p "$envfile" "$envfile.before-key-import"
sed -i "s/^GRID_PRIVATE_KEY=.*/GRID_PRIVATE_KEY=$key/" "$envfile"
chown grid:grid "$envfile"
chmod 600 "$envfile"
if systemctl is-active --quiet grid-node; then systemctl restart grid-node; fi
echo changed
'@

$AddressScript = @'
envfile=/opt/grid/node/.env
[ -r "$envfile" ] || exit 0
key="$(grep -m1 '^GRID_PRIVATE_KEY=' "$envfile" | cut -d= -f2)"
cd /opt/grid
GRID_KEY="$key" sudo -u grid --preserve-env=GRID_KEY -H node --input-type=module -e 'import { privateKeyToAccount } from "viem/accounts"; console.log(privateKeyToAccount(process.env.GRID_KEY).address)'
'@

function Import-HostKey {
  $key = $env:GRID_PRIVATE_KEY
  if ([string]::IsNullOrWhiteSpace($key)) { return }
  Step 'Host wallet from GRID_PRIVATE_KEY'
  $r = Invoke-Wsl -Script $KeyImportScript -Stdin $key
  switch -Regex ($r.Text) {
    'same' { Note 'node/.env already uses this wallet' }
    'changed' {
      Note 'node/.env now uses the wallet you supplied, and the node was restarted'
      Note 'The file it replaced is /opt/grid/node/.env.before-key-import inside Ubuntu (it holds the generated wallet''s key).'
      Note 'Delete it once you are sure you do not need that wallet.'
    }
    default { Fail "could not import GRID_PRIVATE_KEY (exit code $($r.ExitCode)). The key was not written." }
  }
}

function Get-HostAddress {
  $r = Invoke-Wsl -Script $AddressScript
  if ($r.ExitCode -eq 0 -and $r.Text -match '(0x[0-9a-fA-F]{40})') { return $Matches[1] }
  return ''
}

function Remove-SetupSudo {
  try { [void](Invoke-Wsl -Script 'rm -f /etc/sudoers.d/90-grid-setup') } catch { }
}

$StartTemplate = @'
# Written by host-setup.ps1 and run by the scheduled task "Grid node (WSL)" at logon.
# It starts the Ubuntu distro (which boots systemd and with it the grid-node service), keeps it
# running, and in portproxy mode points the Windows port rules at the distro's current address.
$Distro = '__DISTRO__'
$Mode = '__MODE__'
$Ports = @(__PORTS__)
$Wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
while ($true) {
  & $Wsl -d $Distro -u root --exec /bin/true
  if ($Mode -eq 'portproxy') {
    $ip = ((& $Wsl -d $Distro -u root --exec hostname -I) -join ' ').Trim().Split(' ')[0]
    if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$') {
      foreach ($p in $Ports) {
        & netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$p | Out-Null
        & netsh.exe interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$p connectaddress=$ip connectport=$p | Out-Null
      }
    }
  }
  # A running wsl.exe keeps the distro, and the node inside it, alive until this task is stopped.
  & $Wsl -d $Distro -u root --exec /usr/bin/sleep infinity
  Start-Sleep -Seconds 15
}
'@

function New-StartScriptText {
  return $StartTemplate.Replace('__DISTRO__', $Distro).Replace('__MODE__', $script:Mode).Replace('__PORTS__', ($Ports -join ', '))
}

function Register-StartupTask {
  Step 'Starting the node at every logon'
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  # The task may run elevated (portproxy mode), so only administrators may change what it runs.
  & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  $text = (New-StartScriptText).Replace("`r`n", "`n").Replace("`n", "`r`n")
  [System.IO.File]::WriteAllText($StartScript, $text, (New-Object System.Text.UTF8Encoding($false)))

  $user = "$($env:USERDOMAIN)\$($env:USERNAME)"
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $runLevel = if ($script:Mode -eq 'portproxy') { 'Highest' } else { 'Limited' }
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $runLevel
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts the Ubuntu distro that runs the Grid node and keeps it running while you are signed in.' -Force | Out-Null
  Note "registered the task '$TaskName' for $user (runs at logon, hidden, $runLevel privileges)"

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' }) {
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
  }
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  Note "task state: $state (it keeps Ubuntu running from now on, without waiting for the next logon)"
}

function Show-Summary {
  Step 'Done'
  $script:HostAddress = Get-HostAddress
  $lan = Get-LanAddress
  $url = $env:GRID_PUBLIC_URL
  Note "Network: $(if ($script:Mode -eq 'mirrored') { 'mirrored (Ubuntu shares this PC''s network)' } else { 'netsh portproxy fallback' })"
  if ($script:HostAddress) { Note "Host wallet: $($script:HostAddress)" }
  Write-Host ''
  Note 'Still needed:'
  if ($script:HostAddress) { Note "  - test ETH for $($script:HostAddress); it pays for listing the machine" }
  $lanText = if ($lan) { "this PC ($lan, give it a fixed address in the router)" } else { 'this PC' }
  Note "  - on the router, forward TCP 2222 and 4001 to $lanText"
  Note '    (do not forward 7777: the API stays on this machine and is reached through the tunnel)'
  if (-not $script:TunnelReady) { Note "  - the Cloudflare tunnel for ${url}: wsl -d $Distro -u $SetupUser -- cloudflared tunnel login, then run this script again" }
  Write-Host ''
  Note 'Check that it works:'
  Note "  wsl -d $Distro -- systemctl status grid-node --no-pager"
  Note "  wsl -d $Distro -u root -- journalctl -u grid-node -f"
  Note "  curl.exe $url/health"
  Note "  Get-ScheduledTask -TaskName '$TaskName'"
  Write-Host ''
  Note 'Keep in mind:'
  Note '  - Ubuntu runs only while you are signed in to Windows. Signing out stops the node; locking the screen does not.'
  Note '  - Stop Windows from sleeping while it hosts (Settings, System, Power), and sign back in after a Windows Update restart.'
  Note '  - Games and renters share the GPU. WSL2 passes it through for CUDA only.'
  Note "  - Administer Ubuntu as root: wsl -d $Distro -u root. Update the node: run this script again."
  Note '  - Stop hosting: Stop-ScheduledTask, then wsl --terminate. Remove everything: run this script with -Uninstall.'
}

function Show-CheckOnly {
  Step 'What is installed here'
  $v = Get-WslVersion
  if ($v) { Note "WSL $v" } else { Note 'WSL is not installed (or only the old built-in one is); the script would install or update it' }
  $d = Get-InstalledDistro
  if ($d) { Note "$Distro is installed (WSL $($d.Version))" } else { Note "$Distro is not installed; the script would install it" }
  $how = if ($script:Build -ge 22621) { 'mirrored networking' } else { 'netsh portproxy rules (this Windows build cannot do mirrored networking)' }
  Note "TCP 2222 and 4001 would reach Ubuntu through $how"
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Note "the startup task '$TaskName' exists" } else { Note "the startup task '$TaskName' would be created" }
  Write-Host ''
  Note 'Nothing was changed.'
}

function Invoke-Install {
  Step 'Checking this PC and the settings'
  $problems = @(Test-ThisPc) + @(Get-HostSettings)
  if ($problems.Count -gt 0) {
    if ($CheckOnly) {
      $script:CheckProblems = $problems.Count
      foreach ($p in $problems) { Warn $p }
    } else {
      Fail ("fix these and run it again:`n   - " + ($problems -join "`n   - "))
    }
  }
  if ($CheckOnly) { Show-CheckOnly; return }

  Install-Wsl
  Set-NetworkMode
  Initialize-Distro
  Open-WindowsPorts
  try {
    Invoke-HostSetup
    Import-HostKey
  } finally {
    Remove-SetupSudo
  }
  Register-StartupTask
  Show-Summary
}

# --------------------------------------------------------------------------------------------------
# Uninstalling
# --------------------------------------------------------------------------------------------------

function Invoke-Uninstall {
  Step 'Removing the Grid startup task and the Windows port and firewall rules'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'this needs an administrator PowerShell. Right-click the Start button, choose Terminal (Admin), and run it again.'
  }

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Note "removed the task '$TaskName'"
  } else {
    Note "no task '$TaskName'"
  }
  # Stopping the task should end the keep-alive wsl.exe too; make sure.
  Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*sleep infinity*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  foreach ($p in $Ports) {
    & netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$p 2>&1 | Out-Null
  }
  Note 'removed the netsh portproxy rules for 2222 and 4001 (if there were any)'

  if (Get-NetFirewallRule -Name $FirewallRule -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -Name $FirewallRule
    Note "removed the firewall rule '$FirewallRule'"
  }
  try {
    if (Get-NetFirewallHyperVRule -Name $HyperVRule -ErrorAction SilentlyContinue) {
      Remove-NetFirewallHyperVRule -Name $HyperVRule
      Note "removed the Hyper-V firewall rule '$HyperVRule'"
    }
  } catch { }
  if (Test-Path -LiteralPath $DataDir) {
    Remove-Item -LiteralPath $DataDir -Recurse -Force
    Note "removed $DataDir"
  }

  Step 'What is left'
  Note "Ubuntu ($Distro) and the node inside it are still there, and the node runs while Ubuntu does."
  Note "Stop it now:      wsl --terminate $Distro"
  Note "Remove it for good: wsl --unregister $Distro"
  Note '   That deletes the host wallet key in /opt/grid/node/.env and any unsettled work. First collect earnings'
  Note "   from the Host page and save the key. To keep a copy of everything: wsl --export $Distro grid-backup.tar"
  $wslConfigPath = Join-Path $env:USERPROFILE '.wslconfig'
  if ((Test-Path -LiteralPath $wslConfigPath) -and ([System.IO.File]::ReadAllText($wslConfigPath) -match '(?im)^\s*networkingMode\s*=\s*mirrored')) {
    Note "The file $wslConfigPath keeps networkingMode=mirrored (the old one, if there was one, is .wslconfig.grid-backup). Edit it if you do not want that."
  }
}

# --------------------------------------------------------------------------------------------------

$savedEncoding = $null
try {
  $savedEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }
$savedWslUtf8 = $env:WSL_UTF8
$savedWslEnv = $env:WSLENV
$env:WSL_UTF8 = '1'
$exitCode = 0
try {
  if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
  if ($CheckOnly -and $script:CheckProblems -gt 0) { $exitCode = 1 }
} catch {
  $message = $_.Exception.Message
  Write-Host ''
  if ($message -like 'GRIDREBOOT:*') {
    Write-Host ($message -replace '^GRIDREBOOT:\s*', '') -ForegroundColor Yellow
    $exitCode = 3010
  } elseif ($message -like 'GRIDSTOP:*') {
    Write-Host ('stopped: ' + ($message -replace '^GRIDSTOP:\s*', '')) -ForegroundColor Red
    $exitCode = 1
  } else {
    Write-Host "stopped by an unexpected error: $message" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace
    $exitCode = 1
  }
} finally {
  $env:WSL_UTF8 = $savedWslUtf8
  $env:WSLENV = $savedWslEnv
  if ($savedEncoding) { try { [Console]::OutputEncoding = $savedEncoding } catch { } }
}
exit $exitCode
