<div align="center">

# Big Shot

**Enhanced Screenshot & Screencast for Cinnamon**

A Cinnamon extension for capturing, annotating, and recording the desktop without leaving the Shell interface.

[![Cinnamon](https://img.shields.io/badge/Cinnamon-5.4--6.6-DC682E?logo=linuxmint&logoColor=white)](https://projects.linuxmint.com/cinnamon/) [![GJS](https://img.shields.io/badge/GJS-JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://gjs.guide/) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](https://www.kernel.org/) [![GStreamer](https://img.shields.io/badge/GStreamer-1.0-red)](https://gstreamer.freedesktop.org/) [![i18n](https://img.shields.io/badge/i18n-29_languages-green)](usr/share/cinnamon/extensions/big-shot@bigcommunity.org/po/)

</div>

---

## Preview

<div align="center">

_Screenshot and demonstration GIF placeholder_

<!--
Add the media files to docs/images/ and replace this comment with:

<img src="docs/images/big-shot-cinnamon.png" width="900" alt="Big Shot screenshot interface on Cinnamon">

<img src="docs/images/big-shot-cinnamon-demo.gif" width="900" alt="Big Shot screenshot and recording demonstration">
-->

</div>

---

## Overview

Big Shot replaces the basic Cinnamon screenshot workflow with a fullscreen capture interface inspired by GNOME's screenshot UI. Press `Print Screen` to select an area, window, or screen, annotate the result, or switch to screencast mode.

Main capabilities:

- Area, window, and fullscreen screenshots
- Area, window, and fullscreen video recording
- 16 annotation and privacy tools
- Live and paused video annotations
- Desktop audio and microphone capture
- Draggable webcam overlay with masks and size presets
- Hardware-accelerated and software video encoders
- Pause/resume with safe segment validation and merging
- Screenshot and recording completion notifications
- 29 translation catalogs

The capture UI, editing toolbar, recording controls, and webcam preview are integrated into Cinnamon. No separate editor window is required.

## Features

### Screenshot capture

- Capture a custom area, a window, or the active monitor
- Include or exclude the mouse pointer
- Shift-activated selection magnifier with 2x–6x zoom
- Correct logical and physical coordinate handling for scaled displays
- Floating, draggable editing toolbar
- Automatic PNG copy to the clipboard
- Save screenshots under `~/Pictures/Screenshots/`
- Completion notification that opens the screenshot folder when clicked
- Crop output, add configurable padding, and apply gradient backgrounds with rounded corners

### Annotation tools

| Tool | Description |
|------|-------------|
| **Select / Move** | Select, move, resize, or edit existing annotations |
| **Pen** | Freehand drawing with smoothed strokes |
| **Arrow** | Arrow with proportional head; hold Shift to constrain direction |
| **Line** | Straight line; hold Shift for horizontal or vertical snapping |
| **Rectangle** | Outlined or filled rectangle; hold Shift for a square |
| **Oval** | Outlined or filled ellipse; hold Shift for a circle |
| **Text** | Multiline text with font selection, wrapping, moving, and resizing |
| **Highlighter** | Semi-transparent marker strokes |
| **Censor** | Mosaic pixelation for sensitive information |
| **Blur** | Multi-pass blur over the selected region |
| **Invert Colors** | Invert real pixels inside the selected region |
| **Magnify / Zoom** | Create a movable zoom callout with optional caption |
| **Number** | Sequential numbered markers |
| **Number with Arrow** | Numbered marker connected to an arrow |
| **Number with Pointer** | Numbered marker connected to a pointer line |
| **Eraser** | Remove annotations |

### Editing controls

- Independent stroke and fill colors
- Color palettes for regular drawing and highlighting
- Adjustable brush size and privacy-effect intensity
- System font selector for text annotations
- Multiline text input: `Enter` inserts a new line and `Ctrl+Enter` confirms
- Full undo/redo history for creation, deletion, movement, resizing, and text edits
- Copy composited output to the clipboard
- Save composited output through a file chooser
- Draggable toolbar with hover feedback

### Screencast recording

| Feature | Description |
|---------|-------------|
| **Capture source** | Area, window, or fullscreen |
| **Framerate** | 15, 24, 30, or 60 FPS |
| **Resolution** | 100%, 75%, 50%, or 33% |
| **Quality** | High, Medium, or Low encoder presets |
| **Codec** | Automatic best available encoder or manual selection |
| **Desktop audio** | Capture the selected PulseAudio/PipeWire monitor source |
| **Microphone** | Capture a selected microphone or automatic default source |
| **Audio mix** | Record desktop audio and microphone together |
| **Pause / Resume** | Finalize the current segment, pause safely, then continue in a new segment |
| **Panel indicator** | Elapsed timer with pause/resume and stop controls |
| **Live editing** | Draw and edit annotations without pausing the recording |
| **Paused editing** | Enter editing automatically after pausing |
| **Privacy effects** | Censor, blur, invert, and zoom from a current screen frame |
| **Screenshot while recording** | Save and copy a PNG without interrupting the active video |
| **Recovery** | Preserve and validate recoverable recording sessions after interruption |

Recordings are saved under `~/Videos/BigShot/`. When finalization completes, Cinnamon displays a notification that opens this folder when clicked.

### Video annotation workflow

1. Start a recording from the capture interface.
2. Click the pencil in the recording indicator to enter live edit mode.
3. Draw, add multiline text, or apply privacy and zoom effects while recording continues.
4. Click Pause to finish the active segment and enter paused edit mode automatically.
5. Edit annotations while the recording remains paused.
6. Click Play to close paused editing and begin the next segment.
7. Stop the recording to validate and publish the final file.

Annotations remain visible after editing closes and are captured in subsequent video frames. The clear button removes all active video annotations.

### Webcam overlay

- Live GStreamer webcam preview
- Fully draggable overlay
- Five size presets: XS, S, M, L, and XL
- Position preserved while moving between preview and recording modes
- Eight mask styles:

| Mask | Appearance |
|------|------------|
| **None** | Full rectangular frame |
| **Circle** | Circular crop with a soft edge |
| **Oval** | Elliptical crop |
| **Soft** | Strong feathered circular edge |
| **Spotlight** | Bright center with darker edges |
| **Ornate** | Decorative gradient frame |
| **Checker** | Alternating transparent checker pattern |
| **Neon** | Bright colored border effect |

### Video encoders

Big Shot detects the GPU vendor and installed GStreamer elements, then prioritizes suitable encoders:

| Hardware | Encoder | Container |
|----------|---------|-----------|
| NVIDIA | `nvh264enc` | MP4 |
| AMD / Intel | `vah264lpenc` | MP4 |
| AMD / Intel | `vah264enc` | MP4 |
| AMD / Intel | `vaapih264enc` | MP4 |
| Software fallback | `openh264enc` | MP4 |
| Software fallback | `vp9enc` | WebM |

The Automatic option chooses the first compatible pipeline. The video settings panel can be used to select quality, codec, audio source, webcam mask, and webcam size.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Print Screen` | Open Big Shot |
| `1`–`9` | Select Pen, Arrow, Line, Rectangle, Oval, Text, Highlighter, Censor, or Number |
| `0` or `S` | Select / Move mode |
| `B` | Blur tool |
| `I` | Invert Colors tool |
| `E` | Eraser tool |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `Delete` or `Backspace` | Remove the selected or most recent annotation |
| `Escape` | Deselect an object or exit video edit mode |
| `Enter` | Insert a line break in multiline text |
| `Ctrl+Enter` | Confirm multiline text |
| `Ctrl+Scroll` | Adjust brush size or privacy-effect intensity |
| `Shift` while selecting | Show the selection magnifier |

## Recording architecture

### Direct GStreamer capture

On X11, Big Shot launches a direct GStreamer pipeline using `ximagesrc` and the selected global screen geometry. Capture dimensions are normalized to valid even encoder sizes, including downscaled output.

Desktop and microphone audio use PulseAudio-compatible GStreamer sources. This works with native PulseAudio and with PipeWire through its PulseAudio compatibility layer.

Audio branches are timestamped, clock-slaved, resampled, and normalized to stereo S16LE at 48 kHz before mixing and encoding.

On Wayland, Big Shot uses the XDG ScreenCast Portal to select a monitor or window, obtains the authorized PipeWire remote, and passes a duplicated descriptor to each recording segment. Area recording crops the selected monitor stream. A portal backend that implements `org.freedesktop.portal.ScreenCast` is required.

### Safe pause and resume

Pause/resume is segment-based rather than signal-based:

- Pause sends EOS to the active GStreamer pipeline and waits for the segment to settle.
- Resume creates a new segment with the original geometry, codec, quality, framerate, scale, and audio settings.
- Final stop validates streams and durations with `ffprobe`.
- Compatible segments are merged with `ffmpeg -f concat -c copy`.
- Temporary files are deleted only after the final output is validated and published.
- Interrupted sessions retain a recovery manifest and safe segments for recovery on the next extension start.
- Live-writer recovery verifies boot ID, PID start time, executable, and exact segment path before claiming an abandoned session.
- A durable output reservation reconciles crashes before or after the atomic final move without overwriting another recording.

### Annotation compositing

Screenshot output is composed in this order:

1. Pixel effects such as censor, blur, and invert use the captured `GdkPixbuf`.
2. Vector annotations are rendered with Cairo/Pango.
3. The selected region is saved as PNG and copied to the clipboard.

Video annotations use a Cinnamon Chrome overlay above application windows. Live and paused editors capture a base frame for pixel effects while preserving the interactive recording controls.

## Compatibility

| Component | Support |
|-----------|---------|
| **Cinnamon** | 5.4, 5.6, 5.8, 6.0, 6.2, 6.4, and 6.6 |
| **Display server** | X11 recommended and fully supported |
| **Wayland** | XDG ScreenCast Portal/PipeWire path implemented; requires a compatible portal backend and still needs runtime validation across supported Cinnamon releases |
| **Audio** | PulseAudio or PipeWire with PulseAudio compatibility |
| **Video** | GStreamer 1.0 |
| **Webcam** | V4L2 devices supported by GStreamer |
| **Packaging** | Arch Linux and Arch-based distributions through the included PKGBUILD |

## Installation

### Arch Linux package

```bash
cd pkgbuild
makepkg -si
```

Log out and back in after installation so Cinnamon loads the extension and its JavaScript modules from a clean session.

### Build an extension archive

```bash
chmod +x build.sh
./build.sh
```

The script compiles translations, updates the date-based version, and creates `big-shot-cinnamon.zip`.

For a per-user test installation:

```bash
mkdir -p ~/.local/share/cinnamon/extensions/big-shot@bigcommunity.org
unzip -o big-shot-cinnamon.zip \
  -d ~/.local/share/cinnamon/extensions/big-shot@bigcommunity.org
```

Then enable **Big Shot** in **System Settings → Extensions** and restart the Cinnamon session.

## Dependencies

### Runtime

| Package | Purpose |
|---------|---------|
| `cinnamon` >= 5.4 | Shell and extension runtime |
| `ffmpeg` | Segment validation, recovery, and final merging |
| `gstreamer` | Recording pipeline and element inspection |
| `gst-plugins-base` | Core conversion, queue, caps, and audio mixing elements |
| `gst-plugins-good` | PulseAudio sources, VP9, and common muxers |
| `gst-plugins-bad` | OpenH264 and additional recording elements |
| `gst-plugin-pipewire` | Authorized PipeWire stream capture on Wayland |
| `xdg-desktop-portal` | ScreenCast permission and PipeWire remote handoff on Wayland |
| `gst-plugin-va` | Modern VA-API H.264 encoders |
| `pciutils` | GPU vendor detection through `lspci` |

### Optional

| Package | Purpose |
|---------|---------|
| `gst-plugins-ugly` | Additional GStreamer codecs such as x264, MPEG-2, and A52 |

### Build

| Package | Purpose |
|---------|---------|
| `gettext` | Compile `.po` catalogs into `.mo` files |
| `zip` | Create `big-shot-cinnamon.zip` with `build.sh` |

## Translations

The repository includes catalogs for 29 languages:

| | | | | |
|:---:|:---:|:---:|:---:|:---:|
| Bulgarian | Czech | Danish | German | Greek |
| English | Spanish | Estonian | Finnish | French |
| Hebrew | Croatian | Hungarian | Icelandic | Italian |
| Japanese | Korean | Dutch | Norwegian | Polish |
| Portuguese | Portuguese (Brazil) | Romanian | Russian | Slovak |
| Swedish | Turkish | Ukrainian | Chinese | |

Translation sources are stored in [`po/`](usr/share/cinnamon/extensions/big-shot@bigcommunity.org/po/). The build script compiles every `<locale>.po` file to `locale/<locale>/LC_MESSAGES/big-shot@bigcommunity.org.mo`.

## Troubleshooting

### Changes do not appear after installation

Cinnamon caches imported extension modules for the lifetime of the session. Log out and back in after replacing JavaScript files.

### Recording does not start

Check that `ffmpeg`, `ffprobe`, `gst-launch-1.0`, and at least one supported video encoder are installed:

```bash
gst-inspect-1.0 openh264enc
gst-inspect-1.0 vp9enc
ffmpeg -version
ffprobe -version
```

### Hardware encoding is unavailable

Big Shot automatically falls back to software encoding. Install the appropriate NVIDIA or VA-API GStreamer plugin to expose a hardware encoder.

### Diagnostic logs

On Cinnamon/X11, extension messages are commonly available in:

```bash
tail -f ~/.xsession-errors
```

Search for the `[Big Shot]` prefix when reporting recording or capture problems.

## Development

Extension source:

```text
usr/share/cinnamon/extensions/big-shot@bigcommunity.org/
├── extension.js       # Lifecycle, recording pipeline, finalization, recovery
├── screenshotUI.js    # Capture interface and screenshot output
├── parts/             # Toolbar, audio, webcam, indicators, and feature modules
├── drawing/           # Annotation actions and overlay
├── data/              # Icons and static data
└── po/                # Gettext catalogs
```

Focused checks before committing:

```bash
node --check usr/share/cinnamon/extensions/big-shot@bigcommunity.org/extension.js
node --check usr/share/cinnamon/extensions/big-shot@bigcommunity.org/screenshotUI.js
git diff --check
```

## Acknowledgments

Big Shot was inspired by and based on [GNOME Shell Screencast Extra Feature](https://github.com/WSID/gnome-shell-screencast-extra-feature), which provided the original foundation for enhanced screencasting, audio capture, GPU detection, and pipeline selection.

The Cinnamon edition shares its feature direction with [Big Shot for GNOME Shell](https://github.com/big-comm/gnome-shell-big-shot) while using a Cinnamon-specific capture UI, event model, and direct GStreamer recording path.

## License

[MIT](LICENSE) — Copyright © 2024–2026 BigCommunity
