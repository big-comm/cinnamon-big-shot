/**
 * Big Shot — Drawing Overlay (Cinnamon)
 *
 * A transparent Clutter.Actor overlay on top of the screenshot preview.
 * Handles mouse/touch input for drawing annotations using Cairo.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Pango = imports.gi.Pango;
const Main = imports.ui.main;

const Actions = imports.drawing.actions;
const DrawingMode = Actions.DrawingMode;
const DrawingOptions = Actions.DrawingOptions;
const createAction = Actions.createAction;
const CensorAction = Actions.CensorAction;
const BlurAction = Actions.BlurAction;
const InvertAction = Actions.InvertAction;
const ZoomCalloutAction = Actions.ZoomCalloutAction;
const TextAction = Actions.TextAction;
const NumberStampAction = Actions.NumberStampAction;
const NumberArrowAction = Actions.NumberArrowAction;
const NumberPointerAction = Actions.NumberPointerAction;
const PixelEffectAction = Actions.PixelEffectAction;
const Colors = imports.drawing.colors;
const Pixels = imports.drawing.pixels;

// Zoom callouts magnify what lies below them; nested callouts redraw their
// own underlay, so cap the recursion to keep repaints bounded.
const MAX_ZOOM_UNDERLAY_DEPTH = 3;

/** Minimum pointer travel (logical px) before a pen point is recorded. */
const MIN_STROKE_STEP = 1;

/** Fold Latin uppercase keyvals (A-Z) to lowercase (muffin's Clutter has
 * no keyval_to_lower). Keysyms for Latin letters equal their ASCII codes. */
function _keyvalToLower(keyval) {
    if (keyval >= 0x41 && keyval <= 0x5a)
        return keyval + 0x20;
    return keyval;
}

// Gettext fallback — can be overridden via DrawingOverlay.setGettext()
let _ = function(str) { return str; };

const TOOL_TO_MODE = {
    'pen': DrawingMode.PEN,
    'arrow': DrawingMode.ARROW,
    'line': DrawingMode.LINE,
    'rect': DrawingMode.RECT,
    'circle': DrawingMode.CIRCLE,
    'text': DrawingMode.TEXT,
    'highlight': DrawingMode.HIGHLIGHTER,
    'censor': DrawingMode.CENSOR,
    'blur': DrawingMode.BLUR,
    'invert': DrawingMode.INVERT,
    'zoom': DrawingMode.ZOOM_CALLOUT,
    'number': DrawingMode.NUMBER,
    'number-arrow': DrawingMode.NUMBER_ARROW,
    'number-pointer': DrawingMode.NUMBER_POINTER,
    'eraser': DrawingMode.ERASER,
    'select': DrawingMode.SELECT,
};

const MultilineEntry = GObject.registerClass(
class MultilineEntry extends St.Entry {
    vfunc_get_preferred_height(forWidth) {
        const base = super.vfunc_get_preferred_height(forWidth);
        let effectiveWidth = forWidth;
        if (effectiveWidth < 0) {
            const preferredWidth = super.vfunc_get_preferred_width(-1);
            effectiveWidth = preferredWidth[1];
        }

        const themeNode = this.get_theme_node();
        const contentWidth = themeNode.adjust_for_width(effectiveWidth);
        const child = this.clutter_text.get_preferred_height(contentWidth);
        const adjusted = themeNode.adjust_preferred_height(child[0], child[1]);
        return [
            Math.max(base[0], adjusted[0]),
            Math.max(base[1], adjusted[1]),
        ];
    }

    vfunc_allocate(box, flags) {
        super.vfunc_allocate(box, flags);
        const contentBox = this.get_theme_node().get_content_box(box);
        this.clutter_text.allocate(contentBox, flags);
        const hintActor = this.get_hint_actor();
        if (hintActor)
            hintActor.allocate(contentBox, flags);
    }
});

