# Preview by default. Add -Execute to publish; add -IncludeSource only when a
# server restart and the loss of in-memory rooms are acceptable.
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$TargetHost = '101.132.136.52',
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\poker_server_key'),
    [switch]$IncludeSource,
    [switch]$Execute
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$payloadRoots = @('public')
if ($IncludeSource) { $payloadRoots += 'src' }
$relativeFiles = @(
    foreach ($root in $payloadRoots) {
        $base = Join-Path $workspace $root
        $entries = @(Get-Item -LiteralPath $base) + @(Get-ChildItem -LiteralPath $base -Recurse -Force)
        foreach ($entry in $entries) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Symlinks/junctions are not included in a release: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { continue }
            $relative = $entry.FullName.Substring($workspace.Length + 1).Replace('\', '/')
            if ($relative -notmatch '^(public|src)/[A-Za-z0-9_./-]+$' -or $relative.Contains('/../')) {
                throw "Unsupported release filename: $relative"
            }
            $relative
        }
    }
) | Sort-Object

Write-Host "Target: root@${TargetHost}:22 /opt/cooperative-poker"
Write-Host "Payload roots: $($payloadRoots -join ', '); files: $($relativeFiles.Count)"
Write-Host 'The release preserves directories, keeps a remote src/public backup, and checks SHA-256 before and after installation.'
Write-Host 'No files are deleted. Dependency changes are not installed by this script.'
if ($IncludeSource) {
    Write-Host 'Source changes require a PM2 restart and reset in-memory rooms; active room count is not available from the current health endpoint.'
} else {
    Write-Host 'Frontend-only release: the running game process is not restarted.'
}
if (-not $Execute) {
    $relativeFiles | ForEach-Object { Write-Output $_ }
    Write-Host 'Preview only. No network connection or deployment was performed. Use -Execute to publish.'
    return
}

foreach ($tool in @('ssh', 'scp', 'tar', 'npm')) { $null = Get-Command $tool -ErrorAction Stop }
$identity = (Resolve-Path -LiteralPath $KeyPath).Path
$sshOptions = @('-i', $identity, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes')
$destination = "root@$TargetHost"

Push-Location $workspace
try {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'Local tests failed; nothing was published.' }
} finally { Pop-Location }

