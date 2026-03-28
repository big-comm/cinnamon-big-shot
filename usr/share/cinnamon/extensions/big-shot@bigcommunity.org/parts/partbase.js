/**
 * Big Shot — Base classes for extension modules (Parts)
 *
 * Cinnamon CJS version — adapted from GNOME Shell ES module original.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;

// =============================================================================
// PartBase — Simplest base class
// =============================================================================

var PartBase = class PartBase {
    constructor() {
        this._destroyed = false;
    }

    destroy() {
        this._destroyed = true;
    }
};

// =============================================================================
// PartUI — Base with ScreenshotUI awareness
// =============================================================================

var PartUI = class PartUI extends PartBase {
    /**
     * @param {Object} screenshotUI — our custom screenshot UI (screenshotUI.js)
     * @param {Object} extension — extension instance
     */
    constructor(screenshotUI, extension) {
        super();
        this._ui = screenshotUI;
        this._ext = extension;
        this._signals = [];
        this._isCastMode = false;

        // Monitor screenshot/screencast mode toggle
        const shotBtn = this._ui.shotButton;
        if (shotBtn) {
            this._isCastMode = !shotBtn.checked;
            this._connectSignal(shotBtn, 'notify::checked', () => {
                this._isCastMode = !shotBtn.checked;
                this._onModeChanged(this._isCastMode);
            });
        }
    }

    _connectSignal(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push({ obj: obj, id: id });
        return id;
    }

    _onModeChanged(_isCast) {
        // Override in subclasses
    }

    destroy() {
        for (let i = 0; i < this._signals.length; i++) {
            let sig = this._signals[i];
            try {
                sig.obj.disconnect(sig.id);
            } catch (e) {
                // Already disconnected
            }
        }
        this._signals = [];
        PartBase.prototype.destroy.call(this);
    }
};

// =============================================================================
// PartPopupSelect — Button with popup menu for value selection
// =============================================================================

var PartPopupSelect = class PartPopupSelect extends PartUI {
    /**
     * @param {Object} screenshotUI — our custom screenshot UI
     * @param {Object} extension — extension instance
     * @param {Array} options — selectable values
     * @param {*} defaultValue — initial value
     * @param {Function} labelFn — (value) => string
     * @param {string|null} tooltipText — optional tooltip
     */
    constructor(screenshotUI, extension, options, defaultValue, labelFn, tooltipText) {
        super(screenshotUI, extension);

        this._options = options;
        this._value = defaultValue;
        this._labelFn = labelFn;

        // Create the button
        this._button = new St.Button({
            style_class: 'big-shot-popup-btn',
            toggle_mode: false,
            can_focus: true,
            child: new St.Label({
                text: this._labelFn(this._value),
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });

        this._button.connect('clicked', () => this._showPopup());

        // Optional tooltip
        if (tooltipText) {
            this._tooltipText = tooltipText;
            this._button.connect('enter-event', () => {
                this._showButtonTooltip(this._button, this._tooltipText);
            });
            this._button.connect('leave-event', () => {
                this._hideButtonTooltip();
            });
        }

        // Create popup container
        this._popup = new St.BoxLayout({
            style_class: 'big-shot-popup-menu',
            vertical: true,
            visible: false,
            reactive: true,
        });

        this._popup.set_style('background: rgba(30,30,30,0.95); border-radius: 12px; padding: 4px;');

        for (let i = 0; i < this._options.length; i++) {
            let opt = this._options[i];
            let item = new St.Button({
                style_class: 'big-shot-popup-btn',
                label: this._labelFn(opt),
                can_focus: true,
            });
            item.connect('clicked', () => {
                this._value = opt;
                this._button.child.text = this._labelFn(opt);
                this._popup.visible = false;
            });
            this._popup.add_child(item);
        }

        // Insert into the UI's control area
        const controlContainer = this._ui.controlContainer;
        if (controlContainer) {
            controlContainer.insert_child_at_index(this._button, 0);
        } else {
            const panel = this._ui.panel || this._ui.actor;
            if (panel)
                panel.add_child(this._button);
        }

        // Popup is added to the screenshot UI for proper z-ordering
        this._ui.actor.add_child(this._popup);

        // Only visible in cast mode
        this._button.visible = false;
        this._popup.visible = false;
    }

    get value() {
        return this._value;
    }

    _showPopup() {
        this._popup.visible = !this._popup.visible;
        if (this._popup.visible) {
            let pos = this._button.get_transformed_position();
            let bx = pos[0];
            let by = pos[1];
            this._popup.set_position(bx, by - this._popup.height - 8);
        }
    }

    _onModeChanged(isCast) {
        this._button.visible = isCast;
        if (!isCast) this._popup.visible = false;
    }

    _showButtonTooltip(button, text) {
        this._hideButtonTooltip();
        this._tooltip = new St.Label({
            text: text,
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
        });
        this._ui.actor.add_child(this._tooltip);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._tooltip) return GLib.SOURCE_REMOVE;
            let pos = button.get_transformed_position();
            let bx = pos[0];
            let by = pos[1];
            let bw = button.width;
            let tw = this._tooltip.width;
            this._tooltip.set_position(bx + (bw - tw) / 2, by - this._tooltip.height - 4);
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideButtonTooltip() {
        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }
    }

    destroy() {
        this._hideButtonTooltip();
        if (this._popup) {
            let popupParent = this._popup.get_parent();
            if (popupParent) popupParent.remove_child(this._popup);
            this._popup.destroy();
            this._popup = null;
        }
        if (this._button) {
            let btnParent = this._button.get_parent();
            if (btnParent) btnParent.remove_child(this._button);
            this._button.destroy();
            this._button = null;
        }
        PartUI.prototype.destroy.call(this);
    }
};
