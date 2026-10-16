# Settings Vault

Save a main setup for each TERA class, initialize other characters from it, and keep their later bar edits separate. Keyboard bindings, chat and UI layout are shared. Supports all 13 classes.

## Install

Download the [latest release](https://github.com/Volframid/settings-vault/releases/latest), extract `settings-vault` into your Toolbox `mods` folder, then restart Toolbox. Disable other settings/chat saver modules to avoid conflicting restores.

Automatic module updates are enabled through this repository. Personal profiles, backups and logs are never included in updates or downloads. A new installation starts empty.

## First setup

1. Enter the character whose setup you want as the main template.
2. Arrange its bars and UI. Apply/close Game Options and Chat Settings so the client sends the settings.
3. Run `vault save`, then `vault lock` in `/8` or the Toolbox command channel.
4. Enter another character. The same class receives the full bar; another class receives common item/mount/buff slots while keeping its class skills elsewhere.

After that first import, each receiving character saves its **entire bar** separately: skills, brooches, mounts, items, moves and empty slots. Later logins use that character's own bar. Place its own mount/brooch once after loading; no extra save/lock command is needed. A native game save must be sent before an edit can be captured.

**Keyboard bindings remain common**, including left-tray Numpad keys and main-bar keys. Private character bars contain slot contents, never keybinds. Chat, window positions and captured UI scale options also remain common across classes.

## Commands

| Command | Action |
| --- | --- |
| `vault` / `vault status` | Show saved classes, access and current bar source. |
| `vault save` | Save the current class template and available shared settings. Existing locks stay active. |
| `vault lock` | Enable automatic application and eligible native saving. |
| `vault unlock` | Disable the current class and shared profiles; other class locks remain stored. |
| `vault load` | Replace this character's private bar with the latest compatible main template. |
| `vault ui` | Show shared window capture/lock status. |
| `vault ui save` / `lock` / `unlock` | Manage UI layout independently. |
| `vault ui log` | Toggle private UI diagnostics; OFF after restart. |
| `vault ui mark` | Add a marker while UI logging is active. |
| `vault minimap log` | Toggle private minimap diagnostics; OFF after restart. |
| `vault minimap normal` / `shifted` / `fixed` | Mark the map's visual state while logging. |

`vault load` intentionally discards the receiving character's bar customizations. Use it when you want newer source-template changes; already initialized characters are not overwritten automatically.

## Source protection

Only the account/server that owns the source can update or unlock its class/shared templates. Its original skill-source character can update the canonical bar automatically; another eligible character on that account can deliberately become the class source through `vault save`. Other accounts can edit their own private bars and use `vault load`, without replacing the main templates.

Source characters continue saving eligible edits while locked. Lower-level/limited characters cannot erase a higher-level source template. The game still decides which skills, mounts and items a character owns. Different-class import uses native shortcut types and positively classified common skills, not guessed ID ranges. Shared slots take priority on a position conflict.

Glyph and equipment presets remain character-bound. Disk-only graphics/INI options are outside the module. Window positions and UI scale are captured only when the game sends them; window dimensions are not part of the observed position list. If positions were not captured, apply/close interface options and relog before saving.

## Automatic N-minimap position fix

Toolbox automatically detects each connected game's resource path and installs the compatible fix at a safe startup. It keeps the last manually placed N map position across N open/close and map changes. **No manual installer step is needed for a supported client.** After installation, place the N map once; later manual placements become the shared position across maps.

Start Toolbox before launching TERA. Setup runs either before a remembered game is open, or in Toolbox's fresh-client installation stage before the client is resumed. An already running/attached game is never patched; installation is deferred to a safe startup. Busy files and concurrently running clients also defer installation. The Toolbox window reports the result.

Compatibility follows the **actual resource checksum, not the server name**. The verified Asura build is supported; another server with the identical supported resource can use the same fix. Different or updated builds are left unchanged until a matching verified patch is added. Each game installation has its own detection and restore record. The settings module continues working when the map fix is unavailable.

The fix modifies the matching original game resource, with a hash-verified backup and atomic replacement. Already-patched resources are left alone. Unknown updates and damaged backups are never overwritten. This repository distributes only a small patch recipe, not the original game package. Private paths, preferences and backups stay under `data/`; keep that folder for recovery. No additional runtime is downloaded.

**Recovery:** completely close TERA and Toolbox, open `minimap.cmd` and choose **2 Restore**, then select the game. This restores its verified pre-installation backup and disables automatic map setup for that client. **1 Install** re-enables it; **3 Status** only reads the file. The command file is a fallback, not part of normal installation.

The resulting minimap resource has been confirmed in game on the supported local build. Automatic startup integration is covered by simulated lifecycle and real-file copy tests; a fresh native installation on other clients remains unverified.

## Personal data and recovery

`data/profiles.json` holds class templates, private character bars, shared settings and ownership metadata. `data/profiles.json.bak` is its recovery copy. Keep `data/` when updating; never share it publicly. Diagnostics are private under `logs/`.

Partial native saves are merged with the complete capture. Initial/loading saves and failed deliveries cannot replace the source. Local writes are atomic, combined after 300 ms, and flushed on logout; this does not delay gameplay packets. Normal server saving continues. A damaged profile is recovered from a valid backup, with the damaged original preserved; without valid recovery, writes stop rather than clear your settings.

Snapshots from another major game patch are preserved but not applied automatically. Save a compatible source template after the patch, then use `vault load` to replace an older private bar deliberately.

Author: CEM.
