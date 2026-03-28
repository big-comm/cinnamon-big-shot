/**
 * Big Shot — Crop part
 *
 * Adds crop + padding functionality for screenshot beautification.
 * Provides a crop box overlay with 8 draggable handles.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const St = imports.gi.St;
const Clutter = imports.gi.Clutter;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

const PADDING_VALUES = [0, 16, 32, 48, 64];
const HANDLE_SIZE = 10;
const MIN_CROP = 32;
const KEYBOARD_STEP = 8;

const HANDLE_DEFS = [
    { id: 'nw', edges: ['top', 'left'],    cursor: 'nw-resize' },
    { id: 'n',  edges: ['top'],             cursor: 'n-resize'  },
    { id: 'ne', edges: ['top', 'right'],    cursor: 'ne-resize' },
    { id: 'e',  edges: ['right'],           cursor: 'e-resize'  },
    { id: 'se', edges: ['bottom', 'right'], cursor: 'se-resize' },
    { id: 's',  edges: ['bottom'],          cursor: 's-resize'  },
    { id: 'sw', edges: ['bottom', 'left'],  cursor: 'sw-resize' },
    { id: 'w',  edges: ['left'],            cursor: 'w-resize'  },
];

var PartCrop = class PartCrop extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._cropRect = null;
        this._imageWidth = 0;
        this._imageHeight = 0;
        this._padding = 0;
        this._isActive = false;
        this._dragging = null;

        this._buildUI();
    }

    _buildUI() {
        this._overlay = new St.Widget({
            style_class: 'big-shot-crop-overlay',
            style: 'border: 2px dashed rgba(255,255,255,0.8);',
            visible: false,
            reactive: true,
        });

        this._handles = new Map();
        for (let d = 0; d < HANDLE_DEFS.length; d++) {
            let def = HANDLE_DEFS[d];
            let handle = new St.Widget({
                style_class: 'big-shot-crop-handle',
                style: 'width: ' + HANDLE_SIZE + 'px; height: ' + HANDLE_SIZE + 'px; ' +
                       'background: white; border: 1px solid #62a0ea; border-radius: 1px;',
                reactive: true,
                can_focus: true,
                visible: false,
                accessible_name: 'Crop ' + def.id,
            });

            let hdef = def;
            handle.connect('button-press-event', (actor, event) => {
                this._onHandlePress(hdef, event);
                return Clutter.EVENT_STOP;
            });

            handle.connect('key-press-event', (actor, event) => {
                return this._onHandleKeyPress(hdef, event);
            });

            this._handles.set(def.id, handle);
        }

        this._overlay.connect('button-press-event', (actor, event) => {
            this._onOverlayPress(event);
            return Clutter.EVENT_STOP;
        });

        this._paddingLabel = new St.Label({
            text: '0px',
            style: 'color: white; font-size: 11px;',
            visible: false,
        });

        if (this._ui && this._ui.actor) {
            this._ui.actor.add_child(this._overlay);
            this._handles.forEach((handle) => {
                this._ui.actor.add_child(handle);
            });
            this._ui.actor.add_child(this._paddingLabel);

            this._connectSignal(this._ui.actor, 'motion-event', (actor, event) => {
                return this._onGlobalMotion(event);
            });
            this._connectSignal(this._ui.actor, 'button-release-event', (actor, event) => {
                return this._onGlobalRelease(event);
            });
        }
    }

    activate(imageWidth, imageHeight) {
        this._isActive = true;
        this._imageWidth = imageWidth;
        this._imageHeight = imageHeight;
        this._cropRect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
        this._updateOverlay();
        this._overlay.visible = true;
        this._handles.forEach((h) => { h.visible = true; });
    }

    deactivate() {
        this._isActive = false;
        this._overlay.visible = false;
        this._paddingLabel.visible = false;
        this._handles.forEach((h) => { h.visible = false; });
        this._dragging = null;
    }

    cyclePadding() {
        let idx = PADDING_VALUES.indexOf(this._padding);
        this._padding = PADDING_VALUES[(idx + 1) % PADDING_VALUES.length];
        this._paddingLabel.text = this._padding + 'px';
        this._paddingLabel.visible = this._padding > 0;
    }

    get padding() {
        return this._padding;
    }

    get cropRect() {
        return this._cropRect;
    }

    _onHandlePress(def, event) {
        if (!this._cropRect) return;
        let coords = event.get_coords();
        this._dragging = {
            handleId: def.id,
            edges: def.edges,
            startX: coords[0],
            startY: coords[1],
            startRect: { x: this._cropRect.x, y: this._cropRect.y,
                         width: this._cropRect.width, height: this._cropRect.height },
        };
    }

    _onOverlayPress(event) {
        if (!this._cropRect) return;
        let coords = event.get_coords();
        this._dragging = {
            handleId: 'move',
            edges: [],
            startX: coords[0],
            startY: coords[1],
            startRect: { x: this._cropRect.x, y: this._cropRect.y,
                         width: this._cropRect.width, height: this._cropRect.height },
        };
    }

    _onHandleKeyPress(def, event) {
        if (!this._cropRect || !this._isActive) return Clutter.EVENT_PROPAGATE;

        let sym = event.get_key_symbol();
        let dx = 0, dy = 0;
        if (sym === Clutter.KEY_Left) dx = -KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Right) dx = KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Up) dy = -KEYBOARD_STEP;
        else if (sym === Clutter.KEY_Down) dy = KEYBOARD_STEP;
        else return Clutter.EVENT_PROPAGATE;

        let edges = def.edges;
        let rx = this._cropRect.x;
        let ry = this._cropRect.y;
        let rw = this._cropRect.width;
        let rh = this._cropRect.height;

        if (edges.indexOf('left') >= 0) { let nx = Math.max(0, Math.min(rx + dx, rx + rw - MIN_CROP)); rw -= nx - rx; rx = nx; }
        if (edges.indexOf('right') >= 0) { rw = Math.max(MIN_CROP, Math.min(rw + dx, this._imageWidth - rx)); }
        if (edges.indexOf('top') >= 0) { let ny = Math.max(0, Math.min(ry + dy, ry + rh - MIN_CROP)); rh -= ny - ry; ry = ny; }
        if (edges.indexOf('bottom') >= 0) { rh = Math.max(MIN_CROP, Math.min(rh + dy, this._imageHeight - ry)); }

        this._cropRect = { x: rx, y: ry, width: rw, height: rh };
        this._updateOverlay();
        return Clutter.EVENT_STOP;
    }

    _onGlobalMotion(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;

        let coords = event.get_coords();
        let dx = coords[0] - this._dragging.startX;
        let dy = coords[1] - this._dragging.startY;
        let orig = this._dragging.startRect;

        if (this._dragging.handleId === 'move') {
            let nx = orig.x + dx;
            let ny = orig.y + dy;
            nx = Math.max(0, Math.min(nx, this._imageWidth - orig.width));
            ny = Math.max(0, Math.min(ny, this._imageHeight - orig.height));
            this._cropRect.x = nx;
            this._cropRect.y = ny;
        } else {
            let edges = this._dragging.edges;
            let rx = orig.x, ry = orig.y, rw = orig.width, rh = orig.height;

            if (edges.indexOf('left') >= 0) {
                let newX = Math.max(0, Math.min(rx + dx, rx + rw - MIN_CROP));
                rw = rw - (newX - rx);
                rx = newX;
            }
            if (edges.indexOf('right') >= 0) {
                rw = Math.max(MIN_CROP, Math.min(orig.width + dx, this._imageWidth - rx));
            }
            if (edges.indexOf('top') >= 0) {
                let newY = Math.max(0, Math.min(ry + dy, ry + rh - MIN_CROP));
                rh = rh - (newY - ry);
                ry = newY;
            }
            if (edges.indexOf('bottom') >= 0) {
                rh = Math.max(MIN_CROP, Math.min(orig.height + dy, this._imageHeight - ry));
            }

            this._cropRect = { x: rx, y: ry, width: rw, height: rh };
        }

        this._updateOverlay();
        return Clutter.EVENT_STOP;
    }

    _onGlobalRelease(event) {
        if (!this._dragging) return Clutter.EVENT_PROPAGATE;
        this._dragging = null;
        return Clutter.EVENT_STOP;
    }

    _updateOverlay() {
        if (!this._cropRect || !this._isActive) return;
        let rect = this._cropRect;

        this._overlay.set_position(rect.x, rect.y);
        this._overlay.set_size(rect.width, rect.height);

        let hs = HANDLE_SIZE / 2;
        let cx = rect.x + rect.width / 2;
        let cy = rect.y + rect.height / 2;

        let positions = {
            nw: [rect.x - hs, rect.y - hs],
            n:  [cx - hs, rect.y - hs],
            ne: [rect.x + rect.width - hs, rect.y - hs],
            e:  [rect.x + rect.width - hs, cy - hs],
            se: [rect.x + rect.width - hs, rect.y + rect.height - hs],
            s:  [cx - hs, rect.y + rect.height - hs],
            sw: [rect.x - hs, rect.y + rect.height - hs],
            w:  [rect.x - hs, cy - hs],
        };

        this._handles.forEach((handle, id) => {
            let pos = positions[id];
            if (pos) handle.set_position(pos[0], pos[1]);
        });
    }

    _onModeChanged(isCast) {
        PartUI.prototype._onModeChanged.call(this, isCast);
        if (isCast)
            this.deactivate();
    }

    destroy() {
        if (this._overlay) this._overlay.destroy();
        if (this._paddingLabel) this._paddingLabel.destroy();
        this._handles.forEach((h) => { h.destroy(); });
        this._handles.clear();
        PartUI.prototype.destroy.call(this);
    }
};
