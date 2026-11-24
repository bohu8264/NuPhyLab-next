# Third-party notices

[Documentation](docs/README.md)

Original attribution, license notices and source references are retained below. This introduction does not replace or modify any license terms.

# Third-party acknowledgements

NuPhyLab is an independent local project. It is not endorsed by NuPhy or OpenAI.

## NuPhy protocol and layout research

The keyboard layout data in `shared/air75-v3-ansi.json` is adapted from ShallowRed/nuphy-leds, licensed under MIT. The USB implementation is informed by public research from ShallowRed/nuphy-leds, pda/kbvu and bohu8264/N-Agent-Bridge (MIT). No NuPhy firmware image or patched firmware is distributed.

- https://github.com/ShallowRed/nuphy-leds
- https://github.com/pda/kbvu
- https://github.com/bohu8264/N-Agent-Bridge

The physical map published by ShallowRed covers indices 0–82; firmware exposes 84 key-light channels. Index 83 remains unmapped by this application, preserved in scene arrays and set to black by default. Source maps disagree on a few positions; USB RGB readback validates channel data, not physical optical position.

## JavaScript runtime and UI

The macOS app bundles the Node.js runtime used for building. Node.js is distributed under its applicable licenses, including MIT and dependency licenses; the full license text accompanies the app in `runtime/LICENSE.node`. React and React DOM are MIT, Vite is MIT, Lucide is ISC. Their sources and licenses remain available in the npm lockfile and UI dependencies. Build tools are not required by the packaged app.

## React and React DOM — full license

The following license covers the bundled React and React DOM UI runtime code.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide — full license

The following license covers the bundled Lucide icon code.

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Sparkle

NuPhy Lab includes Sparkle 2.10.1 for signed macOS application updates.
Copyright Sparkle project contributors. Distributed under the MIT license; the framework includes its license and acknowledgements.
https://sparkle-project.org/

## Typing Sounds / 模拟声浪

Typing Sounds bundles 636 audio files: twelve tuned profiles derived from three CC0 recordings by Techrul, zrrion and grcekh, and six classic MIT-licensed sample sets from Thomas Lai’s Keyboard Simulator. Full credits, source links, transformation details and licenses are retained in `assets/typing-sounds/ATTRIBUTION.md`, `audio/CUSTOM_LICENSE.txt` and `audio/KBSIM_LICENSE.txt` (installed under Resources/typing-sounds). No recordings by the current user are included.

模拟声浪包含636个音频文件：基于Techrul、zrrion及grcekh三段CC0公开录音的12款调校音色，以及Thomas Lai Keyboard Simulator的6套MIT授权经典素材。完整作者、来源及许可随包保留，未包含本机用户录音。

## Salamander Grand Piano
30 MP3 samples from the Salamander Grand Piano v3 by Alexander Holm, licensed CC BY 3.0. Original: https://github.com/sfzinstruments/SalamanderGrandPiano . MP3 conversion: https://github.com/Tonejs/audio/tree/master/salamander . License: https://creativecommons.org/licenses/by/3.0/ . This edition uses one velocity layer and pitch shifts between samples; it is not the complete original library. The bundled music/piano/LICENSE.txt and ATTRIBUTION.txt include the license and attribution.

## Drag Convert


The drag observation and destination lifecycle implementation references and adapts MIT-licensed Swivel (Jonathan Lotan) and Kumquat (Ian Di Filippo). Convertino and Clementine were also reviewed as implementation references. Pinned revisions and scope are documented in docs/DRAG_CONVERT.md. Full MIT licence texts for all four projects are bundled in drag-convert-licenses and available in source under assets/drag-convert-licenses.

## libarchive

Build headers: upstream v3.7.4, native/drag/archive-headers/ORIGIN.json. Runtime links the macOS system libarchive.2. BSD license reproduced in assets/drag-convert-licenses/libarchive-BSD.txt. No third-party archive executables are bundled. QA-only compressed fixtures come from the same upstream libarchive/test release.

## libwebp 1.6.0

WebP 图片编码使用内置的 libwebp，BSD 许可及专利授权随包附带。
WebP image encoding uses the bundled libwebp library. Its BSD license and patent grant are included in `drag-convert-licenses/libwebp-COPYING.txt` and `libwebp-PATENTS.txt`.
Source: https://chromium.googlesource.com/webm/libwebp/
## Windows runtime and SQLite

The Windows preview bundles Node.js, Tauri 2 and the Rust crates recorded in Cargo.lock. Tauri and its updater plugin are MIT OR Apache-2.0. Windows uses its installed Microsoft WebView2 runtime; the NSIS installer can download the official bootstrapper when required.

SQLite 3.54.1 is public domain. The official x64 executable is downloaded with pinned SHA-256 and SHA3-256 archive checks and an independent executable SHA-256 check. Its public-domain notice accompanies the Windows app as runtime/LICENSE.sqlite. Source and public-domain information: https://www.sqlite.org/ and https://www.sqlite.org/copyright.html . SQLite is used for read-only local task metadata; no SQLite extensions are loaded.
