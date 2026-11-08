# Settings Vault

Save a main setup for each TERA class, initialize other characters from it, and keep their later bar edits separate. Keyboard bindings, chat and UI layout are shared. Supports all 13 classes.

## Runtime efficiency

Optional UI diagnostics keep only the latest immutable bytes for each supported packet type. Hashing and hexadecimal formatting are deferred until a log or snapshot needs them; logging stays off by default. Profile restoration, source protection and minimap behavior are unchanged.

## Install

Download the [latest release](https://github.com/Volframid/settings-vault/releases/latest), extract `settings-vault` into your Toolbox `mods` folder, then restart Toolbox. Disable other settings/chat saver modules to avoid conflicting restores.

Automatic module updates are enabled through this repository. Personal profiles, backups and logs are never included in updates or downloads. A new installation starts empty.

## First setup

1. Enter the character whose setup you want as the main template.
2. Arrange its bars and UI. Apply/close Game Options and Chat Settings so the client sends the settings.
3. Run `vault save`, then `vault lock` in `/8` or the Toolbox command channel.
4. Enter another character. The same class receives the full bar; another class receives common item/mount/buff slots while keeping its class skills elsewhere.

A freshly created character can have no saved native bar controllers yet. The first import initializes the missing bar envelopes from the compatible template, carries over only common slots across classes, and preserves any native class skill slots that are already present.

After that first import, each receiving character saves its **entire bar** separately: skills, brooches, mounts, items, moves and empty slots. Later logins use that character's own bar. Place its own mount/brooch once after loading; no extra save/lock command is needed. A native game save must be sent before an edit can be captured.

**Keyboard bindings remain common**, including left-tray Numpad keys and main-bar keys. Private character bars contain slot contents, never the shared keyboard document. A receiving character's automatic default keyboard save cannot erase the populated shared bindings; deliberate resets remain available on the main source character. Chat, window positions and captured UI scale options also remain common across classes.

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

`vault load` intentionally discards the receiving character's bar customizations. Use it when you want newer source-template changes; already initialized characters are not overwritten automatically.

## Source protection

Only the account/server that owns the source can update or unlock its class/shared templates. Its original skill-source character can update the canonical bar automatically; another eligible character on that account can deliberately become the class source through `vault save`. Other accounts can edit their own private bars and use `vault load`, without replacing the main templates.

Source characters continue saving eligible edits while locked. Lower-level/limited characters cannot erase a higher-level source template. The game still decides which skills, mounts and items a character owns. Different-class import uses native shortcut types and positively classified common skills, not guessed ID ranges. Shared slots take priority on a position conflict.

Glyph and equipment presets remain character-bound. Disk-only graphics/INI options are outside the module. Window positions and UI scale are captured only when the game sends them; window dimensions are not part of the observed position list. If positions were not captured, apply/close interface options and relog before saving.

## Automatic N-map view preservation

Toolbox detects a supported game's resource path and installs the N-map fix at a safe startup. The fix preserves the visible map artwork's center relative to the N-map window. It accounts for transparent image padding using measured anchors from 500 supported map textures; 330 have an off-center artwork anchor. Unknown future textures fall back to the image rectangle center. New maps start centered by default. Drag the content once to save a preferred center offset; later map loads and zoom changes reuse that offset without a pan animation. The image center is kept inside the viewport. Large maps can still extend beyond the viewport at the selected zoom level.

Existing center offsets migrate once on the first valid loaded map, preserving its visible placement. Older experimental absolute-coordinate preferences are ignored. While the background image has no valid bounds, its content is withheld; an owner-bound frame callback positions and reveals it when geometry becomes available. Dragging uses bounds based on the same image center as restoration. A stationary click does not save a new alignment; only a completed content drag does. Map transitions cancel unfinished drags without saving their temporary coordinates. Map markers continue updating.
Compatibility follows the **actual resource checksum, not the server name**. The verified Asura build is supported; another server with the identical supported resource can use the same fix. Different or updated builds are left unchanged until a matching verified patch is added. Each game installation has its own detection and restore record. The settings module continues working when the map fix is unavailable.

The fix modifies the matching original game resource, with a hash-verified backup and atomic replacement. Already-patched resources are left alone. Unknown updates and damaged backups are never overwritten. This repository distributes only a small patch recipe, not the original game package. Private paths, preferences and backups stay under `data/`; keep that folder for recovery. No additional runtime is downloaded.

**Recovery:** completely close TERA and Toolbox, open `minimap.cmd` and choose **2 Restore**, then select the game. This restores its verified pre-installation backup and disables automatic map setup for that client. **1 Install** re-enables it; **3 Status** only reads the file. The command file is a fallback, not part of normal installation.

The drag correction has controlled bytecode tests for actual press/release handlers, both release-event orders, small-image drag limits, stationary clicks, map changes, delayed loading and N toggling, plus real-file upgrade/restore tests. The drag engine and image geometry in these tests are simulated. The artwork alignment and new-character restore were also confirmed working in live user testing. This does not establish exhaustive coverage of every map. Temporary minimap telemetry is removed from the release; old diagnostic preference keys are filtered without recording new logs.

## Personal data and recovery

`data/profiles.json` holds class templates, private character bars, shared settings and ownership metadata. `data/profiles.json.bak` is its recovery copy. Keep `data/` when updating; never share it publicly. Diagnostics are private under `logs/`. `restore-status.json` keeps at most 24 restore events for the latest login, including controller names and application status; it contains no character/account identifiers, key values, UI positions or raw settings.

Partial native saves are merged with the complete capture. A structurally valid window-position save can contain unusable rows: these are ignored while other valid edits are saved and the previous position of each rejected window is retained. Repeated names use their last valid entry. Packet structure, stored profiles and incoming server replies remain strictly validated. Filtered-entry counts are recorded in the bounded private restore-status report, without window names or coordinates. Initial/loading saves and failed deliveries cannot replace the source. Local writes are atomic, combined after 300 ms, and flushed on logout; this does not delay gameplay packets. Normal server saving continues. A damaged profile is recovered from a valid backup, with the damaged original preserved; without valid recovery, writes stop rather than clear your settings.

Snapshots from another major game patch are preserved but not applied automatically. Save a compatible source template after the patch, then use `vault load` to replace an older private bar deliberately.

Author: CEM.
