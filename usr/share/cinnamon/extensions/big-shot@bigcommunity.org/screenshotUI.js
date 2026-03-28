/**
 * Big Shot — Screenshot UI for Cinnamon
 *
 * Fullscreen modal overlay providing GNOME-like screenshot functionality.
 * Shows captured screen as background with a dark pill-shaped bottom toolbar
 * for mode selection, capture actions, and screencast controls.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Meta = imports.gi.Meta;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;
const Cinnamon = imports.gi.Cinnamon;
const Cairo = imports.gi.cairo;
const Signals = imports.signals;
const Main = imports.ui.main;

let _ = function(str) { return str; };

// Screenshot modes
var UIMode = {
    SCREENSHOT: 0,
    SCREENCAST: 1,
};

var SelectionMode = {
    SCREEN: 0,
    WINDOW: 1,
    AREA: 2,
};

// Selection handle constants
const HANDLE_SIZE = 12;
const HANDLE_BORDER = 2;
const MIN_SELECTION = 10;
const BAR_BOTTOM_MARGIN = 40;

/**
 * ScreenshotUI — fullscreen capture overlay for Cinnamon.
 *
 * Public API consumed by extension.js and parts/*:
 *   .actor              — main fullscreen widget
 *   .shotButton         — St.Button (toggle: checked=screenshot, !checked=screencast)
 *   .panel              — bottom bar St.BoxLayout
 *   .controlContainer   — right-side container for extra part buttons
 *   .editArea           — overlay area for toolbar/drawing
 *   .visible            — whether the UI is shown
 *   .screencastInProgress — getter/setter for screencast state
 *   .open(mode)         — activate the UI (0=screenshot, 1=screencast)
 *   .close()            — deactivate the UI
 *   .getSelectedGeometry() — returns [x, y, w, h]
 *   .getScreenshotPixbuf() — returns the captured GdkPixbuf
 *
 * Signals:
 *   'opened'            — UI shown
 *   'closed'            — UI hidden
 *   'screenshot-ready'  — emitted with pixbuf after capture
 *   'screenshot-taken'  — emitted with file path after save
 *   'screencast-requested' — user clicked capture in screencast mode
 *   'notify::visible'   — visibility changed
 */
