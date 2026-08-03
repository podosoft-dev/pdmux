#!/bin/sh
set -eu
umask 077
# ⚠ THE THREE LINES ABOVE ARE THE CONTRACT, AND umask IS THIRD ON PURPOSE.
# Everything below this point can create a file — the download, the backup copy of
# the previous binary, a directory we had to make — and the first of them must not
# be able to land group- or world-readable on a shared machine. Every path that has
# to be wider than that says so with an explicit chmod, so the default is the safe
# one and each exception is visible in the diff.
#
# ---------------------------------------------------------------------------
# pdmux host agent installer
#
#   curl -fsSL https://<pdmux-origin>/install.sh | sh -s -- --code pdmxe_...
#
# This file is NOT a static asset. The server renders it per request and bakes in
# its own public origin, the agent version it is publishing and the sha256 of every
# artifact (apps/web/src/lib/server/install-script/render.ts). Read it before you
# run it — that is the whole reason the checksums are in the text instead of being
# fetched by it.
#
# WHAT IT DOES, IN ORDER
#   parse flags -> detect os/arch -> pick paths -> find a fetcher and a hasher ->
#   download -> VERIFY sha256 -> place the binary atomically -> `pdmux-agent
#   install` (which is what redeems the enrollment code) -> register and start the
#   service -> `pdmux-agent doctor`.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   * It never redeems the enrollment code itself. The exchange happens inside the
#     agent binary so the LONG-LIVED host token never touches argv, a temp file or
#     an environment variable — it goes HTTPS response -> process -> 0600 config.
#     See agent/internal/cli/enroll.go for the full argument.
#   * It never runs sudo on its own initiative. If a step needs privileges it says
#     which command to re-run, and stops.
#   * It has no way to skip the checksum. An installer whose verification can be
#     turned off is one that will be turned off in somebody's Ansible role.
#   * It never enables shell tracing. The enrollment code is on this script's
#     command line, and `set -x` would put it in every log that captures stderr.
#
# EXIT CODES (a contract — automation branches on these)
#   0  installed and healthy
#   1  write or permission failure
#   2  usage error (bad flag, missing --code on a first install)
#   3  unsupported platform, or a required tool is missing
#   4  download or checksum failure — nothing installed was touched
#   5  the server refused the enrollment code
#   6  the service manager refused to register or start the unit
#   7  installed and running, but `pdmux-agent doctor` reported a problem
# ---------------------------------------------------------------------------

# Baked by the renderer. The origin is the one the request arrived on, validated
# against a strict allowlist first: this text is piped into sh, so a Host header
# that reached this line unchecked would be remote code execution on the next
# operator's machine.
PDMUX_ORIGIN='@@ORIGIN@@'
PDMUX_AGENT_VERSION='@@VERSION@@'

# Names shared with the agent's own installer (agent/internal/cli/install.go).
# Renaming one of these is a breaking change for every host already installed.
BINARY_NAME='pdmux-agent'
UNIT_NAME='pdmux-agent.service'
LAUNCHD_LABEL='dev.pdmux.agent'
SYSTEM_CONFIG='/etc/pdmux/agent.json'
SYSTEM_UNIT='/etc/systemd/system/pdmux-agent.service'
SYSTEM_PLIST='/Library/LaunchDaemons/dev.pdmux.agent.plist'

EX_WRITE=1
EX_USAGE=2
EX_PLATFORM=3
EX_DOWNLOAD=4
EX_ENROLL=5
EX_SERVICE=6
EX_DOCTOR=7

step() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'install.sh: %s\n' "$*" >&2; }
die() {
  status=$1
  shift
  printf 'install.sh: %s\n' "$*" >&2
  exit "$status"
}

usage() {
  cat <<'EOF'
Install the pdmux host agent.

Usage:
  curl -fsSL <origin>/install.sh | sh -s -- --code pdmxe_XXXXX-XXXXX-XXXXX-XXXXX

Options:
  --code <code>   Enrollment code from the dashboard's "Add host" dialog. Single
                  use, short-lived. May also be given as the PDMUX_CODE
                  environment variable, which keeps it out of `ps` output.
                  Required for a first install; omit it to upgrade in place.
  --server <url>  Server to enrol with. Defaults to the origin that served this
                  script, which is almost always what you want.
  --user          Install a per-user service (systemd --user / LaunchAgent) into
                  your home directory instead of a system one. Needs no root.
  --version <v>   Assert that the agent version being installed is exactly <v>.
                  This installer carries the checksums for ONE version; if the
                  server has moved on, this fails loudly instead of quietly
                  installing something a pinned deployment did not ask for.
  --bin-dir <d>   Directory to install the binary into. Defaults to /usr/local/bin
                  for a system install and ~/.local/bin for --user. On an upgrade
                  the default is whatever path the installed service actually
                  starts.
  --no-service    Write the files but do not register or start a service.
  --dry-run       Download and verify, print what would be done, change nothing.
                  Never contacts the enrollment endpoint, so the code stays unspent.
  --help          This text.

Exit codes: 0 ok · 1 write/permission · 2 usage · 3 unsupported platform or
missing tool · 4 download/checksum · 5 enrollment refused · 6 service
registration · 7 running but doctor failed.
EOF
  printf '\nThis copy was generated by %s and installs pdmux-agent %s.\n' \
    "$PDMUX_ORIGIN" "$PDMUX_AGENT_VERSION"
}

