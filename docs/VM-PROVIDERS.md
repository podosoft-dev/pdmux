# VM providers — powering, creating and deleting the machines behind hosts

A host in pdmux is a machine running the agent. When that machine is a virtual machine on a
platform you run yourself, pdmux can also **power** it — start, put to sleep, shut down,
restart — and, for machines it created, **create and delete** it. Every terminal open on that
machine, in every browser, shows the same state and the same change in flight.

Proxmox VE is the first provider. The rest of pdmux speaks only to a provider interface
(`apps/api/src/vm/vm-provider.ts`), so another platform is a new driver, not a change to the
screens or the routes.

⚠ **Server only.** The desktop app holds no provider credentials; its screens hide every VM
control and its MCP tools answer `VM_PROVIDERS_UNAVAILABLE`.

---

## 1. Connecting a provider

**Settings → VM providers → Add provider** (fleet administrators). Pick the platform — Proxmox
VE today; AWS EC2 and Azure are listed as coming later — and give its **address and
credentials**. That is all a new connection needs: everything else starts at the platform's
defaults (`GET /vm/provider-kinds`), shown on one line and folded until you open it. A
connection is saved only after pdmux reached the provider with it, so a mistyped token is
refused on the form rather than failing at the first power change.

Proxmox VE defaults:

