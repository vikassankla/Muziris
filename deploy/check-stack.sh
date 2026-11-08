#!/usr/bin/env bash
# Checks a running pilot install (ADR 0029) from the VM itself: HTTPS and the HTTP redirect, the
# apps' headers, which paths reach the API, that the API's port is not published, and that the
# latest backup restores. CI runs it against Caddy's own certificates (CADDY_TEST_OPTIONS).
#
#   sudo deploy/check-stack.sh
#
# It reads the hostnames and the backup folder from the same env file as deploy/muziris, and
# prints no value from it but those.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
env_file=${MUZIRIS_ENV_FILE:-/etc/muziris/muziris.env}
setting() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }
admin=$(setting ADMIN_DOMAIN)
shop=$(setting STOREFRONT_DOMAIN)
backups=$(setting BACKUP_DIR)
backups=${backups:-/var/backups/muziris}
compose() { "$here/muziris" "$@"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok      $1"; }
fail() {
  echo "FAILED  $1" >&2
  failures=$((failures + 1))
}

# With Caddy's own certificate authority, trust its root; otherwise the system's (Let's Encrypt).
ca=()
if grep -q '^CADDY_TEST_OPTIONS=.*local_certs' "$env_file"; then
  compose exec -T edge cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt"
  ca=(--cacert "$work/root.crt")
fi

# fetch NAME URL [curl options...]: saves NAME.headers and NAME.body, prints the status code.
fetch() {
  local name=$1 url=$2
  shift 2
  curl -sS "${ca[@]}" --max-time 10 \
    --resolve "$admin:443:127.0.0.1" --resolve "$admin:80:127.0.0.1" \
    --resolve "$shop:443:127.0.0.1" --resolve "$shop:80:127.0.0.1" \
    -D "$work/$name.headers" -o "$work/$name.body" -w '%{http_code}' "$@" "$url"
}
# header NAME HEADER: the header's value in NAME's response, without the line ending.
header() { sed -n "s/^$2: //Ip" "$work/$1.headers" | tr -d '\r' | tail -n 1; }

# The headers the apps' files must carry: docker/app-headers.conf's, plus HSTS.
expected=()
while IFS= read -r line; do expected+=("$line"); done < <(
  sed -n 's/^add_header \([A-Za-z-]*\) "\(.*\)" always;$/\1: \2/p' "$here/../docker/app-headers.conf"
)
expected+=("Strict-Transport-Security: max-age=63072000; includeSubDomains")
if [ "${#expected[@]}" -lt 5 ]; then
  fail "read the headers from docker/app-headers.conf (found ${#expected[@]})"
fi

api_csp="default-src 'none'; frame-ancestors 'none'"

for host in "$admin" "$shop"; do
  status=$(fetch redirect "http://$host/some/path")
  location=$(header redirect Location)
  if [[ $status == 30[18] && $location == "https://$host/some/path" ]]; then
    pass "$host: HTTP redirects to HTTPS"
  else
    fail "$host: HTTP answered $status, Location '$location'"
  fi

  status=$(fetch index "https://$host/")
  if [ "$status" = 200 ]; then pass "$host: HTTPS serves the app"; else fail "$host: / answered $status"; fi
  for line in "${expected[@]}"; do
    name=${line%%: *}
    value=${line#*: }
    got=$(header index "$name")
    if [ "$got" = "$value" ]; then
      pass "$host: $name"
    else
      fail "$host: $name is '$got', expected '$value'"
    fi
  done

  # The app's own routes, and every path that is not one of this app's API paths, load
  # index.html: the API is not reached.
  for path in /products/123 /health/ready /health/live; do
    status=$(fetch route "https://$host$path")
    if [ "$status" = 200 ] && cmp -s "$work/index.body" "$work/route.body"; then
      pass "$host: $path loads the app, not the API"
    else
      fail "$host: $path answered $status with something other than index.html"
    fi
  done
done

# api_path NAME HOST PATH [curl options...]: the path must reach the API, which sends its own
# content security policy.
api_path() {
  local name=$1 host=$2 path=$3
  shift 3
  fetch "$name" "https://$host$path" "$@" >/dev/null
  if [ "$(header "$name" Content-Security-Policy)" = "$api_csp" ]; then
    pass "$host: $path reaches the API"
  else
    fail "$host: $path did not reach the API"
  fi
}
not_api_path() {
  local host=$1 path=$2
  fetch other "https://$host$path" >/dev/null
  if [ "$(header other Content-Security-Policy)" != "$api_csp" ]; then
    pass "$host: $path does not reach the API"
  else
    fail "$host: $path reaches the API from the wrong origin"
  fi
}

api_path admin-me "$admin" /admin/v1/me
api_path graphql "$shop" /storefront/v1/graphql -X POST -H 'Content-Type: application/json' --data '{}'
api_path webhook "$shop" /webhooks/stripe -X POST --data '{}'
not_api_path "$admin" /storefront/v1/graphql
not_api_path "$admin" /webhooks/stripe
not_api_path "$shop" /admin/v1/me

# Only the edge is published, on 80 and 443. `compose ps` shows a published port with "->".
ports=$(compose ps --format '{{.Service}} {{.Ports}}')
service_ports() { awk -v service="$1" '$1 == service { $1 = ""; print }' <<<"$ports"; }
for service in api postgres backup; do
  found=$(service_ports "$service")
  if [ -z "$found" ]; then
    fail "$service is not running, or shows no ports"
  elif [[ $found == *"->"* ]]; then
    fail "$service publishes a port:$found"
  else
    pass "$service publishes no port"
  fi
done
edge_ports=$(service_ports edge | grep -o -- '->[0-9]*' | sort -u | tr '\n' ' ')
if [ "$edge_ports" = "->443 ->80 " ]; then
  pass "the edge publishes ports 80 and 443 only"
else
  fail "the edge publishes: $edge_ports"
fi
if curl -s --max-time 3 -o /dev/null http://127.0.0.1:4000/; then
  fail "the API answers on port 4000 outside the stack"
else
  pass "the API does not answer on port 4000 outside the stack"
fi

# The latest backup restores into an empty database.
latest=""
for _ in $(seq 1 30); do
  latest=$(compose exec -T backup sh -c 'ls -1 /backups/muziris-*.dump 2>/dev/null | tail -n 1' || true)
  [ -n "$latest" ] && break
  sleep 2
done
if [ -z "$latest" ]; then
  fail "no backup in $backups"
else
  pass "backup written: ${latest#/backups/}"
  tables=$(
    compose exec -T backup sh -c '
      dropdb --if-exists restore_check && createdb restore_check &&
      pg_restore --no-owner --exit-on-error --dbname=restore_check "$1" &&
      psql -d restore_check -tAc "select count(*) from information_schema.tables where table_schema = '\''public'\''" &&
      dropdb restore_check' sh "$latest"
  ) || tables=0
  if [ "${tables:-0}" -gt 0 ]; then
    pass "the backup restores ($tables tables)"
  else
    fail "the backup did not restore (${tables:-0} tables)"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "All checks passed"