$releaseId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$staging = Join-Path ([IO.Path]::GetTempPath()) "poker-release-$releaseId"
$null = New-Item -ItemType Directory -Path $staging
$hashLines = foreach ($relative in $relativeFiles) {
    $snapshotPath = Join-Path $staging $relative
    $null = New-Item -ItemType Directory -Path (Split-Path $snapshotPath) -Force
    Copy-Item -LiteralPath (Join-Path $workspace $relative) -Destination $snapshotPath
    $digest = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$digest  $relative"
}
[IO.File]::WriteAllText((Join-Path $staging 'SHA256SUMS'), ($hashLines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
$archive = Join-Path $staging 'release.tar.gz'
& tar -czf $archive -C $staging @payloadRoots SHA256SUMS
if ($LASTEXITCODE -ne 0) { throw "Failed to package release; snapshot retained at $staging" }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$packageHash = (Get-FileHash -LiteralPath (Join-Path $workspace 'package.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$lockHash = (Get-FileHash -LiteralPath (Join-Path $workspace 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$remoteRelease = "/opt/cooperative-poker/.deploy/releases/$releaseId"

# Fixed, validated paths only; no interpolation of arbitrary remote shell text.
& ssh @sshOptions $destination "umask 077; mkdir -p -- '$remoteRelease'"
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare remote staging directory.' }
& scp @sshOptions $archive "${destination}:$remoteRelease/release.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Archive upload failed; the running application was not changed.' }
$sourceFlag = if ($IncludeSource) { '1' } else { '0' }
$remoteScript = @'
set -Eeuo pipefail
app=/opt/cooperative-poker
release=$1
with_source=$2
archive_hash=$3
package_hash=$4
lock_hash=$5
case "$release" in /opt/cooperative-poker/.deploy/releases/*) ;; *) exit 20 ;; esac
test "$(readlink -f "$app")" = "$app"
test -d "$app/public"
test -d "$app/src"
exec 9>"$app/.deploy/publish.lock"
flock -n 9 || { echo 'Another publish is running; try again after it completes.' >&2; exit 24; }
test -S /root/.pm2/rpc.sock
kill -0 "$(cat /root/.pm2/pm2.pid)"
printf '%s  %s\n' "$archive_hash" "$release/release.tar.gz" | sha256sum --check --status
mkdir "$release/payload"
tar -xzf "$release/release.tar.gz" -C "$release/payload"
cd "$release/payload"
sha256sum --check --status SHA256SUMS
if [ "$with_source" = 1 ]; then
  printf '%s  %s\n%s  %s\n' "$package_hash" "$app/package.json" "$lock_hash" "$app/package-lock.json" | sha256sum --check --status || {
    echo 'Dependencies differ; prepare a separate dependency release before publishing source.' >&2
    exit 21
  }
fi
source_changed=0
declare -a changed=()
while read -r hash file; do
  case "$file" in public/*) ;; src/*) test "$with_source" = 1 ;; *) exit 22 ;; esac
  case "$file" in *..*) echo 'Unexpected path' >&2; exit 23 ;; esac
  test "$(realpath -m "$app/$file")" = "$app/$file"
  if ! test -f "$app/$file" || ! cmp -s -- "$file" "$app/$file"; then
    changed+=("$file")
    case "$file" in src/*) source_changed=1 ;; esac
  fi
done < SHA256SUMS
if [ "${#changed[@]}" = 0 ]; then
  echo 'Release is unchanged; no files were written and no restart was performed.'
  exit 0
fi
mkdir "$release/backup"
cp -a -- "$app/src" "$app/public" "$release/backup/"
echo "Backup: $release/backup"
rollback() {
  result=$?
  trap - ERR
  set +e
  echo 'Publish failed; restoring backed-up src/public. New unused asset files may remain.' >&2
  cp -a "$release/backup/src/." "$app/src/"
  cp -a "$release/backup/public/." "$app/public/"
  if [ "$source_changed" = 1 ]; then pm2 restart cooperative-poker --update-env; fi
  echo "Recovery snapshot retained at $release/backup" >&2
  exit "$result"
}
trap rollback ERR
install_file() {
  local file=$1
  local temp="$app/$file.publish-tmp"
  mkdir -p -- "$(dirname "$app/$file")"
  install -m 644 -- "$file" "$temp"
  mv -f -- "$temp" "$app/$file"
  printf 'Published: %s\n' "$file"
}
# Entry HTML is installed last, after its referenced resources are available.
for file in "${changed[@]}"; do
  if [ "$file" != public/index.html ]; then install_file "$file"; fi
done
for file in "${changed[@]}"; do
  if [ "$file" = public/index.html ]; then install_file "$file"; fi
done
(cd "$app" && sha256sum --check --status "$release/payload/SHA256SUMS")
if [ "$source_changed" = 1 ]; then
  pm2 restart cooperative-poker --update-env
  pm2 save
else
  echo 'Frontend updated without restarting the game process.'
fi
curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-connrefused --max-time 10 http://127.0.0.1:3000/health
trap - ERR
printf '\nRelease verified. Backup: %s/backup\n' "$release"
'@

$remoteScript.Replace("`r", '') | & ssh @sshOptions $destination "bash -s -- '$remoteRelease' '$sourceFlag' '$archiveHash' '$packageHash' '$lockHash'"
if ($LASTEXITCODE -ne 0) { throw "Deployment failed. Review the remote log; recovery data is in $remoteRelease. Local snapshot: $staging" }
Write-Host "Verified release: $remoteRelease"
Write-Host "Local snapshot retained: $staging"