| setting | default |
|---|---|
| name | the address's host (`pve.example.com`, `192.0.2.10`; `-2` … if taken) |
| new machine size | 4 vCPU, 16 GB memory, 64 GB disk (the template's boot disk is grown before first boot when smaller; disks only grow) |
| template | the one tagged `pdmux-template` — none, or several, is asked rather than guessed |
| pool | `pdmux` when the cluster has it, otherwise none |
| node / storage | the template's |
| ids for new machines | 500–599 |
| clone | linked |

| field | meaning |
|---|---|
| API address | `https://host:8006` |
| API token id / secret | a Proxmox API token, `user@realm!tokenid`. The secret is write-only: the form never shows it back, and leaving it empty on edit keeps the stored one. It is stored encrypted |
| CA certificate | the cluster's own CA (`/etc/pve/pve-root-ca.pem`), so pdmux verifies the certificate without trusting every self-signed one. Empty for a certificate from a public CA. The row shows its SHA-256 fingerprint to compare with the server |
| Defaults | node, template, storage, pool, the **id range** pdmux may use for new machines, cores, memory, linked or full clone |
| Only hibernate machines tagged | see §3 |
| Back up before sleep to storage | see §3 |
| Address new machines reach pdmux at | see §4. Empty uses this server's own address (`BETTER_AUTH_URL`) |

### Token privileges

Give the token its own user and keep it out of everything else. Two roles, on two pools, keep
"machines pdmux made" apart from "machines that already existed":

| where | privileges | for |
|---|---|---|
| pool of machines pdmux creates | `VM.Audit`, `VM.PowerMgmt`, `VM.Clone`, `VM.Allocate`, `VM.Config.*` (CPU, Memory, Disk, Network, Options, HWType, Cloudinit, CDROM), `VM.Backup`, `Pool.Audit` | create, power, delete |
| pool of machines you link | `VM.Audit`, `VM.PowerMgmt` (+ `VM.Backup` to back up before sleep), `Pool.Audit` | power only — the token cannot reconfigure or delete them |
| the template(s) | `VM.Clone`, `VM.Audit` | cloning |
| VM disk and backup storage | `Datastore.AllocateSpace`, `Datastore.Audit` | clones, backups, finding old backups |
| the bridge's SDN zone | `SDN.Use` | the clone's network |

No `Sys.*` privilege is needed. A machine outside the token's reach answers as if it did not
exist.

## 2. Linking a machine that already exists

On a host's page, the **Virtual machine** card offers **Link** to an administrator: a provider,
a node and the machine's id. From then on the host's panes show the machine's power state and
offer its changes. **Unlink** stops managing it; the machine itself is never touched. A linked
machine cannot be deleted from pdmux — the token is not meant to have that right over it.

## 3. Power changes

| change | what it does | who |
|---|---|---|
| **Sleep** (hibernate) | saves memory to disk and stops; **Wake** resumes every process where it was — tmux sessions and the agents in them included | any member of the fleet |
| Start / Wake | powers on, or resumes a sleeping machine | any member |
| Restart / Shut down | asks the guest; its processes end | any member |
| Force off / Force restart | cuts power at once — unsaved work in the guest is lost | fleet administrators |

"Stop" in pdmux means **sleep**: it is the first item in a running machine's menu, because it
keeps everything and costs only memory on disk.

- **One change at a time.** Claiming a change is a conditional write, so two people (or two
  panes) pressing at once start one task; the other is told who is already changing it.
- **Every screen agrees.** The machine's state and its change in flight are on the host row;
  every pane, card and page reads them — a terminal opened in its own window included, with the
  same power menu and the same wake button. A machine going to sleep takes its panes off line at
  once — before any heartbeat is missed — and each pane says who asked and how long it has run.
- **Changes made elsewhere are noticed.** pdmux reads each provider once a minute (one replica
  at a time), so a machine started from the provider's own console shows within a minute.
- **Sleep and backups.** A hibernated Proxmox machine is locked, and a scheduled backup of it
  fails. Set *Only hibernate machines tagged* to a tag you give the machines you took out of the
  backup schedule; others can still be shut down. Set *Back up before sleep* and pdmux makes a
  backup first when the newest is older than a day.

## 4. Creating a machine

**Add host → Create a VM** (administrators, when a provider is connected): a label, a template
(the provider's default first), cores and memory. The new host is on every screen as
"creating" at once:

1. **An id** in the provider's range that no machine holds — including machines the token
   cannot see — and that **no backup storage on the node remembers**. Backups are grouped by id
   alone, so a new machine on an old id would have its backup pruning delete the old machine's
   backups.
2. **Clone** the template, then **configure** it: cores, memory, a balloon device at the full
   size, the tag `pdmux` (and the sleep tag, if the provider has one), the host id in its notes.
3. **Hand over an enrollment code**: the server writes a fresh single-use code (15 minutes) and
   its own address into the machine's firmware — SMBIOS *serial* and *SKU*, which only root can
   read in the guest — and **starts** it. The server never connects to the machine.
4. **Wait for the agent.** A unit in the template enrolls on first boot (below). When the code
   is used, pdmux clears the firmware fields.

A clone that leaves nothing behind removes the new host again; a later failure keeps the
machine in error, to be deleted or retried. A machine whose agent never enrolled offers
**Retry registration**: a new code, and a restart to read it. Each dialog sends one
idempotency key, so a resend after a lost answer makes one machine.

### The template's first-boot unit

Any Linux template works if it enrolls from its firmware on first boot. Install the agent
binary as `/usr/local/bin/pdmux-agent`, then:

```sh
# /usr/local/sbin/pdmux-enroll
#!/bin/sh
set -eu
code=$(cat /sys/class/dmi/id/product_serial 2>/dev/null || true)
server=$(cat /sys/class/dmi/id/product_sku 2>/dev/null || true)
case "$code" in pdmx*) ;; *) echo "No enrollment code in the firmware"; exit 0 ;; esac
case "$server" in http://*|https://*) ;; *) echo "No pdmux address in the firmware" >&2; exit 1 ;; esac
user=$(getent passwd 1000 | cut -d: -f1)   # the account the agent (and its terminals) runs as
SUDO_USER="$user" /usr/local/bin/pdmux-agent install --server "$server" --code "$code"
systemctl daemon-reload
systemctl enable --now pdmux-agent.service
```

```ini
# /etc/systemd/system/pdmux-enroll.service  (systemctl enable pdmux-enroll)
[Unit]
Description=Enroll this machine with pdmux
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/etc/systemd/system/pdmux-agent.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pdmux-enroll
Restart=on-failure
RestartSec=20

[Install]
WantedBy=multi-user.target
```

Before turning the machine into a template, empty `/etc/machine-id` (and remove
`/var/lib/dbus/machine-id`), the SSH host keys and the cloud-init state. ⚠ A template with a
fixed machine-id gives every clone the same DHCP client id — and therefore **the same
address**. Also worth having in it: the guest agent, a swap file, a time source that steps
after a resume from hibernation (chrony with the `ptp_kvm` clock and `makestep`), and
`KillMode=process` for `pdmux-agent.service` so restarting the agent does not take the tmux
sessions with it.

If machines reach pdmux by a different address than browsers do — a private network, a
tunnel — set it as the provider's *Address new machines reach pdmux at*.

## 5. Deleting a machine

Only machines pdmux created. **Delete machine** on the host's page asks for the machine's name
again; the server compares it too, before the provider is asked anything. A sleeping machine
is woken first (its saved memory locks it), a running one stopped, the machine deleted with
its disks, then the host removed as if deleted from the host list — its agent credentials,
settings and history go with it. Backups at the provider are kept, and so are the provider's
backup, replication and HA settings: pdmux does not ask Proxmox to *purge* the id, which would
also take it out of a backup job's exclusion list. A machine that HA or replication still names
is refused by Proxmox. If the provider refuses, the host stays with the error and can be deleted
again.

## 6. From an AI CLI (MCP)

Fleet tokens get `vm_status`, `vm_power`, `vm_create` and `vm_delete`. Their tiers and
confirmation rules are in [MCP.md §5](MCP.md#5-destructive-tools-describe-before-they-act):
a power change that would cut someone off is described first, and `vm_delete` confirms with
the machine's name.

## 7. Codes

| code | meaning |
|---|---|
| `VM_OPERATION_IN_PROGRESS` | another change is running; the answer says which and who asked |
| `VM_ACTION_NOT_AVAILABLE` | the machine's current state does not allow it (decided on the provider's state at that moment) |
| `VM_TASK_TIMEOUT` | the guest did not respond in time — an administrator can force it |
| `VM_BACKUP_FAILED` | the backup before sleep failed, so the machine was not put to sleep |
| `VM_ENROLL_TIMEOUT` | a new machine did not register within 15 minutes — check the template's first-boot unit, then **Retry registration** |
| `VM_ID_RANGE_FULL` | no id in the provider's range is free of machines and backups |
| `VM_DELETE_NAME_MISMATCH` | the name typed is not the machine's |
| `VM_NOT_CREATED_BY_PDMUX` | a linked machine can be unlinked, not deleted |
| `VM_PROVIDER_AUTH_FAILED` / `_FORBIDDEN` / `_TLS_FAILED` / `_UNAVAILABLE` / `_TIMEOUT` | the provider refused the token, lacks a privilege, has a certificate the stored CA does not sign, or did not answer |
