#!/bin/sh
# Application-owned additions to the API container images. PodoKit creates this
# file once and never overwrites it.
#
# The managed apps/api/Dockerfile runs it as root in its runtime stage, before
# the image switches to the unprivileged `bun` user, and Dockerfile.dev runs it
# too, so production and development have the same system tools. Install the
# system packages and command-line tools your API calls here instead of editing
# the managed Dockerfile.
#
# The images are Alpine Linux: install packages with `apk add --no-cache`.
# TARGETARCH is the image architecture (`amd64` or `arm64`) when BuildKit builds
# it. Pin what you install, and check the SHA-256 of anything you download:
#
#   apk add --no-cache poppler-utils
#   case "$TARGETARCH" in
#     amd64) arch=x86_64; sha=<sha256 of the x86_64 archive> ;;
#     arm64) arch=aarch64; sha=<sha256 of the aarch64 archive> ;;
#     *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;;
#   esac
#   wget -q -O /tmp/tool.tar.gz "https://example.com/tool-1.2.3-linux-$arch.tar.gz"
#   echo "$sha  /tmp/tool.tar.gz" | sha256sum -c -
#   tar -xzf /tmp/tool.tar.gz -C /usr/local/bin tool && rm /tmp/tool.tar.gz
set -eu
