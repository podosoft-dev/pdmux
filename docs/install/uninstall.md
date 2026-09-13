# Uninstall pdmux desktop

First use **Create backup**, copy the backup to a separate safe location if you
want to keep it, and choose **Quit** in the tray menu.

| Platform | Remove the application | Data retained separately |
|---|---|---|
| macOS | Move `/Applications/pdmux.app` to Trash | `~/Library/Application Support/pdmux-desktop` |
| Windows | Settings → Apps → Installed apps → pdmux → Uninstall | `%APPDATA%\pdmux-desktop` |
| Linux AppImage | Delete the AppImage or its extracted application directory | `~/.config/pdmux-desktop`, or `$XDG_CONFIG_HOME/pdmux-desktop` |
| Debian package | `sudo apt remove pdmux` | Same Linux data directory |

Removing the application is different from deleting its data. Keep the data
directory when reinstalling or upgrading. Delete it only when you intentionally
want to remove local accounts, host registrations, files, and local backups.

Host agents are independent services on registered machines. Uninstalling the
desktop does not uninstall or stop them. Back up the local data before removing
it if those hosts need to reconnect to this installation later.
