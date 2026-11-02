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

let _ = function(str) { return str; };

const ANGLE_VALUES = [0, 45, 90, 135, 180, 225, 270, 315];
const RADIUS_VALUES = [0, 8, 16, 24, 32];

function _gradientName(id) {
    switch (id) {
    case 'red-flame': return _('Red Flame');
    case 'sunset-orange': return _('Sunset Orange');
    case 'golden-hour': return _('Golden Hour');
    case 'mint-fresh': return _('Mint Fresh');
    case 'ocean-breeze': return _('Ocean Breeze');
    case 'purple-dream': return _('Purple Dream');
    case 'night-sky': return _('Night Sky');
    case 'coral-pink': return _('Coral Pink');
    case 'none': return _('None');
    default: return id;
    }
}

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
            let preview = this._createSwatchPreview(grad);
            let swatch = new St.Button({
                style_class: 'big-shot-gradient-swatch',
                toggle_mode: true,
                can_focus: true,
                width: 24,
                height: 24,
                child: preview,
            });

            swatch.set_accessible_name(_gradientName(grad.id));
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
            style_class: 'big-shot-gradient-control',
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
            style_class: 'big-shot-gradient-control',
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

        let anchor = this._toolbar && this._toolbar._editContainer;
        if (anchor) {
            this._anchorXId = anchor.connect('notify::x', () => {
                this._repositionPicker();
            });
            this._anchorYId = anchor.connect('notify::y', () => {
                this._repositionPicker();
            });
        }
    }

    _createSwatchPreview(gradient) {
        let preview = new St.DrawingArea({
            width: 20,
            height: 20,
            reactive: false,
        });
        preview.connect('repaint', area => {
            let cr = area.get_context();
            try {
                this._paintSwatch(cr, area, gradient);
            } finally {
                cr.$dispose();
            }
        });
        return preview;
    }

    _paintSwatch(cr, area, gradient) {
        let size = area.get_surface_size();
        let width = size[0];
        let height = size[1];
        if (gradient.stops.length > 0) {
            Gradients.paintGradient(
                cr,
                gradient,
                0,
                0,
                width,
                height
            );
        } else {
            let block = 5;
            for (let y = 0; y < height; y += block) {
                for (let x = 0; x < width; x += block) {
                    let light = ((x / block + y / block) % 2) === 0;
                    cr.setSourceRGBA(
                        light ? 0.65 : 0.25,
                        light ? 0.65 : 0.25,
                        light ? 0.65 : 0.25,
                        1
                    );
                    cr.rectangle(x, y, block, block);
                    cr.fill();
                }
            }
        }
    }

    _onSwatchClicked(index) {
        for (let i = 0; i < this._swatches.length; i++) {
            this._swatches[i].checked = (i === index);
        }
        this._selected = index;
        let gradient = GRADIENTS[index];
        if (gradient && gradient.stops.length > 0 &&
            this._ext._crop && this._ext._crop.padding === 0)
            this._ext._crop.setPadding(32);
        if (this._ext._crop)
            this._ext._crop.refreshPresentationPreview();
    }

    _cycleAngle() {
        this._angleIndex = (this._angleIndex + 1) % ANGLE_VALUES.length;
        this._angleButton.child.text = ANGLE_VALUES[this._angleIndex] + '\u00B0';
        if (this._ext._crop)
            this._ext._crop.refreshPresentationPreview();
    }

    _cycleRadius() {
        this._radiusIndex = (this._radiusIndex + 1) % RADIUS_VALUES.length;
        this._radiusButton.child.text = 'R:' + RADIUS_VALUES[this._radiusIndex];
        if (this._ext._crop)
            this._ext._crop.refreshPresentationPreview();
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
            let parent = this._picker.get_parent();
            if (parent)
                parent.set_child_above_sibling(this._picker, null);
            if (this._repositionIdleId)
                GLib.source_remove(this._repositionIdleId);
            this._repositionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._repositionIdleId = 0;
                if (this._picker)
                    this._repositionPicker();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    get visible() {
        return !!(this._picker && this._picker.visible);
    }

    reset() {
        this.setVisible(false);
        this._selected = GRADIENTS.length - 1;
        this._angleIndex = 3;
        this._radiusIndex = 0;
        for (let i = 0; i < this._swatches.length; i++)
            this._swatches[i].checked = i === this._selected;
        this._angleButton.child.text = ANGLE_VALUES[this._angleIndex] + '\u00B0';
        this._radiusButton.child.text = 'R:' + RADIUS_VALUES[this._radiusIndex];
    }

    _repositionPicker() {
        if (!this._picker || !this._picker.visible) return;

        let anchor = this._toolbar && this._toolbar._editContainer;
        if (!anchor || !anchor.get_parent() || !anchor.visible)
            anchor = this._ui.panel;
        if (!anchor) return;
        let pos = anchor.get_transformed_position();
        let monitor = this._ui.monitorGeometry;
        let bgX = pos[0] - monitor.x;
        let bgY = pos[1] - monitor.y;
        let bgW = anchor.width;
        let pw = this._picker.get_preferred_width(-1)[1] || this._picker.width;
        let ph = this._picker.get_preferred_height(-1)[1] || this._picker.height;
        this._picker.set_position(
            bgX + (bgW - pw) / 2,
            bgY - ph - 5
        );
    }

    destroy() {
        if (this._repositionIdleId) {
            GLib.source_remove(this._repositionIdleId);
            this._repositionIdleId = 0;
        }
        let anchor = this._toolbar && this._toolbar._editContainer;
        if (anchor) {
            try {
                if (this._anchorXId) anchor.disconnect(this._anchorXId);
                if (this._anchorYId) anchor.disconnect(this._anchorYId);
            } catch (e) {
                // Toolbar may already be destroyed during extension shutdown.
            }
        }
        this._anchorXId = 0;
        this._anchorYId = 0;
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