# ---------------------------------------------------------------------------
# Published artifacts. The renderer replaces the body of this fence with one arm
# per target from the release manifest; what is between the markers below is a
# placeholder that exists so this file stays valid `sh` and shellcheck-able on its
# own. The hashes are the ONLY thing that decides whether a download is executed.
# ---------------------------------------------------------------------------
# pdmux:artifacts:begin
resolve_artifact() {
  case "$1" in
    linux-amd64)
      artifact_path='/agent/0.0.0/pdmux-agent-linux-amd64'
      artifact_sha256='0000000000000000000000000000000000000000000000000000000000000000'
      ;;
    *)
      return 1
      ;;
  esac
}
# pdmux:artifacts:end

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
# PDMUX_CODE is read from the environment first so an operator can keep the code
# out of their shell history and out of `ps`, which shows every argv on the box.
code="${PDMUX_CODE:-}"
server="$PDMUX_ORIGIN"
want_version=''
bin_dir=''
user_install=0
with_service=1
dry_run=0

need_value() {
  # $1 = flag name, $2 = how many arguments are left after it
  if [ "$2" -lt 1 ]; then
    die "$EX_USAGE" "$1 needs a value"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --code) shift; need_value --code "$#"; code=$1 ;;
    --code=*) code=${1#--code=} ;;
    --server) shift; need_value --server "$#"; server=$1 ;;
    --server=*) server=${1#--server=} ;;
    --version) shift; need_value --version "$#"; want_version=$1 ;;
    --version=*) want_version=${1#--version=} ;;
    --bin-dir) shift; need_value --bin-dir "$#"; bin_dir=$1 ;;
    --bin-dir=*) bin_dir=${1#--bin-dir=} ;;
    --user) user_install=1 ;;
    --no-service) with_service=0 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    # Refused, never ignored. A typo in an automation role (`--user-install`) that
    # silently installed a SYSTEM service would be discovered by the next person
    # to wonder why the agent runs as root.
    *) printf 'install.sh: unknown argument: %s\n\n' "$1" >&2; usage >&2; exit "$EX_USAGE" ;;
  esac
  shift
done

# The code is a credential, so it is dropped from the environment as soon as it has
# been read: everything this script starts from here on inherits that environment,
# and the agent is a long-lived daemon whose /proc/<pid>/environ would otherwise
# carry it for as long as the process lives.
unset PDMUX_CODE || true

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------
uname_s=$(uname -s 2>/dev/null || printf 'unknown')
uname_m=$(uname -m 2>/dev/null || printf 'unknown')

case "$uname_s" in
  Linux) os='linux' ;;
  Darwin) os='darwin' ;;
  # Refused rather than approximated. Guessing a target here produces a download
  # that cannot execute, or worse, one that can and is wrong.
  *) die "$EX_PLATFORM" "unsupported operating system: uname -s said '$uname_s' (this installer publishes linux and darwin builds only)" ;;
esac

case "$uname_m" in
  x86_64|amd64) arch='amd64' ;;
  aarch64|arm64) arch='arm64' ;;
  *) die "$EX_PLATFORM" "unsupported CPU architecture: uname -m said '$uname_m' (this installer publishes amd64 and arm64 builds only)" ;;
esac

artifact_path=''
artifact_sha256=''
if ! resolve_artifact "$os-$arch"; then
  die "$EX_PLATFORM" "no pdmux-agent $PDMUX_AGENT_VERSION build is published for $os-$arch"
fi

if [ -n "$want_version" ] && [ "$want_version" != "$PDMUX_AGENT_VERSION" ]; then
  # This installer carries the checksums for exactly one version, and there is no
  # way to fetch another one and still verify it against something this file
  # states. Failing is the honest answer: a deployment that pinned a version has
  # to know the server no longer publishes it.
  die "$EX_PLATFORM" "asked for pdmux-agent $want_version, but $PDMUX_ORIGIN is publishing $PDMUX_AGENT_VERSION"
