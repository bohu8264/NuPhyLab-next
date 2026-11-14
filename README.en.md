# NuPhy Lab — English guide

[中文 / English home](README.md) · [简体中文指南](README.zh-CN.md)

NuPhy Lab is a macOS lighting studio for **NuPhy AIR65 / AIR75 / AIR100 V3, NODE75 / NODE100 (LP / HP), and Kick75 (ANSI)**. Connect a keyboard by USB to detect the model automatically. Artwork stays separate for each model.

It includes drawing, animation, key-triggered effects, games, audio-reactive lighting, a local artwork library, and Codex / Claude Code task shortcuts and status lights.

## Feature Center and Library

For new users, the sidebar starts with Lighting Studio, Library and AI Assistant. Upgrading keeps entries for tools already used or enabled; you can remove them at any time. Open **Feature Center** to add Lighting Games, Typing Sounds, Music Mode, Smart Selection, Drag Convert or Keyboard Pocket. The three default entries can also be removed. Feature Center, Device and Settings always remain available. Removing an entry only hides it; content, preferences and feature switches stay as they are.

**Library** brings lighting and music together, with All, Lighting and Music filters. Music Mode opens this same library. Editing and saving updates the original work. If its editor is not in the sidebar, choose **Add Music Mode & edit** or **Add Lighting Studio & edit**. Music works support preview, duplication, renaming, project export and recovery from Recently deleted. Export WAV audio from the music editor.

[Feature Center and unified Library guide](docs/FEATURE_CENTER.md)

## Download and install

