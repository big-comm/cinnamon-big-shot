/**
 * Big Shot — Gradient background part
 *
 * Adds gradient background selection for screenshot beautification.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;
const Gradients = imports.data.gradients;
const GRADIENTS = Gradients.GRADIENTS;
const Colors = imports.drawing.colors;
const rgbToCSS = Colors.rgbToCSS;

let _ = function(str) { return str; };

const ANGLE_VALUES = [0, 45, 90, 135, 180, 225, 270, 315];
const RADIUS_VALUES = [0, 8, 16, 24, 32];

var PartGradient = class PartGradient extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._selected = GRADIENTS.length - 1; // 'None' by default
        this._angleIndex = 3; // Default: 135°
        this._radiusIndex = 0; // Default: 0
        this._toolbar = extension._toolbar;

        this._buildPicker();
    }

    _buildPicker() {
        this._picker = new St.BoxLayout({
            style_class: 'big-shot-gradient-picker',
            style: 'background-color: rgba(30, 30, 30, 0.95); border-radius: 14px; padding: 4px;',
            vertical: false,
            visible: false,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._swatches = [];

        for (let i = 0; i < GRADIENTS.length; i++) {
            let grad = GRADIENTS[i];
            let swatch = new St.Button({
                style_class: 'big-shot-gradient-swatch',
                toggle_mode: true,
                can_focus: true,
            });

            if (grad.stops.length >= 2) {
                let s0 = grad.stops[0];
                let sN = grad.stops[grad.stops.length - 1];
                let c1 = rgbToCSS(s0[1], s0[2], s0[3]);
                let c2 = rgbToCSS(sN[1], sN[2], sN[3]);
                swatch.set_style(
                    'background: linear-gradient(135deg, ' + c1 + ', ' + c2 + ');'
                );
            } else {
                swatch.set_style(
                    'background: transparent; border: 2px dashed rgba(255,255,255,0.3);'
                );
            }

            swatch.set_accessible_name(grad.name);
            let idx = i;
            swatch.connect('clicked', () => this._onSwatchClicked(idx));

            this._picker.add_child(swatch);
            this._swatches.push(swatch);
        }

        // Separator
        let sep = new St.Widget({
            style: 'width: 1px; background: rgba(255,255,255,0.2); margin: 4px 6px;',
        });
        this._picker.add_child(sep);

        // Angle button
        this._angleButton = new St.Button({
            style_class: 'big-shot-popup-btn',
            child: new St.Label({
                text: ANGLE_VALUES[this._angleIndex] + '\u00B0',
                y_align: Clutter.ActorAlign.CENTER,
            }),
            can_focus: true,
        });
        this._angleButton.set_accessible_name(_('Gradient Angle'));
        this._angleButton.connect('clicked', () => this._cycleAngle());
        this._picker.add_child(this._angleButton);

        // Border radius button
        this._radiusButton = new St.Button({
            style_class: 'big-shot-popup-btn',
            child: new St.Label({
                text: 'R:' + RADIUS_VALUES[this._radiusIndex],
                y_align: Clutter.ActorAlign.CENTER,
            }),
            can_focus: true,
        });
        this._radiusButton.set_accessible_name(_('Border Radius'));
        this._radiusButton.connect('clicked', () => this._cycleRadius());
        this._picker.add_child(this._radiusButton);

        // Mark default (None) as checked
        if (this._swatches[this._selected])
            this._swatches[this._selected].checked = true;

        // Add to screenshot UI
        if (this._ui && this._ui.actor) {
            this._ui.actor.add_child(this._picker);
        }
    }

    _onSwatchClicked(index) {
        for (let i = 0; i < this._swatches.length; i++) {
            this._swatches[i].checked = (i === index);
        }
        this._selected = index;
    }

    _cycleAngle() {
        this._angleIndex = (this._angleIndex + 1) % ANGLE_VALUES.length;
        this._angleButton.child.text = ANGLE_VALUES[this._angleIndex] + '\u00B0';
    }

    _cycleRadius() {
        this._radiusIndex = (this._radiusIndex + 1) % RADIUS_VALUES.length;
        this._radiusButton.child.text = 'R:' + RADIUS_VALUES[this._radiusIndex];
    }

    get selectedGradient() {
        let grad = GRADIENTS[this._selected];
        if (!grad || !grad.stops || grad.stops.length === 0)
            return null;
        let result = {};
        for (let key in grad) result[key] = grad[key];
        result.angle = ANGLE_VALUES[this._angleIndex];
        return result;
    }

    get borderRadius() {
        return RADIUS_VALUES[this._radiusIndex];
    }

    _onModeChanged(isCast) {
        PartUI.prototype._onModeChanged.call(this, isCast);
        this._picker.visible = false;
    }

    setVisible(visible) {
        this._picker.visible = visible;
        if (visible) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._repositionPicker();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _repositionPicker() {
        if (!this._picker || !this._picker.visible) return;

        let panel = this._ui.panel;
        if (!panel) return;
        let pos = panel.get_transformed_position();
        let bgX = pos[0];
        let bgY = pos[1];
        let bgW = panel.width;
        let pw = this._picker.width;
        let ph = this._picker.height;
        this._picker.set_position(
            bgX + (bgW - pw) / 2,
            bgY - ph - 8
        );
    }

    destroy() {
        if (this._picker) {
            let parent = this._picker.get_parent();
            if (parent) parent.remove_child(this._picker);
            this._picker.destroy();
            this._picker = null;
        }
        this._swatches = [];
        PartUI.prototype.destroy.call(this);
    }
};

PartGradient.setGettext = function(fn) { _ = fn; };
