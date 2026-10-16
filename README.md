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

## Optional N-minimap position fix

The settings module works without this patch. The optional fix targets the **verified Asura Windows client resource build**. It keeps the last manually placed N map position across N open/close and map changes. Different resource builds are refused without modification.

1. Completely close TERA and Toolbox.
2. Open `minimap.cmd` in the installed module folder.
3. Choose **1 Install**, then paste the full path to your `TERA.exe` or its game folder.
4. Start the game and manually place the N map **once**. Test N open/close and changing zones. A later manual placement becomes the shared position for subsequent maps.

To undo it, close TERA/Toolbox, open the same tool, choose **2 Restore** and select the same game. It restores the verified pre-installation file from its local backup. **3 Status** only reads the resource. Already-patched files are left unchanged. Unknown updates and damaged backups are never overwritten.

The tool applies a small copy/insert recipe to your own resource; this repository does not distribute the original game package. Backups and installation records stay under `data/`. Keep that folder if you want to restore later. The tool needs the existing Toolbox Electron runtime and does not download another runtime. No original game file is changed automatically during Toolbox startup or module updating. After a game patch, check compatibility with the tool again.

The resulting minimap resource has been confirmed in game on the supported local build. Fresh-machine installation and native preference persistence across all clients have not been independently verified.

## Personal data and recovery

`data/profiles.json` holds class templates, private character bars, shared settings and ownership metadata. `data/profiles.json.bak` is its recovery copy. Keep `data/` when updating; never share it publicly. Diagnostics are private under `logs/`.

Partial native saves are merged with the complete capture. Initial/loading saves and failed deliveries cannot replace the source. Local writes are atomic, combined after 300 ms, and flushed on logout; this does not delay gameplay packets. Normal server saving continues. A damaged profile is recovered from a valid backup, with the damaged original preserved; without valid recovery, writes stop rather than clear your settings.

Snapshots from another major game patch are preserved but not applied automatically. Save a compatible source template after the patch, then use `vault load` to replace an older private bar deliberately.

Author: CEM.
