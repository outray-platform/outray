#!/usr/bin/env bash
set -euo pipefail
set +x
: "${EDGE_SSH_KEY:?Set edge_ssh_key in the public repository CI}"
temporary_dir="$(mktemp -d)"
trap 'rm -f "$temporary_dir/key" "$temporary_dir/known_hosts" "$temporary_dir/package.json"; rmdir "$temporary_dir"' EXIT
umask 077
printf '%s\n' "$EDGE_SSH_KEY" > "$temporary_dir/key"
printf '%s\n' '[209.74.86.123]:22022 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMVzpFu9vNmrf14y8P/fPcKFxftQkUmMVZjTV4+aHkv4' > "$temporary_dir/known_hosts"
ssh_options=(-i "$temporary_dir/key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$temporary_dir/known_hosts" -o BatchMode=yes)
commit="$(git rev-parse HEAD)"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
release="/root/outray-edge/releases/$commit-$$"
host=root@209.74.86.123
ssh "${ssh_options[@]}" -p 22022 "$host" "mkdir -p '$release/tunnel' '$release/deploy/woodpecker'"
node deploy/woodpecker/runtime-package.mjs apps/tunnel/package.json > "$temporary_dir/package.json"
scp "${ssh_options[@]}" -P 22022 -r apps/tunnel/dist "$host:$release/tunnel/"
scp "${ssh_options[@]}" -P 22022 "$temporary_dir/package.json" "$host:$release/tunnel/package.json"
scp "${ssh_options[@]}" -P 22022 deploy.sh "$host:$release/"
scp "${ssh_options[@]}" -P 22022 deploy/woodpecker/run-edge-deploy.mjs "$host:$release/deploy/woodpecker/"
# The same host lock is used by the private pipeline. Upload paths never overlap.
ssh "${ssh_options[@]}" -p 22022 "$host" "flock --exclusive --timeout 900 /var/lock/outray-deployment.lock node '$release/deploy/woodpecker/run-edge-deploy.mjs'"
