# NuPhy Lab

A macOS lighting studio for **NuPhy AIR75 V3 and Kick75 (ANSI)**. Connect USB to detect the keyboard automatically. Artwork stays separate for each model.

Includes drawing, animation, key-triggered effects, games, audio reactive lighting, a local artwork library, and Codex / Claude Code task shortcuts and status lights. AIR75 V3 also supports Bluetooth shortcut control; lighting requires USB.

## Install

Download the signed and Apple-notarized DMG from [Releases](https://github.com/bohu8264/NuPhyLab-next/releases), then drag **NuPhy Lab** to Applications. The current release requires Apple Silicon and macOS 13.5 or later.

Allow Input Monitoring and Accessibility when prompted. Audio permissions are requested when using audio reactive lighting. Switch the keyboard to wired mode. If its firmware needs updating, follow the NuPhyIO reminder, close the website after the upgrade, then return to the app.

Version 1.2.2 includes signed in-app updates. New releases appear automatically, or choose **Check for Updates** in the app menu or Device page. Artwork and settings remain intact. Users on 1.1.x need to install 1.2.2 once manually.

## Build

Requires macOS, Xcode command line tools and Node.js 22 or newer.

```sh
npm run setup
npm run build
npm test
npm start
```

The native build downloads a pinned, checksum-verified Sparkle framework. Run `npm run fetch-node` to fetch the standalone runtime, then `npm run package`. Follow [the release workflow](docs/RELEASING.md) for distribution signing, notarization and update verification.

The existing bundle identifier and local data directory remain compatible. Diagnostics stay on the Mac. Update checks never upload task contents, artwork or keyboard input. Protocol verification remains required before keyboard writes.

[简体中文说明](README.zh-CN.md)
