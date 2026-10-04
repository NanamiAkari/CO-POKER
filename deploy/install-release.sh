#!/usr/bin/env bash
set -Eeuo pipefail

archive_path="${1:?release archive is required}"
release_id="${2:?release id is required}"
app_root="${APP_ROOT:-/opt/cooperative-poker}"
release_root="$app_root/.deploy/releases/$release_id"
staging="$release_root/staging"
backup="$release_root/backup"

case "$app_root" in /opt/cooperative-poker) ;; *) echo 'Unexpected application root' >&2; exit 20 ;; esac
test -f "$archive_path"
test -d "$app_root"
mkdir -p "$release_root" "$staging" "$backup"
tar -xzf "$archive_path" -C "$staging"
test -f "$staging/package.json"
test -f "$staging/package-lock.json"
test -f "$staging/src/server.js"
test -f "$staging/public/index.html"

cp -a "$app_root/src" "$backup/src"
cp -a "$app_root/public" "$backup/public"
cp -f "$app_root/package.json" "$backup/package.json"
cp -f "$app_root/package-lock.json" "$backup/package-lock.json"

rollback() {
  status=$?
  trap - ERR
  set +e
  cp -a "$backup/src/." "$app_root/src/"
  cp -a "$backup/public/." "$app_root/public/"
  [ -f "$backup/package.json" ] && cp -f "$backup/package.json" "$app_root/package.json"
  [ -f "$backup/package-lock.json" ] && cp -f "$backup/package-lock.json" "$app_root/package-lock.json"
  pm2 restart cooperative-poker --update-env >/dev/null 2>&1 || true
  echo "Release failed; backup retained at $backup" >&2
  exit "$status"
}
trap rollback ERR

cp -a "$staging/src/." "$app_root/src/"
cp -a "$staging/public/." "$app_root/public/"
cp -f "$staging/package.json" "$app_root/package.json"
cp -f "$staging/package-lock.json" "$app_root/package-lock.json"
cp -f "$staging/ecosystem.config.cjs" "$app_root/ecosystem.config.cjs"

cd "$app_root"
npm ci --omit=dev
pm2 restart cooperative-poker --update-env
pm2 save
curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-connrefused --max-time 10 http://127.0.0.1:3000/health
trap - ERR
echo "Release installed: $release_id"
echo "Backup retained: $backup"
