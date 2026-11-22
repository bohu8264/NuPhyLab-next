# NuPhy Lab release workflow

[Documentation index](README.md) · [简体中文](RELEASING.md)

[NuPhy Lab releases](https://github.com/bohu8264/NuPhyLab-next/releases)

Write the English project description, README and GitHub release notes first, followed by the complete Simplified Chinese text. On bilingual pages, link to both languages at the top. Before publishing, preview the README and release notes on GitHub and check the language order and download links.

1. Increase the version in `package.json` and add `updates/release-notes/<version>.json`. Its `version` must match exactly. Both `zh-CN` and `en` arrays must describe changes actually completed for this version, without generic or placeholder text. Run `npm run build` and `npm test`.
2. Package with a valid NuPhy Developer ID identity. Do not distribute ad-hoc-signed builds. `scripts/signing.mjs` signs Sparkle's nested code individually.
3. Notarize and staple the app before creating the DMG. Sign, notarize and staple the final DMG, then verify its embedded app. The notarization keychain profile is `nuphy-notary`.
4. The final installer filename must contain `-<version>-`. Run `node scripts/prepare-appcast.mjs /absolute/path/to/final-installer.dmg /absolute/path/to/new-output-directory` to generate the signed update feed. The script checks both languages of release notes, mounts the final DMG read-only, verifies the app signature, both version fields and the notes fingerprint saved in `update-metadata.json`, then unmounts it. Sparkle signs the embedded notes together with the update. The script checks the feed version, complete download URL, byte length and notes; `FEED_VERIFICATION.json` records installer and notes SHA-256 values. Changing embedded notes after packaging requires a new package, signature and notarization; do not edit only the feed. Do not modify signed XML or embedded notes. The update private key stays in the local keychain, with its account referenced by `config/updates.json`; never export it to source or GitHub.
5. Upload verified source to the current repository, create the matching version tag and GitHub Release, and upload the versioned final DMG plus a byte-identical copy named `NuPhyLab-macOS-AppleSilicon.dmg`. The fixed-name copy must come from the same signed, notarized and stapled package; do not regenerate or alter its contents. Keep the release as a draft until verified, then publish it as the Latest stable release.
6. Download the DMG through both the versioned public URL and the fixed URL below. Verify both byte lengths and SHA-256 values against the final package; the fixed link must resolve to the new version. Every stable release must include the fixed-name asset. Only after public downloads work, commit the generated `appcast.xml` unchanged to `main/updates/appcast.xml`. Do not hand-edit signed XML. The feed continues to use the immutable, versioned installer URL.
7. Use the previous app version to verify the entire **Check for Updates → download → install → reopen** flow, including retention of artwork, settings and permissions.

## Permanent download link

[Latest Apple Silicon installer](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg)

GitHub resolves this link through the Latest stable release. Do not mark preview releases as Latest. Before switching a stable release to Latest, confirm its draft contains the fixed-name asset to avoid a broken link.


## Update behavior and verification

The app checks for updates hourly in the background. Being offline does not affect keyboard use. Users can check manually from the application menu or Device page. Release notes and packages are verified with Ed25519; the package must also pass Developer ID verification. Before installation, stop lighting and confirm the keyboard has been safely released. Do not include device recovery records in release packages.

The update window uses Sparkle's public `SPUUserDriver` interface. Version numbers and release notes come from the signed feed. The window title, Update / Later / Skip controls, progress, no-update state and errors follow the app's language, including when it differs from the macOS language. An open update window follows language changes. Sparkle still handles download, verification, installation and relaunch; do not change `AppleLanguages`, the system language or global Bundle behavior.

Choosing Later suppresses automatic reminders for that version for at least 24 hours. A new version does not inherit that postponement, and manual checks remain available. Sparkle records Skip for that version only. Verify both Chinese and English: the version number, version-specific notes, repeat background checks after Later, checks for a newer version and manual checks. Offline simulations do not count as live signed download and installation acceptance.

The updater is included starting with 1.2.1. Users on 1.1.4 or earlier must install a current version manually first.

Hardware acceptance must cover AIR75 V3 and Kick75 separately: lighting, function keys, drawing, animations, games, triggers, audio-reactive lighting, repeated reconnection, and sleep/wake. Never record offline tests as physical-device passes when the hardware is unavailable.