**[Download the latest macOS installer](https://github.com/bohu8264/NuPhyLab-next/releases/latest/download/NuPhyLab-macOS-AppleSilicon.dmg)**

Requires **Apple Silicon and macOS 13.5 or later**. The DMG is signed with NuPhy's Developer ID and notarized by Apple.

[Latest release and notes](https://github.com/bohu8264/NuPhyLab-next/releases/latest) · [Previous versions](https://github.com/bohu8264/NuPhyLab-next/releases)

1. Quit the old NuPhy Lab app before installing.
2. Open the DMG and drag **NuPhy Lab** to Applications. Replace the existing app if prompted, and keep one installed copy. Keep the app-data folder to retain your artwork, drafts and settings.
3. Connect the keyboard with a USB data cable and select wired mode. Follow the app's permission and firmware guidance.

Allow Input Monitoring and Accessibility when prompted. The app may automatically close and reopen once to apply newly granted permissions. Audio permissions are requested when using audio-reactive lighting.

If the keyboard needs a firmware update, follow the NuPhyIO reminder, close the website after upgrading, then return to NuPhy Lab.

See [keyboard compatibility](docs/KEYBOARD_COMPATIBILITY.md) for firmware requirements and validation coverage. AIR65 V3 has no physical function row and does not offer automatic F1–F12 takeover.

## Automatic backlight

Enable automatic backlighting in **Settings → Lighting and sleep** to turn Lab lighting off or keep a faint glow in bright surroundings, brighten smoothly in dim surroundings, and optionally learn manual brightness preferences per keyboard model. It starts off, requires ambient-light support on the Mac, and applies only to compatible per-key lighting played by Lab over USB. Unavailable readings or a closed lid fall back to manual brightness. [Full guide](docs/AMBIENT_BACKLIGHT.md)

## Typing Sounds

Add **Typing Sounds** in **Feature Center**, then open it from the sidebar. Choose from 18 sounds: three each in Marbly, Creamy, Woody, Soft, Tactile and Retro. Preview and save favorites, and adjust master volume, release strength, natural variation, and separate levels for Space, Return, Backspace, left/right Shift, Tab and Caps Lock.

The feature starts off. Enable it to play sounds while typing in other apps. All sounds are bundled and need no download or API. Previews need no Input Monitoring permission; typing playback does. Typing Sounds does not record text or upload input. [Usage and sound credits](docs/TYPING_SOUNDS.md)

## Performance

Open **Feature Center → Add Music Mode** to turn your computer keyboard into an instrument: six sounds, eight drum pads, a 16-step sequencer, and eight assignable clip slots. The library includes 18 original presets and 36 clips. Choose a slot before choosing its clip, then make the arrangement your own.

Recordings and edits autosave locally. Duplicate, rename or restore deleted works, and export projects or WAV audio. Sounds are bundled; no API or microphone permission is needed. Performance keys work only while this window is in front. Switching apps releases held notes; minimizing or sleeping stops playback. Loops and previews may continue after an ordinary app switch; press Esc or Stop to end them. [Usage, sound credits and limitations](docs/PERFORMANCE.md)

If a work is deleted or restored while a save is pending, saving from the old page pauses. Export the current project as a backup before using **Window → Recover Performance Page** to reopen the saved work.

## AI Assistant

Enable Codex mode in AI Assistant to use the default command keys:

| Key | Action |
| --- | --- |
| F7 | Switch between Standard and Fast |
| F8 | Allow the current approval request once |
| F9 | Deny the current approval request |
| F10 | Open a new chat |
| F11 | Hold to dictate; release to finish |
| F12 | Send from the focused chat composer |

F8 and F9 require a current approval request. F12 requires the chat composer to be focused. Command assignments can be changed in AI Assistant.

## Smart Selection

Enable any of Translate, Summarize, Explain and Reply; scrolling skips disabled actions. Results appear in the answer panel.

Selection requires **macOS 14 or later**. Keyboard features continue to support macOS 13.5.

1. Open **Settings → Models & API**, choose a service and model, and save your own API key. Choose from model presets, load account models where supported, or enter a custom model ID and compatible endpoint.
2. Enable **Feature Center → Add Smart Selection** and grant Accessibility, Input Monitoring and Screen Recording access. The app checks permissions and the actual shortcut listener.
3. Hold the shortcut, drag over a region and release to run the default action. Scroll during selection to switch between translation, summary, explanation and reply. The default shortcut is **Option–Shift–Q** and can be changed.
4. Choose one of 16 targets under **Translate to**, including Chinese, English, Japanese and Korean. You can also change the target in the answer panel. The choice is saved independently of the interface language.

You can also use a mouse side button: click the shortcut control, then press and release the side button to save it. Hold that button and move the mouse to select a region; release to finish, without holding the left button.

Choose **Reply**, select the other person’s message, and optionally say your preferred tone or points, such as “Thank them for the invitation and politely decline.” The result is a ready-to-copy reply; without spoken requirements, it is drafted from the conversation. Replies use the conversation’s language unless you request another language.

For spoken questions, enable **Hold to speak** and allow Microphone and Speech Recognition access. Speech is transcribed locally; recordings are not uploaded. The image switch below it allows selected images to be included when needed. The model and endpoint must support image input.

Selected text, questions and any enabled images needed for the selected action are sent to your configured model service. API keys stay in the local Keychain. Selection and voice are disabled by default for new users.

[Full setup and usage](docs/SELECTION.md) · [Models, images and permissions](docs/SELECTION_R2.md) · [Interface and translation languages](docs/SELECTION_LANGUAGES.md) · [What's new in 1.2.47](docs/RELEASE_1.2.47.md)

## Keyboard Pocket

Enable **Feature Center → Add Keyboard Pocket** to store text, images, links or files in nine slots. Contents and undo history stay on this Mac; no API is needed. Click a store, retrieve or slot shortcut, then press and release your chosen keys to save it.

Hold a store or retrieve prefix to unfold the preview from the notch, or the top center on displays without one. Release to dismiss. You can also turn previews off and use a prefix plus a slot key directly.

Folder slots offer **Copy ZIP** for pasting into chat apps, preserving Chinese filenames. Shortcut retrieval of folders into Feishu also prepares a local ZIP. Originals remain unchanged. Feishu may send pasted attachments directly and controls whether confirmation appears; Lab never clicks Send.

The feature starts off, and automatic copying and pasting require Accessibility access. File slots reference originals. If an older slot lacks saved access, reselect its original files when prompted. Moving or deleting originals, or using an app without file-paste support, may prevent retrieval. [Full guide](docs/KEYBOARD_POCKET.md)

## Updates and compatibility

NuPhy Lab includes signed in-app updates. It checks for new releases automatically, or you can choose **Check for Updates** in the application menu or **Settings → About & updates**. Artwork, drafts and settings are retained. Users on 1.1.x need to install the current app once manually.

Lighting requires USB. AIR75 V3 also supports Bluetooth shortcut control. The current keyboard layouts are ANSI.

Diagnostics stay on the Mac. Update checks do not upload task contents, artwork or keyboard input.

## Source and development

[Source code](https://github.com/bohu8264/NuPhyLab-next/tree/main) · [Releases](https://github.com/bohu8264/NuPhyLab-next/releases)

Building requires macOS, Xcode command line tools and Node.js 22 or newer.

```sh
npm run setup
npm run build
npm test
npm start
```

Before `npm start`, quit the installed NuPhy Lab app and other keyboard control software. The source server uses live local data and may automatically connect a keyboard; automated regression tests use isolated fixtures.

The native build downloads a pinned, checksum-verified Sparkle framework. Run `npm run fetch-node` to fetch the standalone runtime, then `npm run package`. Follow the [release workflow](docs/RELEASING.en.md) for distribution signing, notarization and update verification.

[Documentation index](docs/README.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Report an issue](https://github.com/bohu8264/NuPhyLab-next/issues)

## Drag Convert

Enable **Feature Center → Add Drag Convert**, drag files from Finder, press Shift (or hold it before dragging), then release over a menu option. Shift is the default trigger. Choose a single modifier, letter, number, arrow or another supported key on the page. Processing stays on your Mac. Originals are kept and duplicate output names are numbered. Progress, cancellation and the last 20 batches stay on the page, without an extra result window. No API or model download is required.

[Features and formats](docs/DRAG_CONVERT.md)