fi

# ---------------------------------------------------------------------------
# Tools. Each of these is checked BEFORE anything is written, so a machine that
# cannot complete the install fails while it is still untouched.
# ---------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetcher='curl'
elif command -v wget >/dev/null 2>&1; then
  fetcher='wget'
else
  die "$EX_PLATFORM" "need curl or wget to download the agent, and found neither"
fi

if command -v sha256sum >/dev/null 2>&1; then
  hasher='sha256sum'
elif command -v shasum >/dev/null 2>&1; then
  hasher='shasum'
elif command -v openssl >/dev/null 2>&1; then
  hasher='openssl'
else
  # No silent fallback to "install it anyway". An unverified binary from the
  # network is the one thing this script exists to prevent.
  die "$EX_PLATFORM" "need sha256sum, shasum or openssl to verify the download, and found none of them"
fi

service_manager='none'
if [ "$os" = 'linux' ] && command -v systemctl >/dev/null 2>&1; then
  service_manager='systemd'
elif [ "$os" = 'darwin' ] && command -v launchctl >/dev/null 2>&1; then
  service_manager='launchd'
fi
if [ "$with_service" -eq 1 ] && [ "$service_manager" = 'none' ]; then
  die "$EX_PLATFORM" "found no systemd or launchd on this host; re-run with --no-service and start '$BINARY_NAME run' under whatever supervises services here"
fi

