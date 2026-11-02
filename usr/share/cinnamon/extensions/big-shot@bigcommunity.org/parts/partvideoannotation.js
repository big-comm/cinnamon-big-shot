/**
 * Big Shot — Video annotation for Cinnamon
 *
 * Supports live and paused editing. Finished annotations remain visible in
 * the recording after editing closes.
 *
 * SPDX-License-Identifier: MIT
 */

const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;
const Overlay = imports.drawing.overlay;
const DrawingOverlay = Overlay.DrawingOverlay;
const Compat = imports.compat;

let _ = function(str) { return str; };

var PartVideoAnnotation = class PartVideoAnnotation extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        this._toolbar = extension._toolbar;
        this._overlayHost = null;
        this._overlay = null;
        this._editing = false;
        this._activeMode = null;
        this._waitTimerId = 0;
        this._waitTicks = 0;
        this._previewCaptureId = 0;
        this._previewCaptureGeneration = 0;
        this._pendingFrame = false;
        this._editModalActive = false;
        this._captureHiddenActors = [];
        this._panelBox = null;

        if (this._toolbar) {
            this._toolbar.onToolChanged(toolId => {
                this._onToolChanged(toolId);
            });
        }
    }

    onRecordingStarted() {
        this._createPanelControls();
    }

    onRecordingStopped() {
        this._cancelWait();
        this._cancelPreviewCapture();
        this._finishEdit(false);
        this._destroyOverlay();
        this._destroyPanelControls();
    }

    toggleEdit() {
        if (this._editing) {
            this._finishEdit(false);
            return;
        }
        if (this._ext._recordingState === 'paused') {
            this._startEdit('paused');
            return;
        }
        if (this._ext._recordingState === 'recording')
            this._startEdit('live');
    }

    _waitForPause() {
        this._waitTicks++;
        if (this._ext._recordingState === 'paused') {
            this._waitTimerId = 0;
            this._startEdit('paused');
            return GLib.SOURCE_REMOVE;
        }
        if (this._ext._recordingState === 'idle' ||
            this._ext._recordingState === 'stopping' ||
            this._ext._recordingState === 'finalizing' ||
            this._waitTicks >= 200) {
            this._waitTimerId = 0;
            this._syncPanelState();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    enterPausedEditFromPause() {
        if (this._activeMode === 'paused' || this._waitTimerId)
            return;
        if (this._editing)
            this._finishEdit(false);
        if (this._ext._recordingState === 'paused') {
            this._startEdit('paused');
            return;
        }
        this._waitTicks = 0;
        this._waitTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            50,
            () => this._waitForPause()
        );
        this._syncPanelState();
    }

    _startEdit(mode) {
        if (!this._toolbar)
            return;
        this._ensureOverlay();
        if (!this._overlay)
            return;

        this._overlay.clearPreviewCache();
        this._pendingFrame = true;
        this._syncPanelState();
        this._captureBaseFrame((pixbuf, scale) => {
            let expectedState = mode === 'live' ? 'recording' : 'paused';
            this._pendingFrame = false;
            if (!this._overlay ||
                this._ext._recordingState !== expectedState) {
                this._syncPanelState();
                return;
            }
            if (pixbuf)
                this._overlay.setCachedPixbuf(pixbuf, scale);
            this._activateEdit(mode, !!pixbuf);
        });
    }

    _activateEdit(mode, effectsEnabled) {

        this._editing = true;
        this._activeMode = mode;
        this._savedUndo = this._toolbar._onUndo;
        this._savedRedo = this._toolbar._onRedo;
        this._toolbar._onUndo = () => this._overlay.undo();
        this._toolbar._onRedo = () => this._overlay.redo();
        this._setOverlayInput(true);
        this._acquireEditModal();
        this._toolbar.attachEditForRecording(
            () => this._finishEdit(false),
            effectsEnabled
        );
        this._toolbar.selectTool('pen');
        this._raiseControls();
        this._syncPanelState();
    }

    _captureBaseFrame(callback) {
        let geometry = this._virtualGeometry();
        let scale = global.ui_scale || 1;
        let generation = ++this._previewCaptureGeneration;
        let tmpPath = Compat.makeTempPath('big-shot-video-preview', 'png');

        this._hideCaptureActors(true);
        global.stage.queue_redraw();
        this._previewCaptureId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            16,
            () => {
                this._previewCaptureId = 0;
                if (generation !== this._previewCaptureGeneration) {
                    this._restoreOverlayVisibility();
                    return GLib.SOURCE_REMOVE;
                }
                let screenshot = new Cinnamon.Screenshot();
                let onCaptured = success => {
                    let pixbuf = null;
                    try {
                        if (success &&
                            generation === this._previewCaptureGeneration)
                            pixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpPath);
                    } catch (e) {
                        log('[Big Shot] Annotation frame failed: ' +
                            e.message);
                    } finally {
                        Compat.deleteQuietly(tmpPath);
                        this._restoreOverlayVisibility();
                    }
                    if (generation === this._previewCaptureGeneration)
                        callback(pixbuf, scale);
                };
                try {
                    Compat.screenshotArea(
                        screenshot,
                        false,
                        Math.round(geometry.x * scale),
                        Math.round(geometry.y * scale),
                        Math.round(geometry.width * scale),
                        Math.round(geometry.height * scale),
                        tmpPath,
                        onCaptured
                    );
                } catch (e) {
                    log('[Big Shot] Annotation capture failed: ' + e.message);
                    onCaptured(false);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _restoreOverlayVisibility() {
        for (let i = 0; i < this._captureHiddenActors.length; i++) {
            let item = this._captureHiddenActors[i];
            if (item.actor && item.wasVisible)
                item.actor.show();
        }
        this._captureHiddenActors = [];
    }

    _hideCaptureActors(includeOverlay) {
        this._restoreOverlayVisibility();
        let actors = [
            includeOverlay ? this._overlayHost : null,
            ...(this._toolbar && this._toolbar.previewHiddenActors
                ? this._toolbar.previewHiddenActors()
                : []),
            this._ext._indicator
                ? this._ext._indicator._panelButton
                : null,
        ].filter(Boolean);
        let seen = [];
        for (let i = 0; i < actors.length; i++) {
            let actor = actors[i];
            if (seen.indexOf(actor) >= 0)
                continue;
            seen.push(actor);
            let wasVisible = actor.visible;
            this._captureHiddenActors.push({
                actor: actor,
                wasVisible: wasVisible,
            });
            if (wasVisible)
                actor.hide();
        }
    }

    suspendControlsForCapture() {
        this._hideCaptureActors(false);
        return () => this._restoreOverlayVisibility();
    }

    _acquireEditModal() {
        if (this._editModalActive)
            return;
        this._editModalActive = Main.pushModal(global.stage);
        if (!this._editModalActive)
            log('[Big Shot] Could not acquire annotation keyboard focus');
    }

    _releaseEditModal() {
        if (!this._editModalActive)
            return;
        this._editModalActive = false;
        try {
            Main.popModal(global.stage);
        } catch (e) {
            log('[Big Shot] Could not release annotation keyboard focus: ' +
                e.message);
        }
    }

    _finishEdit(resume) {
        if (!this._editing)
            return false;

        this._overlay.clearSelection();
        this._overlay.setReactive(false);
        this._toolbar.selectTool(null);
        this._toolbar.detachEditForRecording();
        this._toolbar._onUndo = this._savedUndo;
        this._toolbar._onRedo = this._savedRedo;
        this._setOverlayInput(false);
        this._releaseEditModal();
        this._overlay.clearPreviewCache();

        this._editing = false;
        this._activeMode = null;
        this._syncPanelState();
        return true;
    }

    finishEditForStop() {
        this._cancelWait();
        this._cancelPreviewCapture();
        this._finishEdit(false);
    }

    finishEditForResume() {
        if (this._pendingFrame) {
            this._cancelPreviewCapture();
            return true;
        }
        if (!this._editing)
            return false;
        this._finishEdit(false);
        return true;
    }

    clearAnnotations() {
        if (this._overlay)
            this._overlay.clear();
    }

    _virtualGeometry() {
        let count = global.display.get_n_monitors();
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < count; i++) {
            let rect = global.display.get_monitor_geometry(i);
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);
        }
        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
        };
    }

    _ensureOverlay() {
        if (this._overlay)
            return;

        let geometry = this._virtualGeometry();
        this._overlayHost = new St.Widget({
            reactive: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._overlayHost.set_position(geometry.x, geometry.y);
        this._overlayHost.set_size(geometry.width, geometry.height);
        this._addOverlayChrome(false);

        this._overlay = new DrawingOverlay(
            this._overlayHost,
            this._toolbar,
            global.stage,
            {
                modalTextEntry: true,
                onCancel: () => this._finishEdit(false),
            }
        );
        this._overlay.show(geometry.width, geometry.height);
        this._overlay.setReactive(false);
    }

    _addOverlayChrome(active) {
        Main.layoutManager.addChrome(this._overlayHost, {
            affectsInputRegion: active,
            affectsStruts: false,
            visibleInFullscreen: true,
        });
        this._overlayHost._bigShotInputActive = active;
        this._lowerOverlayBelowPanel();
    }

    _setOverlayInput(active) {
        if (!this._overlayHost ||
            this._overlayHost._bigShotInputActive === active) {
            if (this._overlay)
                this._overlay.setReactive(active);
            return;
        }
        try {
            Main.layoutManager.removeChrome(this._overlayHost);
        } catch (e) {
            // Chrome may already be detached during shutdown.
        }
        this._addOverlayChrome(active);
        this._overlay.setReactive(active);
    }

    _lowerOverlayBelowPanel() {
        let parent = this._overlayHost.get_parent();
        let panelActor = Main.panel.actor || Main.panel;
        if (parent && panelActor && panelActor.get_parent() === parent) {
            try {
                parent.set_child_below_sibling(this._overlayHost, panelActor);
            } catch (e) {
                // Panel hierarchy differs across Cinnamon versions.
            }
        }
    }

    _raiseControls() {
        let webcam = this._ext._webcam ? this._ext._webcam._container : null;
        let webcamParent = webcam ? webcam.get_parent() : null;
        if (webcamParent && webcam) {
            try {
                webcamParent.set_child_above_sibling(webcam, null);
            } catch (e) {
                // Webcam may be reparenting between preview and recording.
            }
        }
        if (this._toolbar)
            this._toolbar.raiseRecordingToolbar();
        let parent = this._panelBox ? this._panelBox.get_parent() : null;
        if (parent && this._panelBox) {
            try {
                parent.set_child_above_sibling(this._panelBox, null);
            } catch (e) {
                // Panel may be reallocating.
            }
        }
    }

    _onToolChanged(toolId) {
        if (!this._editing || !this._overlay)
            return;
        this._overlay.setReactive(toolId !== null);
        if (toolId === null)
            this._overlay.clearSelection();
        this._raiseControls();
    }

    _createPanelControls() {
        if (this._panelBox)
            return;

        this._panelBox = new St.BoxLayout({
            reactive: false,
            style: 'spacing: 2px;',
        });
        this._editButton = this._makeButton(
            'document-edit-symbolic',
            _('Edit'),
            () => this.toggleEdit()
        );
        this._clearButton = this._makeButton(
            'edit-clear-symbolic',
            _('Eraser'),
            () => this.clearAnnotations()
        );
        this._screenshotButton = this._makeButton(
            'camera-photo-symbolic',
            _('Save Screenshot'),
            () => this._ext.captureScreenshotDuringRecording()
        );
        this._panelBox.add_child(this._editButton);
        this._panelBox.add_child(this._clearButton);
        this._panelBox.add_child(this._screenshotButton);

        let indicator = this._ext._indicator
            ? this._ext._indicator._panelButton
            : null;
        if (indicator) {
            indicator.add_child(this._panelBox);
        } else {
            let rightBox = Main.panel._rightBox;
            if (rightBox)
                rightBox.add_child(this._panelBox);
        }
        this._syncPanelState();
    }

    _makeButton(iconName, accessibleName, callback) {
        let button = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
            style: 'padding: 2px 5px; border-radius: 4px;',
        });
        button.set_child(new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
            icon_size: 16,
        }));
        button.connect('clicked', callback);
        return button;
    }

    _syncPanelState() {
        if (!this._editButton)
            return;
        let active = this._editing || this._waitTimerId !== 0 ||
            this._pendingFrame;
        this._editButton.style = active
            ? 'padding: 2px 5px; border-radius: 4px; background-color: rgba(98,160,234,0.55);'
            : 'padding: 2px 5px; border-radius: 4px;';
        this._editButton.reactive = this._waitTimerId === 0 &&
            !this._pendingFrame;
    }

    _destroyPanelControls() {
        if (!this._panelBox)
            return;
        let parent = this._panelBox.get_parent();
        if (parent)
            parent.remove_child(this._panelBox);
        this._panelBox.destroy();
        this._panelBox = null;
        this._editButton = null;
        this._clearButton = null;
        this._screenshotButton = null;
    }

    _cancelWait() {
        if (this._waitTimerId) {
            GLib.source_remove(this._waitTimerId);
            this._waitTimerId = 0;
        }
        this._waitTicks = 0;
    }

    _cancelPreviewCapture() {
        this._previewCaptureGeneration++;
        if (this._previewCaptureId) {
            GLib.source_remove(this._previewCaptureId);
            this._previewCaptureId = 0;
        }
        this._pendingFrame = false;
        this._restoreOverlayVisibility();
    }

    _destroyOverlay() {
        this._releaseEditModal();
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        if (this._overlayHost) {
            try {
                Main.layoutManager.removeChrome(this._overlayHost);
            } catch (e) {
                // Chrome may already be detached.
            }
            this._overlayHost.destroy();
            this._overlayHost = null;
        }
    }

    destroy() {
        this.onRecordingStopped();
        PartUI.prototype.destroy.call(this);
    }
};

PartVideoAnnotation.setGettext = function(fn) { _ = fn; };