var DrawingOverlay = class DrawingOverlay {
    constructor(parentActor, toolbar, keyActor, options) {
        this._ui = parentActor;
        this._keyActor = keyActor || parentActor;
        this._toolbar = toolbar;
        this._modalTextEntry = !!(options && options.modalTextEntry);
        this._onCancel = options && options.onCancel
            ? options.onCancel
            : null;
        this._textModalActive = false;
        this._actions = [];
        this._undoStack = [];
        this._redoStack = [];
        this._currentStroke = null;
        this._startPoint = null;
        this._isDrawing = false;
        // Number counters are computed dynamically from this._actions
        // See _getNextNumber()

        // Selection / move state
        this._selectedAction = null;
        this._isDragging = false;
        this._dragStart = null;
        this._isResizing = false;
        this._resizeCenter = null;
        this._resizeStartDist = 0;
        this._resizeStartFont = 0;
        this._resizeStartWrapWidth = 0;
        this._isRectResizing = false;
        this._rectResizeFixed = null;
        this._rectResizeBefore = null;
        this._dragTotal = null;
        this._focusIdleId = 0;
        this._textLayoutIdleId = 0;

        this._buildOverlay();
    }

    _getNextNumber(actionClass) {
        // Highest existing number + 1, so deleting "2" of 1,2,3 does not
        // produce a duplicate "3".
        let max = 0;
        for (const action of this._actions) {
            if (action instanceof actionClass && action.number > max)
                max = action.number;
        }
        return max + 1;
    }

    _buildOverlay() {
        this._actor = new St.DrawingArea({
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        // Connect repaint for Cairo drawing
        this._repaintId = this._actor.connect('repaint', (area) => {
            const cr = area.get_context();
            try {
                const [width, height] = area.get_surface_size();
                this._onDraw(cr, width, height);
            } catch (e) {
                log('[Big Shot] Overlay repaint failed: ' + e.message);
            } finally {
                Pixels.disposeContext(cr);
            }
        });

        // Direct event handlers on the actor.
        this._actor.connect('button-press-event', (_actor, event) => {
            return this._onButtonPress(event);
        });
        this._actor.connect('button-release-event', (_actor, event) => {
            return this._onButtonRelease(event);
        });
        this._actor.connect('motion-event', (_actor, event) => {
            return this._onMotion(event);
        });
        this._actor.connect('scroll-event', (_actor, event) => {
            return this._onScroll(event);
        });

        // Key events for shortcuts (connected to the parent actor)
        this._keyId = this._keyActor.connect('key-press-event', (actor, event) => {
            if (!this._actor || !this._actor.visible) return Clutter.EVENT_PROPAGATE;
            // Keys typed into the text popover belong to the entry
            // (e.g. Ctrl+Z must not undo an annotation while typing).
            if (this._textPopover) return Clutter.EVENT_PROPAGATE;
            return this._onKeyPress(event);
        });

        // Initially hidden
        this._actor.visible = false;

        if (this._ui) {
            this._ui.add_child(this._actor);
        }
    }

    show(width, height) {
        if (!this._actor) return;
        this._actor.set_size(width, height);
        this._actor.visible = true;
        this._actor.queue_repaint();
    }

    hide() {
        if (this._actor)
            this._actor.visible = false;
    }

    _queueRepaint() {
        if (this._actor)
            this._actor.queue_repaint();
    }

    /** True while the user is editing (overlay captures input). */
    _isEditing() {
        if (this._actor && this._actor.reactive)
            return true;
        return !!(this._toolbar && this._toolbar.editMode);
    }

    /** Drop any pointer interaction in progress (drawing, drag, resize). */
    _resetPointerState() {
        this._isDrawing = false;
        this._currentStroke = null;
        this._startPoint = null;
        this._currentEndPoint = null;
        this._isDragging = false;
        this._dragStart = null;
        this._dragTotal = null;
        this._isResizing = false;
        this._resizeCenter = null;
        this._isRectResizing = false;
        this._rectResizeFixed = null;
        this._rectResizeBefore = null;
    }

    /** Forget the selection (and any interaction bound to it). */
    _clearSelectionState() {
        this._selectedAction = null;
        this._lastClickAction = null;
        this._lastClickTime = 0;
        this._isDragging = false;
        this._dragStart = null;
        this._dragTotal = null;
        this._isResizing = false;
        this._resizeCenter = null;
        this._isRectResizing = false;
        this._rectResizeFixed = null;
        this._rectResizeBefore = null;
    }

    /** Clear the selection if it points to an action no longer present. */
    _validateSelection() {
        if (this._selectedAction &&
            this._actions.indexOf(this._selectedAction) < 0)
            this._clearSelectionState();
        if (this._lastClickAction &&
            this._actions.indexOf(this._lastClickAction) < 0) {
            this._lastClickAction = null;
            this._lastClickTime = 0;
        }
    }

    /**
     * Enable/disable event capture for drawing.
     * Toggles the actor's reactivity so it captures mouse events directly.
     */
    setReactive(active) {
        if (this._actor) {
            this._actor.reactive = active;
        }
        if (!active) {
            // Reset drawing state when deactivating
            this._resetPointerState();
        }
    }

    _getOptions() {
        const toolbar = this._toolbar;
        const mode = TOOL_TO_MODE[toolbar ? toolbar.activeTool : null] || DrawingMode.PEN;
        const colorHex = (toolbar ? toolbar.currentColor : null) || '#ed333b';
        const fillHex = toolbar ? toolbar.fillColor : null;
        const size = (toolbar ? toolbar.brushSize : null) || 3;
        const intensity = (toolbar ? toolbar.intensity : null) || 3;

        const primaryColor = Colors.hexToRGBA(colorHex) ||
            Colors.hexToRGBA(Colors.PALETTE[0]);
        let fillColor = null;
        if (mode === DrawingMode.NUMBER || mode === DrawingMode.NUMBER_ARROW || mode === DrawingMode.NUMBER_POINTER) {
            fillColor = primaryColor.slice();
        } else if (fillHex) {
            fillColor = Colors.hexToRGBA(fillHex);
        }

        return new DrawingOptions({
            mode,
            primaryColor,
            size,
            fillColor,
            font: (toolbar ? toolbar.currentFont : null) || 'Sans',
            intensity,
        });
    }

    _toImageCoords(x, y) {
        // Clutter events use stage coordinates; actions use overlay-local
        // logical coordinates on both screenshot and recording hosts.
        if (this._actor) {
            try {
                const point = this._actor.transform_stage_point(x, y);
                if (point[0])
                    return [point[1], point[2]];
            } catch (e) {
                // Fall back to 1:1 for detached test actors.
            }
        }
        return [x, y];
    }

    _toWidgetCoords(x, y) {
        return [x, y];
    }

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    _onButtonPress(event) {
        // Only the primary button draws / selects
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);
        const now = GLib.get_monotonic_time();

        // Selection mode: no tool active or select tool → select/move objects
        const isSelectMode = !this._toolbar || !this._toolbar.activeTool || this._toolbar.activeTool === 'select';

        // Eraser mode: click on an action to remove it
        const isEraserMode = this._toolbar && this._toolbar.activeTool === 'eraser';
        if (isEraserMode) {
            for (let i = this._actions.length - 1; i >= 0; i--) {
                if (this._actions[i].containsPoint(ix, iy)) {
                    const action = this._actions.splice(i, 1)[0];
                    this._recordHistory({ type: 'remove', action, index: i });
                    this._validateSelection();
                    this._actor.queue_repaint();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_STOP;
        }

        if (isSelectMode) {
            const rectHandle = this._getEffectResizeHandle(
                this._selectedAction,
                ix,
                iy
            );
            if (rectHandle) {
                this._isRectResizing = true;
                this._rectResizeFixed = rectHandle.fixed;
                this._rectResizeBefore = {
                    start: [...this._selectedAction.start],
                    end: [...this._selectedAction.end],
                };
                return Clutter.EVENT_STOP;
            }

            if (this._selectedAction instanceof TextAction &&
                this._hitTextResizeHandle(this._selectedAction, ix, iy)) {
                const [minX, minY, maxX, maxY] =
                    this._selectedAction.getBounds();
                this._resizeCenter = [
                    (minX + maxX) / 2,
                    (minY + maxY) / 2,
                ];
                this._resizeStartDist = Math.max(1, Math.hypot(
                    ix - this._resizeCenter[0],
                    iy - this._resizeCenter[1]
                ));
                this._resizeStartFont = this._selectedAction.fontSize;
                this._resizeStartWrapWidth = this._selectedAction.wrapWidth || 0;
                this._isResizing = true;
                return Clutter.EVENT_STOP;
            }

            // Try to find an action under the cursor (top-most first)
            let found = null;
            for (let i = this._actions.length - 1; i >= 0; i--) {
                if (this._actions[i].containsPoint(ix, iy)) {
                    found = this._actions[i];
                    break;
                }
            }

            // Double-click on TextAction → edit it
            if (found instanceof TextAction &&
                this._lastClickAction === found &&
                (now - this._lastClickTime) < 500000) { // 500ms
                this._lastClickAction = null;
                this._lastClickTime = 0;
                this._editTextAction(found);
                return Clutter.EVENT_STOP;
            }

            // Double-click a zoom callout to edit its caption.
            if (found instanceof ZoomCalloutAction &&
                this._lastClickAction === found &&
                (now - this._lastClickTime) < 500000) {
                this._lastClickAction = null;
                this._lastClickTime = 0;
                this._showCaptionPopover(found);
                return Clutter.EVENT_STOP;
            }

            this._lastClickAction = found;
            this._lastClickTime = now;

            this._selectedAction = found;
            if (found) {
                this._isDragging = true;
                this._dragStart = [ix, iy];
                this._dragTotal = [0, 0];
                this._actor.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            this._actor.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        }

        // Drawing mode
        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
        this._isDrawing = true;
        this._startPoint = [ix, iy];

        if (mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) {
            this._currentStroke = [[ix, iy]];
        }

        return Clutter.EVENT_STOP;
    }

    _isInteracting() {
        return this._isDrawing || this._isDragging || this._isResizing ||
            this._isRectResizing;
    }

    _onMotion(event) {
        // The release may have happened outside the overlay (no implicit
        // grab): finish the interaction instead of leaving it stuck.
        if (this._isInteracting() &&
            !(event.get_state() & Clutter.ModifierType.BUTTON1_MASK))
            return this._finishInteraction(event);

        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);

        if (this._isRectResizing && this._selectedAction &&
            this._rectResizeFixed) {
            this._selectedAction.start = [...this._rectResizeFixed];
            this._selectedAction.end = [ix, iy];
            this._selectedAction.shift = false;
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (this._isResizing && this._selectedAction && this._resizeCenter) {
            const distance = Math.hypot(
                ix - this._resizeCenter[0],
                iy - this._resizeCenter[1]
            );
            const fontSize = this._resizeStartFont *
                (distance / this._resizeStartDist);
            this._selectedAction.fontSize = Math.max(
                8,
                Math.min(200, fontSize)
            );
            if (this._resizeStartWrapWidth > 0) {
                this._selectedAction.wrapWidth = this._resizeStartWrapWidth *
                    (this._selectedAction.fontSize / this._resizeStartFont);
            }
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        // Drag mode — moving selected action
        if (this._isDragging && this._selectedAction && this._dragStart) {
            const dx = ix - this._dragStart[0];
            const dy = iy - this._dragStart[1];
            this._selectedAction.translate(dx, dy);
            this._dragStart = [ix, iy];
            this._dragTotal[0] += dx;
            this._dragTotal[1] += dy;
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_STOP;

        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;

        if ((mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) && this._currentStroke) {
            const last = this._currentStroke[this._currentStroke.length - 1];
            if (!last || Math.hypot(ix - last[0], iy - last[1]) >= MIN_STROKE_STEP)
                this._currentStroke.push([ix, iy]);
        }

        // Track current endpoint for all modes (needed for live shape preview)
        this._currentEndPoint = [ix, iy];
        this._actor.queue_repaint();

        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        return this._finishInteraction(event);
    }

    _finishInteraction(event) {
        if (this._isRectResizing) {
            const action = this._selectedAction;
            const before = this._rectResizeBefore;
            if (!action || !before) {
                this._resetPointerState();
                return Clutter.EVENT_STOP;
            }
            const after = {
                start: [...action.start],
                end: [...action.end],
            };
            this._isRectResizing = false;
            this._rectResizeFixed = null;
            this._rectResizeBefore = null;
            if (before.start[0] !== after.start[0] ||
                before.start[1] !== after.start[1] ||
                before.end[0] !== after.end[0] ||
                before.end[1] !== after.end[1]) {
                this._recordHistory({
                    type: 'rect-geometry',
                    action,
                    before,
                    after,
                });
                this._generateEffectPreview(action);
            }
            return Clutter.EVENT_STOP;
        }

        if (this._isResizing) {
            const action = this._selectedAction;
            if (!action) {
                this._resetPointerState();
                return Clutter.EVENT_STOP;
            }
            const before = {
                fontSize: this._resizeStartFont,
                wrapWidth: this._resizeStartWrapWidth,
            };
            const after = {
                fontSize: action.fontSize,
                wrapWidth: action.wrapWidth || 0,
            };
            this._isResizing = false;
            this._resizeCenter = null;
            if (before.fontSize !== after.fontSize ||
                before.wrapWidth !== after.wrapWidth) {
                this._recordHistory({
                    type: 'text-style',
                    action,
                    before,
                    after,
                });
            }
            return Clutter.EVENT_STOP;
        }

        // End drag
        if (this._isDragging) {
            const action = this._selectedAction;
            const total = this._dragTotal || [0, 0];
            this._isDragging = false;
            this._dragStart = null;
            this._dragTotal = null;
            if (total[0] !== 0 || total[1] !== 0) {
                this._recordHistory({
                    type: 'move',
                    action,
                    dx: total[0],
                    dy: total[1],
                });
                if (this._isPixelEffect(action))
                    this._generateEffectPreview(action);
            }
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_STOP;

        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);
        const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const options = this._getOptions();

        let action = null;

        switch (mode) {
            case DrawingMode.PEN:
                if (this._currentStroke && this._currentStroke.length > 1) {
                    action = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
                }
                break;
            case DrawingMode.HIGHLIGHTER:
                if (this._currentStroke && this._currentStroke.length > 1) {
                    action = createAction(DrawingMode.HIGHLIGHTER, {
                        stroke: this._currentStroke, shift
                    }, options);
                }
                break;
            case DrawingMode.ARROW:
                action = createAction(DrawingMode.ARROW, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.LINE:
                action = createAction(DrawingMode.LINE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.RECT:
                action = createAction(DrawingMode.RECT, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CIRCLE:
                action = createAction(DrawingMode.CIRCLE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CENSOR:
                action = createAction(DrawingMode.CENSOR, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
            case DrawingMode.BLUR:
                action = createAction(DrawingMode.BLUR, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
            case DrawingMode.INVERT:
                action = createAction(DrawingMode.INVERT, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
            case DrawingMode.ZOOM_CALLOUT: {
                const width = Math.abs(ix - this._startPoint[0]);
                const height = Math.abs(iy - this._startPoint[1]);
                if (width > 8 && height > 8) {
                    const zoom = 2;
                    const destPos = this._computeCalloutDest(
                        this._startPoint,
                        [ix, iy],
                        zoom
                    );
                    action = createAction(DrawingMode.ZOOM_CALLOUT, {
                        start: this._startPoint,
                        end: [ix, iy],
                        destPos,
                        zoom,
                    }, options);
                }
                break;
            }
            case DrawingMode.TEXT:
                // Show text entry popover instead of hardcoded text
                this._showTextPopover(this._startPoint, options);
                this._isDrawing = false;
                this._currentStroke = null;
                this._startPoint = null;
                return Clutter.EVENT_STOP;
            case DrawingMode.NUMBER:
                action = createAction(DrawingMode.NUMBER, {
                    position: this._startPoint,
                    number: this._getNextNumber(NumberStampAction),
                }, options);
                break;
            case DrawingMode.NUMBER_ARROW: {
                const dx = ix - this._startPoint[0];
                const dy = iy - this._startPoint[1];
                if (Math.hypot(dx, dy) >= 5) {
                    action = createAction(DrawingMode.NUMBER_ARROW, {
                        start: this._startPoint,
                        end: [ix, iy],
                        number: this._getNextNumber(NumberArrowAction),
                    }, options);
                }
                break;
            }
            case DrawingMode.NUMBER_POINTER: {
                const dx = ix - this._startPoint[0];
                const dy = iy - this._startPoint[1];
                if (Math.hypot(dx, dy) >= 5) {
                    action = createAction(DrawingMode.NUMBER_POINTER, {
                        start: this._startPoint,
                        end: [ix, iy],
                        number: this._getNextNumber(NumberPointerAction),
                    }, options);
                }
                break;
            }
            case DrawingMode.ERASER:
                // Eraser is handled in _onButtonPress (click-to-remove)
                break;
        }

        // A plain click must not create an invisible shape in the history
        if (action && !this._hasMinimumSize(action))
            action = null;

        if (action) {
            this._actions.push(action);
            this._recordHistory({
                type: 'add',
                action,
                index: this._actions.length - 1,
            });

            // Generate real preview for pixel effects.
            if (action instanceof CensorAction ||
                action instanceof BlurAction ||
                action instanceof InvertAction ||
                action instanceof ZoomCalloutAction) {
                this._generateEffectPreview(action);
            }
        }

        if (action instanceof ZoomCalloutAction)
            this._showCaptionPopover(action);

        this._isDrawing = false;
        this._currentStroke = null;
        this._startPoint = null;
        this._currentEndPoint = null;
        this._actor.queue_repaint();

        return Clutter.EVENT_STOP;
    }

    _hasMinimumSize(action) {
        const min = Actions.MIN_SHAPE_SIZE;
        if (action instanceof Actions.ArrowAction) {
            return Math.hypot(action.end[0] - action.start[0],
                action.end[1] - action.start[1]) >= min;
        }
        if (action instanceof Actions.RectAction) {
            const [minX, minY, maxX, maxY] = action.getBounds();
            return maxX - minX >= min && maxY - minY >= min;
        }
        return true;
    }

    _onScroll(event) {
        const selected = this._selectedAction;
        if (!(selected instanceof TextAction) &&
            !(selected instanceof ZoomCalloutAction))
            return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP) {
            delta = 1;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            delta = -1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const scroll = event.get_scroll_delta();
            if (scroll[1] < 0) delta = 1;
            else if (scroll[1] > 0) delta = -1;
            else return Clutter.EVENT_PROPAGATE;
        } else {
            return Clutter.EVENT_PROPAGATE;
        }

        if (selected instanceof ZoomCalloutAction) {
            const before = {
                zoom: selected.zoom,
                destPos: [...selected.destPos],
            };
            selected.setZoom(selected.zoom + delta * 0.25);
            this._clampActionToCanvas(selected);
            const after = {
                zoom: selected.zoom,
                destPos: [...selected.destPos],
            };
            if (before.zoom !== after.zoom ||
                before.destPos[0] !== after.destPos[0] ||
                before.destPos[1] !== after.destPos[1]) {
                this._recordHistory({
                    type: 'zoom-state',
                    action: selected,
                    before,
                    after,
                }, true);
            }
            this._actor.queue_repaint();
            return Clutter.EVENT_STOP;
        }

        const before = {
            fontSize: selected.fontSize,
            wrapWidth: selected.wrapWidth || 0,
        };
        selected.fontSize = Math.max(
            8,
            Math.min(200, selected.fontSize + delta * 2)
        );
        if (before.wrapWidth > 0 && before.fontSize > 0) {
            selected.wrapWidth = before.wrapWidth *
                (selected.fontSize / before.fontSize);
        }
        const after = {
            fontSize: selected.fontSize,
            wrapWidth: selected.wrapWidth || 0,
        };
        if (before.fontSize !== after.fontSize ||
            before.wrapWidth !== after.wrapWidth) {
            this._recordHistory({
                type: 'text-style',
                action: selected,
                before,
                after,
            }, true);
        }
        this._actor.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    _clampActionToCanvas(action) {
        if (!(action instanceof ZoomCalloutAction) || !this._actor)
            return;
        const captionHeight = action.captionBlockHeight();
        action.destPos = [
            Math.min(
                Math.max(0, action.destPos[0]),
                Math.max(0, this._actor.width - action.destW)
            ),
            Math.min(
                Math.max(0, action.destPos[1]),
                Math.max(
                    0,
                    this._actor.height - action.destH - captionHeight
                )
            ),
        ];
    }

    _hitTextResizeHandle(action, ix, iy, tolerance) {
        const tol = tolerance === undefined ? 12 : tolerance;
        const [minX, minY, maxX, maxY] = action.getBounds();
        const corners = [
            [minX, minY],
            [maxX, minY],
            [minX, maxY],
            [maxX, maxY],
        ];
        return corners.some(corner =>
            Math.abs(ix - corner[0]) <= tol &&
            Math.abs(iy - corner[1]) <= tol
        );
    }

    _isPixelEffect(action) {
        return action instanceof CensorAction ||
            action instanceof BlurAction ||
            action instanceof InvertAction;
    }

    _getEffectResizeHandle(action, ix, iy, tolerance) {
        if (!this._isPixelEffect(action))
            return null;

        const tol = tolerance === undefined ? 12 : tolerance;
        const [minX, minY, maxX, maxY] = action.getBounds();
        const handles = [
            { point: [minX, minY], fixed: [maxX, maxY] },
            { point: [maxX, minY], fixed: [minX, maxY] },
            { point: [minX, maxY], fixed: [maxX, minY] },
            { point: [maxX, maxY], fixed: [minX, minY] },
        ];
        for (const handle of handles) {
            if (Math.abs(ix - handle.point[0]) <= tol &&
                Math.abs(iy - handle.point[1]) <= tol)
                return handle;
        }
        return null;
    }

    _onKeyPress(event) {
        // Normalise case so Shift / Caps Lock do not change the keyval
        // (Ctrl+Shift+Z arrives as KEY_Z).
        const key = _keyvalToLower(event.get_key_symbol());
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;

        // Escape → close the host editor or deselect current selection
        if (key === Clutter.KEY_Escape) {
            if (this._onCancel) {
                this._onCancel();
                return Clutter.EVENT_STOP;
            }
            if (this._selectedAction) {
                this._clearSelectionState();
                this._actor.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        // Everything below only applies while editing; otherwise the keys
        // belong to the host UI (and must not silently change tools).
        if (!this._isEditing())
            return Clutter.EVENT_PROPAGATE;

        // Ctrl+Z = Undo
        if (ctrl && !shift && key === Clutter.KEY_z) {
            this.undo();
            return Clutter.EVENT_STOP;
        }

        // Ctrl+Shift+Z or Ctrl+Y = Redo
        if ((ctrl && shift && key === Clutter.KEY_z) || (ctrl && key === Clutter.KEY_y)) {
            this.redo();
            return Clutter.EVENT_STOP;
        }

        // Delete = remove last action (or selected action)
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_BackSpace) {
            if (this._selectedAction) {
                const idx = this._actions.indexOf(this._selectedAction);
                if (idx >= 0) {
                    const action = this._actions.splice(idx, 1)[0];
                    this._recordHistory({ type: 'remove', action, index: idx });
                }
                this._clearSelectionState();
                this._actor.queue_repaint();
            } else if (this._actions.length > 0) {
                const index = this._actions.length - 1;
                const action = this._actions.pop();
                this._recordHistory({ type: 'remove', action, index });
                this._actor.queue_repaint();
            }
            return Clutter.EVENT_STOP;
        }

        // Keyboard tool shortcuts
        const TOOL_KEYS = {
            [Clutter.KEY_1]: 'pen',
            [Clutter.KEY_2]: 'arrow',
            [Clutter.KEY_3]: 'line',
            [Clutter.KEY_4]: 'rect',
            [Clutter.KEY_5]: 'circle',
            [Clutter.KEY_6]: 'text',
            [Clutter.KEY_7]: 'highlight',
            [Clutter.KEY_8]: 'censor',
            [Clutter.KEY_9]: 'number',
            [Clutter.KEY_b]: 'blur',
            [Clutter.KEY_i]: 'invert',
            [Clutter.KEY_e]: 'eraser',
        };

        if (!ctrl && !shift && TOOL_KEYS[key]) {
            if (this._toolbar) this._toolbar.selectTool(TOOL_KEYS[key]);
            return Clutter.EVENT_STOP;
        }

        // 0 or S → selection mode
        if (!ctrl && !shift && (key === Clutter.KEY_0 || key === Clutter.KEY_s)) {
            if (this._toolbar) this._toolbar.selectTool('select');
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // =========================================================================
    // TEXT POPOVER
    // =========================================================================

    _showTextPopover(position, options, existingAction, custom) {
        if (existingAction === undefined) existingAction = null;
        if (custom === undefined) custom = null;

        this._closeTextPopover();

        const [wx, wy] = this._toWidgetCoords(position[0], position[1]);

        this._textPopover = new St.BoxLayout({
            style: 'background: rgba(30,30,30,0.95); border-radius: 8px; padding: 8px; ' +
                   'border: 1px solid rgba(255,255,255,0.15);',
            vertical: false,
            reactive: true,
        });

        const EntryClass = custom ? St.Entry : MultilineEntry;
        this._textEntry = new EntryClass({
            hint_text: custom ? custom.hint : _('Text…'),
            style: custom
                ? 'width: 200px; min-height: 28px; font-size: 14px;'
                : 'width: 320px; min-height: 96px; border-radius: 10px; font-size: 14px;',
            can_focus: true,
            accessible_name: custom
                ? custom.accessibleName
                : _('Annotation text'),
        });

        const textActor = this._textEntry.clutter_text;
        const multiline = !custom;
        textActor.set_single_line_mode(!multiline);
        textActor.set_line_wrap(multiline);
        if (multiline)
            textActor.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        textActor.set_activatable(!multiline);

        const fontSize = existingAction ? existingAction.fontSize : options.size * 5;
        textActor.set_font_description(
            Actions.fontDescription(options.font, fontSize));

        // Pre-fill with existing text when editing
        if (custom && custom.initialText) {
            this._textEntry.set_text(custom.initialText);
        } else if (existingAction) {
            this._textEntry.set_text(existingAction.text);
        }

        if (custom && custom.onChange) {
            textActor.connect('text-changed', () => {
                custom.onChange(this._textEntry.get_text());
            });
        }

        const confirmBtn = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16 }),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Confirm'),
        });

        const confirmAction = () => {
            if (!this._textEntry)
                return;
            // Confirming consumes the pending commit (see _closeTextPopover)
            this._popoverCommit = null;
            const text = this._textEntry.get_text();
            const hasText = text.trim().length > 0;
            const wrapWidth = Math.max(
                1,
                Math.floor(textActor.width || existingAction && existingAction.wrapWidth || 300)
            );
            if (custom) {
                custom.onConfirm(text.trim());
            } else if (existingAction) {
                // Editing existing text
                if (hasText) {
                    const before = {
                        text: existingAction.text,
                        wrapWidth: existingAction.wrapWidth || 0,
                    };
                    existingAction.text = text;
                    existingAction.wrapWidth = wrapWidth;
                    existingAction._metrics = null;
                    const after = { text, wrapWidth };
                    if (before.text !== after.text ||
                        before.wrapWidth !== after.wrapWidth) {
                        this._recordHistory({
                            type: 'text-edit',
                            action: existingAction,
                            before,
                            after,
                        });
                    }
                } else {
                    // Empty text → remove the action
                    const idx = this._actions.indexOf(existingAction);
                    if (idx >= 0) {
                        const action = this._actions.splice(idx, 1)[0];
                        this._recordHistory({
                            type: 'remove',
                            action,
                            index: idx,
                        });
                    }
                }
            } else if (hasText) {
                // Creating new text
                const action = createAction(DrawingMode.TEXT, {
                    position,
                    text,
                    fontSize,
                    wrapWidth,
                }, options);
                if (action) {
                    this._actions.push(action);
                    this._recordHistory({
                        type: 'add',
                        action,
                        index: this._actions.length - 1,
                    });
                }
            }
            this._closeTextPopover();
            this._actor.queue_repaint();
        };

        confirmBtn.connect('clicked', confirmAction);
        if (!multiline)
            textActor.connect('activate', confirmAction);

        textActor.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape) {
                this._popoverCommit = null;
                if (custom && custom.onCancel)
                    custom.onCancel();
                this._closeTextPopover();
                return Clutter.EVENT_STOP;
            }
            if (multiline &&
                (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
                if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
                    confirmAction();
                    return Clutter.EVENT_STOP;
                }

                let cursor = textActor.cursor_position;
                const selection = textActor.selection_bound;
                if (cursor < 0)
                    cursor = textActor.get_text().length;
                if (selection >= 0 && selection !== cursor) {
                    const start = Math.min(cursor, selection);
                    const end = Math.max(cursor, selection);
                    textActor.delete_text(start, end);
                    cursor = start;
                }
                textActor.insert_text('\n', cursor);
                textActor.set_cursor_position(cursor + 1);
                textActor.set_selection_bound(cursor + 1);
                return Clutter.EVENT_STOP;
            }
            if (custom && custom.onKey && custom.onKey(event))
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        });

        // If the popover is closed by anything other than confirm/Escape
        // (another popover opening, the tool changing…), keep what was
        // typed instead of silently dropping it or leaving live caption
        // edits outside the undo history.
        this._popoverCommit = confirmAction;

        this._textPopover.add_child(this._textEntry);
        if (custom && custom.extraChild)
            this._textPopover.add_child(custom.extraChild);
        this._textPopover.add_child(confirmBtn);

        this._ui.add_child(this._textPopover);
        this._textPopover.set_position(Math.max(0, wx - 100), Math.max(0, wy - 44));
        if (this._modalTextEntry) {
            this._textModalActive = !!Main.pushModal(this._textPopover);
        }
        textActor.connect('text-changed', () => {
            if (this._textEntry)
                this._textEntry.queue_relayout();
            if (this._textPopover)
                this._textPopover.queue_relayout();
            this._queueTextPopoverPosition(wx, wy);
        });
        this._queueTextPopoverPosition(wx, wy);

        // Focus the entry after a frame
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            if (this._textEntry) {
                this._textEntry.grab_key_focus();
                // Select all text when editing existing action
                if (existingAction || custom && custom.initialText) {
                    const clutterText = this._textEntry.clutter_text;
                    clutterText.set_selection(0, clutterText.get_text().length);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueTextPopoverPosition(anchorX, anchorY) {
        if (this._textLayoutIdleId)
            GLib.source_remove(this._textLayoutIdleId);
        this._textLayoutIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._textLayoutIdleId = 0;
            if (!this._textPopover || !this._ui)
                return GLib.SOURCE_REMOVE;

            const preferredWidth = this._textPopover.get_preferred_width(-1);
            const width = Math.max(
                this._textPopover.width,
                preferredWidth[1]
            );
            const preferredHeight = this._textPopover.get_preferred_height(width);
            const height = Math.max(
                this._textPopover.height,
                preferredHeight[1]
            );
            const maxX = Math.max(0, this._ui.width - width);
            const maxY = Math.max(0, this._ui.height - height);
            this._textPopover.set_position(
                Math.min(Math.max(0, anchorX - 100), maxX),
                Math.min(Math.max(0, anchorY - 44), maxY)
            );
            return GLib.SOURCE_REMOVE;
        });
    }

    _editTextAction(action) {
        this._selectedAction = null;
        this._showTextPopover(action.position, action.options, action);
    }

    _showCaptionPopover(action) {
        this._selectedAction = null;
        const anchor = [
            action.destPos[0],
            action.destPos[1] + action.destH,
        ];
        const before = {
            caption: action.caption,
            captionSizeIndex: action.captionSizeIndex,
            captionStyle: action.captionStyle,
            destPos: [...action.destPos],
        };
        const styleLabel = new St.Label({
            text: '★',
            style: 'color: #ffffff; font-weight: bold; padding: 0 6px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const styleButton = new St.Button({
            child: styleLabel,
            can_focus: false,
            accessible_name: _('Highlighter'),
        });
        const refreshStyle = () => {
            styleButton.set_style(action.captionStyle === 'highlight'
                ? 'background: #dd4814; border-radius: 6px; border: 1px solid rgba(255,255,255,0.4); min-height: 28px;'
                : 'background: rgba(255,255,255,0.12); border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); min-height: 28px;');
        };
        refreshStyle();
        styleButton.connect('clicked', () => {
            action.toggleCaptionStyle();
            refreshStyle();
            this._actor.queue_repaint();
            if (this._textEntry)
                this._textEntry.grab_key_focus();
        });

        const finish = () => {
            const after = {
                caption: action.caption,
                captionSizeIndex: action.captionSizeIndex,
                captionStyle: action.captionStyle,
                destPos: [...action.destPos],
            };
            const last = this._undoStack[this._undoStack.length - 1];
            const belongsToNewAction = last && last.type === 'add' &&
                last.action === action;
            if (!belongsToNewAction &&
                (before.caption !== after.caption ||
                 before.captionSizeIndex !== after.captionSizeIndex ||
                 before.captionStyle !== after.captionStyle ||
                 before.destPos[0] !== after.destPos[0] ||
                 before.destPos[1] !== after.destPos[1])) {
                this._recordHistory({
                    type: 'caption-state',
                    action,
                    before,
                    after,
                });
            }
        };

        this._showTextPopover(anchor, action.options, null, {
            hint: _('Text…'),
            accessibleName: _('Annotation text'),
            initialText: action.caption || '',
            extraChild: styleButton,
            onChange: text => {
                action.setCaption(text);
                this._clampActionToCanvas(action);
                this._actor.queue_repaint();
            },
            onKey: event => {
                const key = event.get_key_symbol();
                if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down)
                    return false;
                action.cycleCaptionSize(key === Clutter.KEY_Up ? 1 : -1);
                this._clampActionToCanvas(action);
                this._actor.queue_repaint();
                return true;
            },
            onConfirm: text => {
                action.setCaption(text);
                finish();
            },
            onCancel: () => {
                action.caption = before.caption;
                action.captionSizeIndex = before.captionSizeIndex;
                action.captionStyle = before.captionStyle;
                action.destPos = [...before.destPos];
                this._actor.queue_repaint();
            },
        });
    }

    /**
     * Close the text popover.
     * @param {boolean} discard - drop pending text (overlay teardown)
     */
    _closeTextPopover(discard) {
        const commit = this._popoverCommit;
        this._popoverCommit = null;
        if (commit && !discard && this._textPopover) {
            // commit() ends up calling _closeTextPopover() again
            commit();
            return;
        }
        if (this._focusIdleId) {
            GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
        }
        if (this._textLayoutIdleId) {
            GLib.source_remove(this._textLayoutIdleId);
            this._textLayoutIdleId = 0;
        }
        if (this._textModalActive && this._textPopover) {
            try {
                Main.popModal(this._textPopover);
            } catch (e) {
                // Modal may already be released during recording shutdown.
            }
            this._textModalActive = false;
        }
        if (this._textPopover) {
            this._textPopover.destroy();
        }
        this._textPopover = null;
        this._textEntry = null;

        // Return focus to the parent UI so Enter key works for capture
        if (this._ui && !discard) {
            try {
                this._ui.grab_key_focus();
            } catch (e) {
                // Parent may be going away.
            }
        }
    }

    // =========================================================================
    // UNDO / REDO
    // =========================================================================

    _recordHistory(command, coalesce) {
        const now = GLib.get_monotonic_time();
        const last = this._undoStack[this._undoStack.length - 1];
        // Consecutive scroll notches on the same object become one step
        if (coalesce && last && last.type === command.type &&
            last.action === command.action && last.after &&
            now - (last._time || 0) < 800000) {
            last.after = command.after;
            last._time = now;
            this._redoStack = [];
            return;
        }
        command._time = now;
        this._undoStack.push(command);
        this._redoStack = [];
    }

    _insertHistoryAction(command) {
        if (this._actions.indexOf(command.action) >= 0)
            return;
        const index = Math.max(
            0,
            Math.min(command.index, this._actions.length)
        );
        this._actions.splice(index, 0, command.action);
    }

    _removeHistoryAction(command) {
        const index = this._actions.indexOf(command.action);
        if (index >= 0)
            this._actions.splice(index, 1);
        if (this._selectedAction === command.action)
            this._selectedAction = null;
    }

    _applyHistory(command, forward) {
        switch (command.type) {
            case 'add':
                if (forward)
                    this._insertHistoryAction(command);
                else
                    this._removeHistoryAction(command);
                break;
            case 'remove':
                if (forward)
                    this._removeHistoryAction(command);
                else
                    this._insertHistoryAction(command);
                break;
            case 'move': {
                const factor = forward ? 1 : -1;
                command.action.translate(
                    command.dx * factor,
                    command.dy * factor
                );
                if (this._isPixelEffect(command.action))
                    this._generateEffectPreview(command.action);
                break;
            }
            case 'text-style': {
                const state = forward ? command.after : command.before;
                command.action.fontSize = state.fontSize;
                command.action.wrapWidth = state.wrapWidth;
                command.action._metrics = null;
                break;
            }
            case 'text-edit': {
                const state = forward ? command.after : command.before;
                command.action.text = state.text;
                command.action.wrapWidth = state.wrapWidth;
                command.action._metrics = null;
                break;
            }
            case 'rect-geometry': {
                const state = forward ? command.after : command.before;
                command.action.start = [...state.start];
                command.action.end = [...state.end];
                command.action.shift = false;
                this._generateEffectPreview(command.action);
                break;
            }
            case 'zoom-state': {
                const state = forward ? command.after : command.before;
                command.action.zoom = state.zoom;
                command.action.destPos = [...state.destPos];
                break;
            }
            case 'caption-state': {
                const state = forward ? command.after : command.before;
                command.action.caption = state.caption;
                command.action.captionSizeIndex = state.captionSizeIndex;
                command.action.captionStyle = state.captionStyle;
                command.action.destPos = [...state.destPos];
                break;
            }
        }
    }

    undo() {
        if (this._undoStack.length === 0 || !this._actor) return;
        const command = this._undoStack.pop();
        this._applyHistory(command, false);
        this._redoStack.push(command);
        this._validateSelection();
        this._actor.queue_repaint();
    }

    redo() {
        if (this._redoStack.length === 0 || !this._actor) return;
        const command = this._redoStack.pop();
        this._applyHistory(command, true);
        this._undoStack.push(command);
        this._validateSelection();
        this._actor.queue_repaint();
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    /**
     * Draw actions [0, end) in creation order. A zoom callout magnifies
     * everything drawn before it (same semantics as the exporter), so
     * effects under the zoomed area are never bypassed.
     */
    _drawActions(cr, toWidget, scale, end, depth) {
        for (let i = 0; i < end; i++) {
            const action = this._actions[i];
            cr.save();
            cr.newPath();
            try {
                if (action instanceof ZoomCalloutAction &&
                    depth < MAX_ZOOM_UNDERLAY_DEPTH) {
                    action.draw(cr, toWidget, scale, c =>
                        this._drawActions(c, toWidget, scale, i, depth + 1));
                } else {
                    action.draw(cr, toWidget, scale);
                }
            } catch (e) {
                log('[Big Shot] Failed to draw annotation: ' + e.message);
            }
            cr.restore();
        }
    }

    _onDraw(cr, width, height) {
        // Clear (Cairo.Operator.CLEAR = 0)
        cr.save();
        cr.setOperator(0);
        cr.paint();
        cr.restore();

        const scale = 1.0; // Will be dynamic with zoom
        const toWidget = (x, y) => this._toWidgetCoords(x, y);

        // Draw all committed actions
        this._drawActions(cr, toWidget, scale, this._actions.length, 0);

        // Draw current in-progress action (live preview while dragging)
        if (this._isDrawing && this._startPoint) {
            const options = this._getOptions();
            const mode = TOOL_TO_MODE[this._toolbar.activeTool] || DrawingMode.PEN;
            let tempAction;
            const end = this._currentEndPoint || this._startPoint;

            switch (mode) {
                case DrawingMode.PEN:
                    if (this._currentStroke && this._currentStroke.length > 1)
                        tempAction = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
                    break;
                case DrawingMode.HIGHLIGHTER:
                    if (this._currentStroke && this._currentStroke.length > 1)
                        tempAction = createAction(DrawingMode.HIGHLIGHTER, { stroke: this._currentStroke, shift: false }, options);
                    break;
                case DrawingMode.ARROW:
                    tempAction = createAction(DrawingMode.ARROW, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.LINE:
                    tempAction = createAction(DrawingMode.LINE, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.RECT:
                    tempAction = createAction(DrawingMode.RECT, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.CIRCLE:
                    tempAction = createAction(DrawingMode.CIRCLE, { start: this._startPoint, end, shift: false }, options);
                    break;
                case DrawingMode.CENSOR:
                    tempAction = createAction(DrawingMode.CENSOR, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.BLUR:
                    tempAction = createAction(DrawingMode.BLUR, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.INVERT:
                    tempAction = createAction(DrawingMode.INVERT, { start: this._startPoint, end }, options);
                    break;
                case DrawingMode.NUMBER_ARROW:
                    tempAction = createAction(DrawingMode.NUMBER_ARROW, {
                        start: this._startPoint, end, number: this._getNextNumber(NumberArrowAction),
                    }, options);
                    break;
                case DrawingMode.NUMBER_POINTER:
                    tempAction = createAction(DrawingMode.NUMBER_POINTER, {
                        start: this._startPoint, end, number: this._getNextNumber(NumberPointerAction),
                    }, options);
                    break;
            }

            if (tempAction) {
                cr.save();
                cr.newPath();
                try {
                    tempAction.draw(cr, toWidget, scale);
                } catch (e) {
                    log('[Big Shot] Failed to draw preview: ' + e.message);
                }
                cr.restore();
            }

            if (mode === DrawingMode.ZOOM_CALLOUT) {
                const [startX, startY] = toWidget(...this._startPoint);
                const [endX, endY] = toWidget(...end);
                cr.save();
                cr.setSourceRGBA(0.384, 0.627, 0.917, 0.95);
                cr.setLineWidth(1.5);
                cr.setDash([5, 4], 0);
                cr.rectangle(
                    Math.min(startX, endX),
                    Math.min(startY, endY),
                    Math.abs(endX - startX),
                    Math.abs(endY - startY)
                );
                cr.stroke();
                cr.restore();
            }
        }

        // Draw selection bounding box
        if (this._selectedAction) {
            const [minX, minY, maxX, maxY] = this._selectedAction.getBounds();
            const [wx1, wy1] = toWidget(minX, minY);
            const [wx2, wy2] = toWidget(maxX, maxY);
            const pad = 4;

            cr.save();
            cr.setSourceRGBA(0.384, 0.627, 0.917, 0.9); // #62a0ea
            cr.setLineWidth(1.5);
            cr.setDash([4, 4], 0);
            cr.rectangle(wx1 - pad, wy1 - pad, wx2 - wx1 + 2 * pad, wy2 - wy1 + 2 * pad);
            cr.stroke();

            // Small handles at corners
            const handleSize = 5;
            cr.setDash([], 0);
            const corners = [[wx1 - pad, wy1 - pad], [wx2 + pad, wy1 - pad],
                             [wx1 - pad, wy2 + pad], [wx2 + pad, wy2 + pad]];
            for (let c = 0; c < corners.length; c++) {
                const hx = corners[c][0];
                const hy = corners[c][1];
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.fill();
                cr.setSourceRGBA(0.384, 0.627, 0.917, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.stroke();
            }
            cr.restore();
        }

        return true;
    }

    // =========================================================================
    // EFFECT PREVIEW (pixel effects and zoom source pixels)
    // =========================================================================

    setCachedPixbuf(pixbuf, bufScale) {
        this._cachedPixbuf = pixbuf;
        this._cachedBufScale = bufScale;
        for (let i = 0; i < this._actions.length; i++) {
            let action = this._actions[i];
            if (typeof action.generatePreview === 'function')
                this._runPreview(action);
        }
        this._queueRepaint();
    }

    clearPreviewCache() {
        this._cachedPixbuf = null;
        this._cachedBufScale = null;
    }

    _runPreview(action) {
        try {
            action.generatePreview(this._cachedPixbuf, this._cachedBufScale);
        } catch (e) {
            log('[Big Shot] Effect preview failed: ' + e.message);
            if (typeof action.clearPreview === 'function')
                action.clearPreview();
        }
    }

    _generateEffectPreview(action) {
        if (!this._cachedPixbuf || !action ||
            typeof action.generatePreview !== 'function')
            return;
        this._runPreview(action);
        this._queueRepaint();
    }

    _computeCalloutDest(srcStart, srcEnd, zoom) {
        const srcX = Math.min(srcStart[0], srcEnd[0]);
        const srcY = Math.min(srcStart[1], srcEnd[1]);
        const srcEndX = Math.max(srcStart[0], srcEnd[0]);
        const srcEndY = Math.max(srcStart[1], srcEnd[1]);
        const destW = (srcEndX - srcX) * zoom;
        const destH = (srcEndY - srcY) * zoom;
        const canvasW = this._actor.width || srcEndX + destW;
        const canvasH = this._actor.height || srcEndY + destH;
        const margin = 24;
        const candidates = [
            [srcEndX + margin, srcY],
            [srcX - margin - destW, srcY],
            [srcX, srcEndY + margin],
            [srcX, srcY - margin - destH],
        ];

        for (const candidate of candidates) {
            if (candidate[0] >= 0 && candidate[1] >= 0 &&
                candidate[0] + destW <= canvasW &&
                candidate[1] + destH <= canvasH)
                return candidate;
        }

        return [
            Math.min(
                Math.max(0, srcEndX + margin),
                Math.max(0, canvasW - destW)
            ),
            Math.min(Math.max(0, srcY), Math.max(0, canvasH - destH)),
        ];
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    clear() {
        this._closeTextPopover(true);
        this._actions = [];
        this._undoStack = [];
        this._redoStack = [];
        this._resetPointerState();
        this._clearSelectionState();
        // Number counters are dynamic — no reset needed
        this._cachedPixbuf = null;
        this._cachedBufScale = null;
        this._queueRepaint();
    }

    clearSelection() {
        this._clearSelectionState();
        this._queueRepaint();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._closeTextPopover(true);
        this._cachedPixbuf = null;
        this._cachedBufScale = null;
        this._resetPointerState();
        this._clearSelectionState();

        if (this._actor) {
            // Ensure overlay is no longer reactive
            this._actor.reactive = false;
            if (this._repaintId)
                this._actor.disconnect(this._repaintId);
        }
        this._repaintId = 0;
        if (this._keyId && this._keyActor) {
            try {
                this._keyActor.disconnect(this._keyId);
            } catch (e) {
                // Key actor may already be destroyed.
            }
        }
        this._keyId = 0;

        if (this._actor)
            this._actor.destroy();
        this._actor = null;
        this._keyActor = null;
        this._actions = [];
        this._undoStack = [];
        this._redoStack = [];
    }
};

DrawingOverlay.setGettext = function(fn) { _ = fn; };
