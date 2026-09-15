#!/usr/bin/env bash
# Upload a file through the redirect flow and print each live event with the elapsed time.
#
#   API_KEY=your-key scripts/smoke.sh http://127.0.0.1:3000 examples/sample.pdf [auto|split|whole]
set -euo pipefail

base="${1:?base URL, for example http://127.0.0.1:3000}"
file="${2:?path to a file}"
mode="${3:-auto}"
type="$(file --brief --mime-type "$file")"
start="$(perl -MTime::HiRes=time -e 'printf "%.3f", time')"

location="$(curl -sS -o /dev/null -w '%{redirect_url}' \
  -F "file=@${file};type=${type}" -F "mode=${mode}" ${API_KEY:+-F "api_key=${API_KEY}"} "${base%/}/s")"
[ -n "$location" ] || { echo "Upload did not redirect. Is the key set?" >&2; exit 1; }
echo "page: $location"

curl -sSN "$location/events" | perl -MTime::HiRes=time -ne '
  BEGIN { $| = 1; $start = shift @ARGV }
  if (/^event: (\w+)/) { $type = $1 }
  if (/^data: (.*)/) {
    my ($seq) = /"seq":(\d+)/; my ($target) = /"(?:block_id|target)":"#?([^"]+)"/; my ($phase) = /"(?:phase|message)":"([^"]*)"/;
    printf "%6.2fs  #%-3s %-8s %s\n", time - $start, $seq, $type, $target // $phase // "";
  }' "$start"