var ScreenshotUI = class ScreenshotUI {
    constructor(extensionPath) {
        this._extensionPath = extensionPath;
        this._visible = false;
        this._mode = UIMode.SCREENSHOT;
        this._selectionMode = SelectionMode.AREA;
        this._isModal = false;
        this._screenshotPixbuf = null;
        this._screenshotSurface = null;
        this._scale = 1;
        this._annotationCompositor = null;

        // Selection rectangle (screen coords)
        this._selX = 0;
        this._selY = 0;
        this._selW = 0;
        this._selH = 0;
        this._isSelecting = false;
        this._selAnchorX = 0;
        this._selAnchorY = 0;
        this._dragHandle = null;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._selStartX = 0;
        this._selStartY = 0;
        this._selStartW = 0;
        this._selStartH = 0;

        // Screencast state
        this._screencastInProgress = false;
        this._layoutIdleId = 0;
        this._layoutDelayId = 0;
        this._recenterIdleId = 0;

        this._buildUI();
    }

    static setGettext(fn) {
        _ = fn;
    }

    get visible() {
        return this._visible;
    }

    get shotButton() {
        return this._shotBtn;
    }

    get panel() {
        return this._bottomBar;
    }

    get controlContainer() {
        return this._controlBox;
    }

    get pointerButton() {
        return this._pointerBtn;
    }

    get editArea() {
        return this._editArea;
    }

    get screencastInProgress() {
        return this._screencastInProgress;
    }

    set screencastInProgress(val) {
        this._screencastInProgress = val;
    }

    // =========================================================================
    // UI CONSTRUCTION
    // =========================================================================

    _buildUI() {
        let monitor = Main.layoutManager.primaryMonitor;

        // Root fullscreen actor — FixedLayout for manual child positioning.
        // Children are allocated at their set_position coords with their
        // preferred (or explicitly set) size.
        this.actor = new St.Widget({
            name: 'big-shot-ui',
            reactive: true,
            visible: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.actor.add_style_class_name('big-shot-ui');
        this.actor.set_size(monitor.width, monitor.height);
        this.actor.set_position(monitor.x, monitor.y);

        // Screenshot preview background (Clutter.Image texture)
        this._previewActor = new Clutter.Actor({ reactive: false });
        this._previewActor.set_position(0, 0);
        this._previewActor.set_size(monitor.width, monitor.height);
        this.actor.add_child(this._previewActor);

        // Selection / dim overlay (Cairo-painted)
        this._selectionOverlay = new St.DrawingArea({ reactive: true });
        this._selectionOverlay.set_position(0, 0);
        this._selectionOverlay.set_size(monitor.width, monitor.height);
        this._selectionOverlay.connect('repaint', (area) => {
            this._paintSelection(area);
        });
        this.actor.add_child(this._selectionOverlay);

        // Edit area for annotation toolbar / drawing overlay
        this._editArea = new St.Widget({
            reactive: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._editArea.set_position(0, 0);
        this._editArea.set_size(monitor.width, monitor.height);
        this.actor.add_child(this._editArea);

        // Build bottom toolbar
        this._buildBottomBar();

        // Input handling on selection overlay
        this._selectionOverlay.connect('button-press-event', (actor, event) => {
            return this._onButtonPress(event);
        });
        this._selectionOverlay.connect('button-release-event', (actor, event) => {
            return this._onButtonRelease(event);
        });
        this._selectionOverlay.connect('motion-event', (actor, event) => {
            return this._onMotion(event);
        });
        this.actor.connect('key-press-event', (actor, event) => {
            return this._onKeyPress(event);
        });

        // Register with Cinnamon's chrome
        Main.layoutManager.addChrome(this.actor, {
            affectsInputRegion: true,
            affectsStruts: false,
        });
        this.actor.hide();
    }

    _buildBottomBar() {
        // Pill-shaped dark bottom bar
        this._bottomBar = new St.BoxLayout({
            style_class: 'big-shot-bottom-bar',
            reactive: true,
            vertical: false,
        });

        // Auto-center bar when its preferred width changes
        this._lastBarNatW = 0;
        this._bottomBar.connect('queue-relayout', () => {
            if (!this._visible) return;
            // Defer recentering to after layout completes
            if (this._recenterIdleId) return;
            this._recenterIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._recenterIdleId = 0;
                if (!this._visible) return GLib.SOURCE_REMOVE;
                let natW = this._bottomBar.get_preferred_width(-1)[1];
                if (natW !== this._lastBarNatW) {
                    this._lastBarNatW = natW;
                    this._positionBottomBar();
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        // ── Left group: selection mode buttons ──
        this._modeBox = new St.BoxLayout({
            style_class: 'big-shot-mode-box',
            vertical: false,
            style: 'spacing: 2px;',
        });

        this._areaBtn = new St.Button({
            style_class: 'big-shot-mode-button',
            toggle_mode: true,
            can_focus: true,
            label: _('Area'),
            checked: true,
        });
        this._areaBtn.connect('clicked', () => {
            this._setSelectionMode(SelectionMode.AREA);
        });
        this._modeBox.add_child(this._areaBtn);

        this._screenBtn = new St.Button({
            style_class: 'big-shot-mode-button',
            toggle_mode: true,
            can_focus: true,
            label: _('Fullscreen'),
        });
        this._screenBtn.connect('clicked', () => {
            this._setSelectionMode(SelectionMode.SCREEN);
        });
        this._modeBox.add_child(this._screenBtn);

        this._windowBtn = new St.Button({
            style_class: 'big-shot-mode-button',
            toggle_mode: true,
            can_focus: true,
            label: _('Window'),
        });
        this._windowBtn.connect('clicked', () => {
            this._setSelectionMode(SelectionMode.WINDOW);
        });
        this._modeBox.add_child(this._windowBtn);

        this._bottomBar.add_child(this._modeBox);

        // ── Separator ──
        this._bottomBar.add_child(new St.Widget({
            style: 'width: 1px; background-color: rgba(255,255,255,0.15); margin: 4px 8px;',
        }));

        // ── Photo/Video toggle pair ──
        this._toggleBox = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 2px;',
        });

        this._photoBtn = new St.Button({
            style_class: 'big-shot-type-button',
            toggle_mode: true,
            can_focus: true,
            checked: true,
        });
        this._photoBtn.set_child(new St.Icon({
            icon_name: 'camera-photo-symbolic',
            icon_size: 20,
        }));
        this._photoBtn.connect('clicked', () => {
            this._setUIMode(UIMode.SCREENSHOT);
        });
        this._toggleBox.add_child(this._photoBtn);

        this._videoBtn = new St.Button({
            style_class: 'big-shot-type-button',
            toggle_mode: true,
            can_focus: true,
            checked: false,
        });
        this._videoBtn.set_child(new St.Icon({
            icon_name: 'camera-web-symbolic',
            icon_size: 20,
        }));
        this._videoBtn.connect('clicked', () => {
            this._setUIMode(UIMode.SCREENCAST);
        });
        this._toggleBox.add_child(this._videoBtn);

        // Keep backward compatibility — shotButton returns the photo button
        this._shotBtn = this._photoBtn;

        this._bottomBar.add_child(this._toggleBox);

        // ── Separator ──
        this._bottomBar.add_child(new St.Widget({
            style: 'width: 1px; background-color: rgba(255,255,255,0.15); margin: 4px 8px;',
        }));

        // ── BIG capture button (changes icon based on mode) ──
        this._captureBtn = new St.Button({
            style_class: 'big-shot-capture-button',
            can_focus: true,
            style: 'border-radius: 22px; min-width: 44px; min-height: 44px; '
                 + 'background-color: rgba(255,255,255,0.15); padding: 0;',
        });
        this._captureIcon = new St.Icon({
            icon_name: 'camera-photo-symbolic',
            icon_size: 22,
            style: 'color: white;',
        });
        this._captureBtn.set_child(this._captureIcon);
        this._captureBtn.connect('clicked', () => {
            this._onCapture();
        });
        this._bottomBar.add_child(this._captureBtn);

        // ── Separator ──
        this._bottomBar.add_child(new St.Widget({
            style: 'width: 1px; background-color: rgba(255,255,255,0.15); margin: 4px 8px;',
        }));

        // ── Control container for part buttons (Desktop, Mic, Webcam, 100%, 30fps) ──
        this._controlBox = new St.BoxLayout({
            style_class: 'big-shot-control-box',
            vertical: false,
            style: 'spacing: 4px;',
        });
        this._controlBox.connect('actor-added', () => {
            this._scheduleBarPosition();
        });
        this._controlBox.connect('actor-removed', () => {
            this._scheduleBarPosition();
        });
        this._bottomBar.add_child(this._controlBox);

        // ── Show pointer toggle ──
        this._includeCursor = false;
        this._pointerBtn = new St.Button({
            style_class: 'big-shot-type-button',
            toggle_mode: true,
            can_focus: true,
        });
        let pointerIcon = new St.Icon({
            icon_name: 'input-mouse-symbolic',
            icon_size: 16,
            style: 'color: white;',
        });
        this._pointerBtn.set_child(pointerIcon);
        this._pointerBtn.connect('notify::checked', () => {
            this._includeCursor = this._pointerBtn.checked;
        });
        this._bottomBar.add_child(this._pointerBtn);

        // ── Close button ──
        this._closeBtn = new St.Button({
            style_class: 'big-shot-action-button big-shot-action-cancel',
            can_focus: true,
        });
        let closeIcon = new St.Icon({
            icon_name: 'window-close-symbolic',
            icon_size: 16,
        });
        this._closeBtn.set_child(closeIcon);
        this._closeBtn.connect('clicked', () => {
            this.close();
        });
        this._bottomBar.add_child(this._closeBtn);

        // Add bar to actor — position will be set manually
        this.actor.add_child(this._bottomBar);
    }

    /**
     * Switch between photo and video modes.
     * Updates toggle buttons and the big capture button icon.
     */
    _setUIMode(mode) {
        this._mode = mode;
        let isPhoto = (mode === UIMode.SCREENSHOT);
        this._photoBtn.checked = isPhoto;
        this._videoBtn.checked = !isPhoto;

        if (isPhoto) {
            this._captureIcon.icon_name = 'camera-photo-symbolic';
            this._captureBtn.style = 'border-radius: 22px; min-width: 44px; min-height: 44px; '
                                   + 'background-color: rgba(255,255,255,0.15); padding: 0;';
        } else {
            this._captureIcon.icon_name = 'media-record-symbolic';
            this._captureBtn.style = 'border-radius: 22px; min-width: 44px; min-height: 44px; '
                                   + 'background-color: rgba(224,27,36,0.85); padding: 0;';
        }

        // Recenter bar when mode changes (control buttons visibility changes)
        this._scheduleBarPosition();
    }

    /**
     * Position the bottom bar centered horizontally, near the bottom of
     * the screen. Called after show and whenever layout may have changed.
     */
    _positionBottomBar() {
        let monitor = Main.layoutManager.primaryMonitor;
        let natW = this._bottomBar.get_preferred_width(-1)[1];
        let natH = this._bottomBar.get_preferred_height(-1)[1];
        let x = Math.round((monitor.width - natW) / 2);
        let y = monitor.height - natH - BAR_BOTTOM_MARGIN;
        this._bottomBar.set_position(x, y);
    }

    /**
     * Schedule a bar reposition on the next idle cycle, ensuring the
     * bar's preferred size has been computed after children are added.
     */
    /**
     * Schedule a bar reposition with enough delay for children to be laid out.
     * Uses two phases: immediate layout tick + delayed followup.
     */
    _scheduleBarPosition() {
        if (this._layoutIdleId !== 0) {
            GLib.source_remove(this._layoutIdleId);
        }
        if (this._layoutDelayId) {
            GLib.source_remove(this._layoutDelayId);
            this._layoutDelayId = 0;
        }
        // Phase 1: idle — earliest possible after current frame
        this._layoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._layoutIdleId = 0;
            if (this._visible) {
                this._positionBottomBar();
            }
            return GLib.SOURCE_REMOVE;
        });
        // Phase 2: delayed — after children have computed their sizes
        this._layoutDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._layoutDelayId = 0;
            if (this._visible) {
                this._positionBottomBar();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // =========================================================================
    // SELECTION MODE
    // =========================================================================

    _setSelectionMode(mode) {
        this._selectionMode = mode;
        this._screenBtn.checked = (mode === SelectionMode.SCREEN);
        this._windowBtn.checked = (mode === SelectionMode.WINDOW);
        this._areaBtn.checked = (mode === SelectionMode.AREA);

        let monitor = Main.layoutManager.primaryMonitor;
        if (mode === SelectionMode.SCREEN) {
            this._selX = 0;
            this._selY = 0;
            this._selW = monitor.width;
            this._selH = monitor.height;
        } else if (mode === SelectionMode.WINDOW) {
            // Find the focused window or topmost normal window
            this._updateWindowSelection();
        } else if (mode === SelectionMode.AREA) {
            this._selX = Math.round(monitor.width * 0.2);
            this._selY = Math.round(monitor.height * 0.2);
            this._selW = Math.round(monitor.width * 0.6);
            this._selH = Math.round(monitor.height * 0.6);
        }

        this._selectionOverlay.queue_repaint();
    }

    /**
     * Find the window under the cursor (or the focused window as fallback)
     * and set the selection rectangle to match its geometry.
     */
    _updateWindowSelection(mx, my) {
        let windows = global.get_window_actors()
            .filter(a => {
                let mw = a.meta_window;
                return mw &&
                    !mw.minimized &&
                    mw.get_window_type() === Meta.WindowType.NORMAL &&
                    mw.showing_on_its_workspace();
            })
            .sort((a, b) => {
                // Higher stacking order = more on top
                return b.meta_window.get_stable_sequence() -
                       a.meta_window.get_stable_sequence();
            });

        let found = null;

        // If cursor coords provided, find window under cursor
        if (mx !== undefined && my !== undefined) {
            for (let i = 0; i < windows.length; i++) {
                let rect = windows[i].meta_window.get_frame_rect();
                if (mx >= rect.x && mx < rect.x + rect.width &&
                    my >= rect.y && my < rect.y + rect.height) {
                    found = windows[i].meta_window;
                    break;
                }
            }
        }

        // Fallback: use focused window or topmost
        if (!found) {
            let focused = global.display.focus_window;
            if (focused &&
                !focused.minimized &&
                focused.get_window_type() === Meta.WindowType.NORMAL) {
                found = focused;
            } else if (windows.length > 0) {
                found = windows[0].meta_window;
            }
        }

        if (found) {
            let rect = found.get_frame_rect();
            this._selX = rect.x;
            this._selY = rect.y;
            this._selW = rect.width;
            this._selH = rect.height;
        } else {
            // No windows — fall back to full screen
            let monitor = Main.layoutManager.primaryMonitor;
            this._selX = 0;
            this._selY = 0;
            this._selW = monitor.width;
            this._selH = monitor.height;
        }
    }

    // =========================================================================
    // OPEN / CLOSE
    // =========================================================================

    /**
     * Open the screenshot UI.
     * @param {number} mode — UIMode.SCREENSHOT (0) or UIMode.SCREENCAST (1)
     */
    open(mode) {
        if (this._visible) return;

        if (mode !== undefined) {
            this._mode = mode;
            this._shotBtn.checked = (mode === UIMode.SCREENSHOT);
        }

        // Capture the screen before showing the UI
        this._captureScreen(() => {
            let monitor = Main.layoutManager.primaryMonitor;

            // Resize layers to current monitor
            this.actor.set_size(monitor.width, monitor.height);
            this.actor.set_position(monitor.x, monitor.y);
            this._previewActor.set_size(monitor.width, monitor.height);
            this._selectionOverlay.set_size(monitor.width, monitor.height);
            this._editArea.set_size(monitor.width, monitor.height);

            // Default to area selection
            this._selX = Math.round(monitor.width * 0.15);
            this._selY = Math.round(monitor.height * 0.15);
            this._selW = Math.round(monitor.width * 0.7);
            this._selH = Math.round(monitor.height * 0.6);
            this._selectionMode = SelectionMode.AREA;
            this._areaBtn.checked = true;
            this._screenBtn.checked = false;
            this._windowBtn.checked = false;

            // Mark visible BEFORE _setUIMode so parts see correct state
            this._visible = true;

            // Apply UI mode (photo/video toggle + capture button)
            this._setUIMode(this._mode);

            // Trigger selection overlay repaint with handles
            this._selectionOverlay.queue_repaint();

            this.actor.show();

            // Push modal
            if (!this._isModal) {
                this._isModal = Main.pushModal(this.actor);
            }

            // Position bar immediately + schedule deferred reposition
            // (deferred handles cases where children aren't laid out yet)
            this._positionBottomBar();
            this._scheduleBarPosition();

            this.emit('opened');
            this.emit('notify::visible');
        });
    }

    /**
     * Close the screenshot UI.
     */
    close() {
        if (!this._visible) return;

        if (this._layoutIdleId !== 0) {
            GLib.source_remove(this._layoutIdleId);
            this._layoutIdleId = 0;
        }
        if (this._layoutDelayId) {
            GLib.source_remove(this._layoutDelayId);
            this._layoutDelayId = 0;
        }
        if (this._recenterIdleId) {
            GLib.source_remove(this._recenterIdleId);
            this._recenterIdleId = 0;
        }

        if (this._isModal) {
            Main.popModal(this.actor);
            this._isModal = false;
        }

        this.actor.hide();
        this._visible = false;

        // Clean up screenshot data
        this._screenshotPixbuf = null;
        this._screenshotSurface = null;
        this._previewActor.set_content(null);

        this.emit('closed');
        this.emit('notify::visible');
    }

    // =========================================================================
    // SCREEN CAPTURE
    // =========================================================================

    /**
     * Capture the entire screen to a temp file, then load as pixbuf/texture.
     * @param {Function} callback — called when capture is done
     */
    _captureScreen(callback) {
        let tmpFile = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            'bigshot-capture-' + Date.now() + '.png'
        ]);

        let screenshot = new Cinnamon.Screenshot();
        screenshot.screenshot(this._includeCursor, tmpFile, (obj, result) => {
            try {
                // Load as pixbuf for annotation compositing
                this._screenshotPixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpFile);
                this._scale = 1;

                // Load as Clutter texture for preview
                let image = new Clutter.Image();
                let pixbuf = this._screenshotPixbuf;
                let success = image.set_data(
                    pixbuf.get_pixels(),
                    pixbuf.get_has_alpha()
                        ? Cogl.PixelFormat.RGBA_8888
                        : Cogl.PixelFormat.RGB_888,
                    pixbuf.get_width(),
                    pixbuf.get_height(),
                    pixbuf.get_rowstride()
                );

                if (success) {
                    this._previewActor.set_content(image);
                }

                // Provide the pixbuf to the drawing overlay
                this.emit('screenshot-ready', this._screenshotPixbuf);
            } catch (e) {
                log('[Big Shot] Failed to load screenshot: ' + e.message);
            } finally {
                // Clean up temp file
                try {
                    Gio.File.new_for_path(tmpFile).delete(null);
                } catch (e) {
                    // ignore cleanup failure
                }
            }

            if (callback) callback();
        });
    }

    /**
     * Get the captured screenshot pixbuf.
     */
    getScreenshotPixbuf() {
        return this._screenshotPixbuf;
    }

    /**
     * Get the selected geometry in screen coordinates.
     * @returns {Array} [x, y, width, height]
     */
    getSelectedGeometry() {
        if (this._selectionMode === SelectionMode.SCREEN) {
            let monitor = Main.layoutManager.primaryMonitor;
            return [0, 0, monitor.width, monitor.height];
        }
        return [this._selX, this._selY, this._selW, this._selH];
    }

    // =========================================================================
    // SELECTION PAINTING
    // =========================================================================

    _paintSelection(area) {
        let cr = area.get_context();
        let surfaceSize = area.get_surface_size();
        let width = surfaceSize[0];
        let height = surfaceSize[1];

        // No dim overlay in fullscreen mode — show subtle border
        if (this._selectionMode === SelectionMode.SCREEN) {
            // Subtle blue border to indicate full-screen capture
            cr.setSourceRGBA(0.208, 0.518, 0.894, 0.5);
            cr.setLineWidth(3);
            cr.rectangle(2, 2, width - 4, height - 4);
            cr.stroke();
            return;
        }

        // WINDOW mode: dim everything outside window, highlight window
        if (this._selectionMode === SelectionMode.WINDOW) {
            // Dim everything
            cr.setSourceRGBA(0, 0, 0, 0.5);
            cr.rectangle(0, 0, width, height);
            cr.fill();

            // Clear window area to reveal preview
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.rectangle(this._selX, this._selY, this._selW, this._selH);
            cr.fill();
            cr.setOperator(Cairo.Operator.OVER);

            // White border around selected window
            cr.setSourceRGBA(1, 1, 1, 0.8);
            cr.setLineWidth(2);
            cr.rectangle(
                this._selX + 1, this._selY + 1,
                this._selW - 2, this._selH - 2
            );
            cr.stroke();
            return;
        }

        // Dim everything outside selection
        cr.setSourceRGBA(0, 0, 0, 0.5);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        // Clear the selected area to reveal preview beneath
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.rectangle(this._selX, this._selY, this._selW, this._selH);
        cr.fill();
        cr.setOperator(Cairo.Operator.OVER);

        // Selection border
        cr.setSourceRGBA(1, 1, 1, 0.8);
        cr.setLineWidth(2);
        cr.rectangle(
            this._selX + 1, this._selY + 1,
            this._selW - 2, this._selH - 2
        );
        cr.stroke();

        // Resize handles
        if (this._selectionMode === SelectionMode.AREA) {
            let handles = this._getHandlePositions();
            for (let i = 0; i < handles.length; i++) {
                let h = handles[i];
                let hx = h.x - HANDLE_SIZE / 2;
                let hy = h.y - HANDLE_SIZE / 2;

                // White fill
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.rectangle(hx, hy, HANDLE_SIZE, HANDLE_SIZE);
                cr.fill();

                // Blue border
                cr.setSourceRGBA(0.208, 0.518, 0.894, 0.9);
                cr.setLineWidth(HANDLE_BORDER);
                cr.rectangle(hx, hy, HANDLE_SIZE, HANDLE_SIZE);
                cr.stroke();
            }
        }
    }

    _getHandlePositions() {
        let x = this._selX;
        let y = this._selY;
        let w = this._selW;
        let h = this._selH;
        return [
            { id: 'nw', x: x,         y: y },
            { id: 'n',  x: x + w / 2, y: y },
            { id: 'ne', x: x + w,     y: y },
            { id: 'e',  x: x + w,     y: y + h / 2 },
            { id: 'se', x: x + w,     y: y + h },
            { id: 's',  x: x + w / 2, y: y + h },
            { id: 'sw', x: x,         y: y + h },
            { id: 'w',  x: x,         y: y + h / 2 },
        ];
    }

    _hitTestHandle(mx, my) {
        if (this._selectionMode !== SelectionMode.AREA) return null;

        let handles = this._getHandlePositions();
        let hitRadius = HANDLE_SIZE + 4;
        for (let i = 0; i < handles.length; i++) {
            let h = handles[i];
            if (Math.abs(mx - h.x) < hitRadius &&
                Math.abs(my - h.y) < hitRadius) {
                return h.id;
            }
        }

        // Inside selection → move
        if (mx >= this._selX && mx <= this._selX + this._selW &&
            my >= this._selY && my <= this._selY + this._selH) {
            return 'move';
        }

        return null;
    }

    // =========================================================================
    // INPUT HANDLING
    // =========================================================================

    _onButtonPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        let coords = event.get_coords();
        let mx = coords[0];
        let my = coords[1];

        if (this._selectionMode === SelectionMode.AREA) {
            let handle = this._hitTestHandle(mx, my);
            if (handle) {
                this._dragHandle = handle;
                this._dragStartX = mx;
                this._dragStartY = my;
                this._selStartX = this._selX;
                this._selStartY = this._selY;
                this._selStartW = this._selW;
                this._selStartH = this._selH;
                return Clutter.EVENT_STOP;
            }

            // Start new selection from click point
            this._isSelecting = true;
            this._selAnchorX = mx;
            this._selAnchorY = my;
            this._selX = mx;
            this._selY = my;
            this._selW = 0;
            this._selH = 0;
            this._selectionOverlay.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onMotion(event) {
        let coords = event.get_coords();
        let mx = coords[0];
        let my = coords[1];

        // In WINDOW mode, track which window is under the cursor
        if (this._selectionMode === SelectionMode.WINDOW) {
            this._updateWindowSelection(mx, my);
            this._selectionOverlay.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._isSelecting) {
            // Use anchor point for correct selection computation
            let x0 = Math.min(this._selAnchorX, mx);
            let y0 = Math.min(this._selAnchorY, my);
            let x1 = Math.max(this._selAnchorX, mx);
            let y1 = Math.max(this._selAnchorY, my);
            this._selX = x0;
            this._selY = y0;
            this._selW = x1 - x0;
            this._selH = y1 - y0;
            this._selectionOverlay.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._dragHandle) {
            let dx = mx - this._dragStartX;
            let dy = my - this._dragStartY;
            this._applyDrag(this._dragHandle, dx, dy);
            this._selectionOverlay.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _onButtonRelease(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (this._isSelecting) {
            this._isSelecting = false;
            // Reset to default if selection too small
            if (this._selW < MIN_SELECTION || this._selH < MIN_SELECTION) {
                let monitor = Main.layoutManager.primaryMonitor;
                this._selX = Math.round(monitor.width * 0.2);
                this._selY = Math.round(monitor.height * 0.2);
                this._selW = Math.round(monitor.width * 0.6);
                this._selH = Math.round(monitor.height * 0.6);
            }
            this._selectionOverlay.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._dragHandle) {
            this._dragHandle = null;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _applyDrag(handle, dx, dy) {
        let x = this._selStartX;
        let y = this._selStartY;
        let w = this._selStartW;
        let h = this._selStartH;

        switch (handle) {
        case 'move':
            this._selX = x + dx;
            this._selY = y + dy;
            this._selW = w;
            this._selH = h;
            break;
        case 'nw':
            this._selX = x + dx;
            this._selY = y + dy;
            this._selW = w - dx;
            this._selH = h - dy;
            break;
        case 'n':
            this._selY = y + dy;
            this._selH = h - dy;
            break;
        case 'ne':
            this._selY = y + dy;
            this._selW = w + dx;
            this._selH = h - dy;
            break;
        case 'e':
            this._selW = w + dx;
            break;
        case 'se':
            this._selW = w + dx;
            this._selH = h + dy;
            break;
        case 's':
            this._selH = h + dy;
            break;
        case 'sw':
            this._selX = x + dx;
            this._selW = w - dx;
            this._selH = h + dy;
            break;
        case 'w':
            this._selX = x + dx;
            this._selW = w - dx;
            break;
        }

        // Enforce minimum size
        if (this._selW < MIN_SELECTION) this._selW = MIN_SELECTION;
        if (this._selH < MIN_SELECTION) this._selH = MIN_SELECTION;
    }

    _onKeyPress(event) {
        let symbol = event.get_key_symbol();

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._onCapture();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // =========================================================================
    // CAPTURE ACTION
    // =========================================================================

    _onCapture() {
        if (this._mode === UIMode.SCREENCAST) {
            this.emit('screencast-requested');
            return;
        }

        this._saveScreenshot();
    }

    /**
     * Save the screenshot (with or without annotations).
     * Crops to selected region, copies to clipboard, plays sound.
     */
    _saveScreenshot() {
        if (!this._screenshotPixbuf) {
            this.close();
            return;
        }

        let geom = this.getSelectedGeometry();
        let pixbuf = this._screenshotPixbuf;

        // Crop to selection unless fullscreen
        if (this._selectionMode !== SelectionMode.SCREEN) {
            let cx = Math.max(0, geom[0]);
            let cy = Math.max(0, geom[1]);
            let cw = Math.min(geom[2], pixbuf.get_width() - cx);
            let ch = Math.min(geom[3], pixbuf.get_height() - cy);

            if (cw > 0 && ch > 0) {
                pixbuf = pixbuf.new_subpixbuf(cx, cy, cw, ch);
            }
        }

        // Apply annotation compositor if available (set by extension.js)
        if (this._annotationCompositor) {
            try {
                let annotated = this._annotationCompositor(pixbuf, geom);
                if (annotated) pixbuf = annotated;
            } catch (e) {
                log('[Big Shot] Annotation compositing failed: ' + e.message);
            }
        }

        // Build output path
        let time = GLib.DateTime.new_now_local();
        let dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (!dir) dir = GLib.get_home_dir();
        let screenshotsDir = GLib.build_filenamev([dir, _('Screenshots')]);

        // Ensure directory exists
        try {
            Gio.File.new_for_path(screenshotsDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                log('[Big Shot] Failed to create screenshots dir: ' + e.message);
            }
        }

        let baseName = _('Screenshot from %s').format(
            time.format('%Y-%m-%d %H-%M-%S'));
        let filePath = GLib.build_filenamev([screenshotsDir, baseName + '.png']);

        // Resolve filename conflicts
        let fileObj = Gio.File.new_for_path(filePath);
        let counter = 1;
        while (fileObj.query_exists(null)) {
            filePath = GLib.build_filenamev([
                screenshotsDir, baseName + '-' + counter + '.png'
            ]);
            fileObj = Gio.File.new_for_path(filePath);
            counter++;
        }

        try {
            pixbuf.savev(filePath, 'png', [], []);

            // Copy to clipboard
            let clipboard = St.Clipboard.get_default();
            let bytes = GLib.file_get_contents(filePath);
            if (bytes[0]) {
                clipboard.set_content(
                    St.ClipboardType.CLIPBOARD,
                    'image/png',
                    bytes[1]
                );
            }

            // Play capture sound
            try {
                let player = global.display.get_sound_player();
                if (player) {
                    player.play_from_theme(
                        'screen-capture',
                        _('Screenshot taken'),
                        null
                    );
                }
            } catch (e) {
                // ignore sound errors
            }

            this.emit('screenshot-taken', filePath);
        } catch (e) {
            log('[Big Shot] Failed to save screenshot: ' + e.message);
        }

        this.close();
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    destroy() {
        this.close();

        if (this._layoutIdleId !== 0) {
            GLib.source_remove(this._layoutIdleId);
            this._layoutIdleId = 0;
        }
        if (this._layoutDelayId) {
            GLib.source_remove(this._layoutDelayId);
            this._layoutDelayId = 0;
        }
        if (this._recenterIdleId) {
            GLib.source_remove(this._recenterIdleId);
            this._recenterIdleId = 0;
        }

        if (this.actor) {
            Main.layoutManager.removeChrome(this.actor);
            this.actor.destroy();
            this.actor = null;
        }
    }
};

Signals.addSignalMethods(ScreenshotUI.prototype);