# ---------------------------------------------------------------------------
# Privileges and credentials
# ---------------------------------------------------------------------------
if [ "$user_install" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  # We do not reach for sudo ourselves: re-running the pipeline under sudo is the
  # operator's decision, and reconstructing their command line for them would mean
  # printing the enrollment code back at them.
  die "$EX_WRITE" "a system install needs root — re-run the same command with 'sudo sh' instead of 'sh', or pass --user for a per-user service"
fi

if [ "$user_install" -eq 1 ]; then
  home_dir="${HOME:-}"
  if [ -z "$home_dir" ]; then
    die "$EX_WRITE" "--user needs HOME to be set"
  fi
  config_path="$home_dir/.config/pdmux/agent.json"
  unit_path="$home_dir/.config/systemd/user/$UNIT_NAME"
  plist_path="$home_dir/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  launchd_domain="gui/$(id -u)"
  default_bin_dir="$home_dir/.local/bin"
else
  config_path="$SYSTEM_CONFIG"
  unit_path="$SYSTEM_UNIT"
  plist_path="$SYSTEM_PLIST"
  launchd_domain='system'
  default_bin_dir='/usr/local/bin'
fi

upgrade=0
if [ -f "$config_path" ]; then
  upgrade=1
fi

if [ -z "$code" ] && [ "$upgrade" -eq 0 ]; then
  die "$EX_USAGE" "--code is required for a first install (get one from the dashboard's 'Add host' dialog, or set PDMUX_CODE)"
fi

# ---------------------------------------------------------------------------
# Where the binary goes.
#
# On an upgrade the destination is whatever the INSTALLED SERVICE actually starts,
# not the default directory. The agent's own installer relocates the binary when
# the directory it was run from is not writable by the service user (it has to be,
# or a future self-update cannot replace the file) — so on such a host the unit
# starts /opt/pdmux/bin/pdmux-agent while /usr/local/bin/pdmux-agent also exists.
# Replacing the default path there would report a successful upgrade and leave the
# old binary running, which is the quietest possible way to fail.
# ---------------------------------------------------------------------------
installed_exec=''
if [ "$service_manager" = 'systemd' ] && [ -f "$unit_path" ]; then
  installed_exec=$(sed -n 's/^ExecStart=\([^ ][^ ]*\).*/\1/p' "$unit_path" 2>/dev/null | head -n 1)
elif [ "$service_manager" = 'launchd' ] && [ -f "$plist_path" ]; then
  installed_exec=$(sed -n 's|.*<string>\(/[^<]*/pdmux-agent\)</string>.*|\1|p' "$plist_path" 2>/dev/null | head -n 1)
fi
case "$installed_exec" in
  /*) ;;
  # Anything that is not an absolute path is a unit we did not write or could not
  # parse; fall back rather than act on a guess.
  *) installed_exec='' ;;
esac

if [ -n "$bin_dir" ]; then
  target="$bin_dir/$BINARY_NAME"
elif [ -n "$installed_exec" ]; then
  target="$installed_exec"
else
  target="$default_bin_dir/$BINARY_NAME"
fi
install_dir=$(dirname "$target")

if [ ! -d "$install_dir" ]; then
  if [ "$dry_run" -eq 0 ]; then
    mkdir -p "$install_dir" || die "$EX_WRITE" "cannot create $install_dir"
    # umask 077 would leave a fresh bin directory unreadable to everyone else,
    # which for /usr/local/bin is not a security improvement but a broken PATH.
    chmod 755 "$install_dir" || die "$EX_WRITE" "cannot chmod $install_dir"
  fi
elif [ ! -w "$install_dir" ]; then
  die "$EX_WRITE" "$install_dir is not writable by this account"
fi

# ---------------------------------------------------------------------------
# Download and verify
# ---------------------------------------------------------------------------
tmp_file=''
cleanup() {
  # Only ever holds the not-yet-verified download; it is cleared the moment that
  # file becomes the installed binary, so this can never remove a working agent.
  if [ -n "$tmp_file" ]; then
    rm -f "$tmp_file"
  fi
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

fetch_to() {
  # $1 = url, $2 = destination path
  case "$fetcher" in
    # -L is fine on this GET: a redirect can only change WHICH bytes arrive, and
    # the sha256 below decides whether those bytes are ever executed. (The rule it
    # looks like it breaks — never follow redirects on a POST — applies to the
    # enrollment exchange, which is inside the agent binary, not here: curl
    # re-sends the body on a 307/308 and would replay the code at another host.)
    curl) curl -fsSL -o "$2" "$1" ;;
    wget) wget -q -O "$2" "$1" ;;
  esac
}

sha256_of() {
  case "$hasher" in
    sha256sum) sha256sum "$1" | awk '{ print $1 }' ;;
    shasum) shasum -a 256 "$1" | awk '{ print $1 }' ;;
    # `SHA2-256(file)= <hex>` on openssl 3, `SHA256(file)= <hex>` before it.
    openssl) openssl dgst -sha256 "$1" | awk '{ print $NF }' ;;
  esac
}

url="$server$artifact_path"
# The download lands in the DESTINATION directory, not /tmp: the final step is a
# rename, and rename only works within one filesystem. It is also what makes the
# replacement atomic and safe against ETXTBSY — the running agent keeps the old
# inode, and no reader ever sees a half-written executable.
tmp_file="$install_dir/.$BINARY_NAME.$$.download"

step "Downloading $BINARY_NAME $PDMUX_AGENT_VERSION ($os-$arch)"
note "$url"
if ! fetch_to "$url" "$tmp_file"; then
  die "$EX_DOWNLOAD" "download failed: $url"
fi
if [ ! -s "$tmp_file" ]; then
  die "$EX_DOWNLOAD" "download produced an empty file: $url"
fi

actual_sha256=$(sha256_of "$tmp_file")
if [ "$actual_sha256" != "$artifact_sha256" ]; then
  # Nothing that is already installed has been touched at this point, and nothing
  # will be: a corrupt or tampered download must never be able to take down a
  # healthy agent. The temp file goes with the trap.
  die "$EX_DOWNLOAD" "checksum mismatch for $url (expected $artifact_sha256, got $actual_sha256) — nothing was installed"
fi
step "Verified sha256 $artifact_sha256"

chmod 755 "$tmp_file" || die "$EX_WRITE" "cannot chmod $tmp_file"

if [ "$dry_run" -eq 1 ]; then
  step "Dry run — stopping here. Nothing was installed and no code was redeemed."
  note "binary       $target"
  note "config       $config_path"
  if [ "$service_manager" = 'launchd' ]; then
    note "service      $plist_path ($launchd_domain/$LAUNCHD_LABEL)"
  elif [ "$service_manager" = 'systemd' ]; then
    note "service      $unit_path"
  else
    note "service      not registered (--no-service)"
  fi
  if [ "$upgrade" -eq 1 ]; then
    note "mode         upgrade in place (existing configuration is kept)"
  else
    note "mode         first install (the enrollment code would be redeemed by '$BINARY_NAME install')"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Stop, replace, prove the new binary runs
# ---------------------------------------------------------------------------
systemctl_run() {
  if [ "$user_install" -eq 1 ]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

service_stop() {
  case "$service_manager" in
    systemd)
      if systemctl_run is-active --quiet "$UNIT_NAME" 2>/dev/null; then
        step "Stopping $UNIT_NAME"
        if ! systemctl_run stop "$UNIT_NAME"; then
          # Not fatal: the rename below replaces the directory entry rather than
          # writing into a busy file, so an agent we failed to stop keeps running
          # the old inode and is picked up by the restart at the end.
          warn "could not stop $UNIT_NAME; continuing (the replacement is atomic)"
        fi
      fi
      ;;
    launchd)
      if launchctl print "$launchd_domain/$LAUNCHD_LABEL" >/dev/null 2>&1; then
        step "Stopping $LAUNCHD_LABEL"
        if ! launchctl bootout "$launchd_domain/$LAUNCHD_LABEL" >/dev/null 2>&1; then
          warn "could not bootout $LAUNCHD_LABEL; continuing (the replacement is atomic)"
        fi
      fi
      ;;
  esac
}

backup=''
if [ -e "$target" ]; then
  service_stop
  backup="$target.bak"
  # A copy, not a move: if anything below fails, the file the service starts is
  # still there and still works.
  if ! cp -p "$target" "$backup"; then
    die "$EX_WRITE" "cannot back up $target to $backup"
  fi
  step "Kept the previous binary as $backup"
fi

step "Installing $target"
if ! mv -f "$tmp_file" "$target"; then
  die "$EX_WRITE" "cannot install $target"
fi
tmp_file=''

if ! "$target" --version >/dev/null 2>&1; then
  if [ -n "$backup" ]; then
    mv -f "$backup" "$target" || true
    warn "restored the previous binary"
  else
    rm -f "$target" || true
  fi
  die "$EX_WRITE" "the downloaded binary did not run on this host ('$target --version' failed)"
fi

# ---------------------------------------------------------------------------
# Enrol. The binary does the exchange; this script never sees the host token, and
# the code is passed to exactly one process and never written anywhere.
# ---------------------------------------------------------------------------
if [ -n "$code" ]; then
  step "Enrolling with $server"
  install_status=0
  if [ "$user_install" -eq 1 ]; then
    "$target" install --server "$server" --user --code "$code" || install_status=$?
  else
    "$target" install --server "$server" --code "$code" || install_status=$?
  fi
  case "$install_status" in
    0) ;;
    1) die "$EX_WRITE" "'$BINARY_NAME install' could not write its configuration (see above)" ;;
    2) die "$EX_USAGE" "'$BINARY_NAME install' refused the arguments this script gave it (see above)" ;;
    3) die "$EX_ENROLL" "the server rejected the enrollment code — codes are single use and expire, so get a fresh one from the dashboard" ;;
    4) die "$EX_ENROLL" "the host this code belongs to is disabled; the code was NOT spent — enable the host in the dashboard and re-run this command unchanged" ;;
    5) die "$EX_ENROLL" "the server is rate limiting enrollment; wait a few minutes and re-run (retrying sooner only extends the block)" ;;
    *) die "$EX_ENROLL" "'$BINARY_NAME install' failed with status $install_status (see above)" ;;
  esac
else
  step "Keeping the existing configuration at $config_path"
fi

# ---------------------------------------------------------------------------
# Register and start
# ---------------------------------------------------------------------------
if [ "$with_service" -eq 1 ]; then
  case "$service_manager" in
    systemd)
      step "Registering $UNIT_NAME"
      if ! systemctl_run daemon-reload; then
        die "$EX_SERVICE" "systemctl daemon-reload failed"
      fi
      if ! systemctl_run enable --now "$UNIT_NAME"; then
        die "$EX_SERVICE" "systemctl enable --now $UNIT_NAME failed"
      fi
      ;;
    launchd)
      step "Registering $LAUNCHD_LABEL"
      if ! launchctl bootstrap "$launchd_domain" "$plist_path" >/dev/null 2>&1; then
        # Already bootstrapped is the normal case on a re-run; kickstart below is
        # what actually proves the job is loaded and running.
        note "already registered; restarting it"
      fi
      if ! launchctl kickstart -k "$launchd_domain/$LAUNCHD_LABEL" >/dev/null 2>&1; then
        die "$EX_SERVICE" "launchctl kickstart $launchd_domain/$LAUNCHD_LABEL failed"
      fi
      ;;
  esac
else
  note "Skipped service registration (--no-service)"
fi

# ---------------------------------------------------------------------------
# Prove it works. `doctor` checks configuration, tooling, PTY and a real
# handshake with the server — an install that reports success without this has
# only proved that files were written.
# ---------------------------------------------------------------------------
step "Checking the installation"
if ! "$target" doctor; then
  die "$EX_DOCTOR" "$BINARY_NAME is installed and the service was started, but 'doctor' reported a problem (above)"
fi

step "pdmux-agent $PDMUX_AGENT_VERSION is installed and connected."
note "This host should now appear on $PDMUX_ORIGIN"
