/**
 * Big Shot — Annotation integration part
 *
 * Connects the toolbar (tool/color/size selection) to the drawing overlay.
 * Manages the overlay lifecycle tied to the screenshot UI.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;
const Overlay = imports.drawing.overlay;
const DrawingOverlay = Overlay.DrawingOverlay;

var PartAnnotation = class PartAnnotation extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._overlay = null;
        this._toolbar = extension._toolbar;

        // Wire toolbar undo/redo to overlay
        if (this._toolbar) {
            this._toolbar._onUndo = () => {
                if (this._overlay) this._overlay.undo();
            };
            this._toolbar._onRedo = () => {
                if (this._overlay) this._overlay.redo();
            };
        }

        // When screenshot UI opens, create the overlay
        this._connectSignal(this._ui.actor, 'notify::visible', () => {
            this._onUIVisibilityChanged();
        });
    }

    _onUIVisibilityChanged() {
        if (this._ui.visible && !this._isCastMode) {
            this._ensureOverlay();
        } else {
            this._destroyOverlay();
        }
    }

    _onModeChanged(isCast) {
        PartUI.prototype._onModeChanged.call(this, isCast);
        if (isCast) {
            this._destroyOverlay();
        } else if (this._ui.visible) {
            this._ensureOverlay();
        }
    }

    _ensureOverlay() {
        if (this._overlay) return;

        // In Cinnamon, use editArea from our screenshotUI
        this._overlay = new DrawingOverlay(this._ui.editArea, this._toolbar);

        // Size the overlay to the full monitor
        let monitor = global.display.get_current_monitor();
        let rect = global.display.get_monitor_geometry(monitor);
        this._overlay.show(rect.width, rect.height);

        // If the screenshot UI has a pixbuf ready, provide it to the overlay
        let pixbuf = this._ui.getScreenshotPixbuf();
        if (pixbuf) {
            this._overlay.setCachedPixbuf(pixbuf, 1);
        }
    }

    _destroyOverlay() {
        if (!this._overlay) return;
        this._overlay.destroy();
        this._overlay = null;
    }

    destroy() {
        this._destroyOverlay();
        PartUI.prototype.destroy.call(this);
    }
};
