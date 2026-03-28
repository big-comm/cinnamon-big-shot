/**
 * Big Shot — Panel indicator during recording
 *
 * Shows a pause/resume button in the top panel with elapsed timer.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

let _ = function(str) { return str; };

var PartIndicator = class PartIndicator extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        this._isReady = false;
        this._panelButton = null;
        this._timerId = 0;
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
    }

    onPipelineStarting() {
        this._isReady = false;
    }

    onPipelineReady() {
        this._isReady = true;
    }

    onRecordingStarted() {
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
        this._createPanelButton();
        this._startTimer();
    }

    onPaused() {
        this._isPaused = true;
        this._pausedElapsed += this._elapsed;
        this._elapsed = 0;
        this._stopTimer();
        this._updatePanelButton();
    }

    onResumed() {
        this._isPaused = false;
        this._elapsed = 0;
        this._startTimer();
        this._updatePanelButton();
    }

    onRecordingStopped() {
        this._stopTimer();
        this._destroyPanelButton();
        this._elapsed = 0;
        this._pausedElapsed = 0;
        this._isPaused = false;
    }

    _createPanelButton() {
        this._destroyPanelButton();

        this._panelButton = new St.BoxLayout({
            style_class: 'panel-button big-shot-recording-indicator',
            reactive: false,
            style: 'spacing: 2px; background-color: rgba(220, 40, 40, 0.85); border-radius: 6px; padding: 0 6px; margin: 2px 4px;',
        });

        this._timerLabel = new St.Label({
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-variant-numeric: tabular-nums; margin-right: 4px; color: white;',
        });
        this._panelButton.add_child(this._timerLabel);

        let hoverStyle = 'padding: 2px 6px; border-radius: 4px; transition-duration: 150ms;';
        let hoverBg = 'background-color: rgba(255,255,255,0.25);';

        // Stop button
        this._stopBtn = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: hoverStyle,
        });
        this._stopIcon = new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            style_class: 'system-status-icon',
            icon_size: 16,
            style: 'color: white;',
        });
        this._stopBtn.set_child(this._stopIcon);
        this._stopBtn.connect('notify::hover', () => {
            this._stopBtn.style = this._stopBtn.hover
                ? hoverStyle + hoverBg
                : hoverStyle;
        });
        this._stopBtn.connect('clicked', () => {
            this._onStopClicked();
        });
        this._panelButton.add_child(this._stopBtn);

        // Pause/Resume button
        this._pauseBtn = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: hoverStyle,
        });
        this._icon = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'system-status-icon',
            icon_size: 16,
            style: 'color: white;',
        });
        this._pauseBtn.set_child(this._icon);
        this._pauseBtn.connect('notify::hover', () => {
            this._pauseBtn.style = this._pauseBtn.hover
                ? hoverStyle + hoverBg
                : hoverStyle;
        });
        this._pauseBtn.connect('clicked', () => {
            this._onPauseClicked();
        });
        this._panelButton.add_child(this._pauseBtn);

        // Add directly to panel right box
        try {
            let rightBox = Main.panel._rightBox || (Main.panel.actor ? Main.panel.actor.get_last_child() : null);
            if (rightBox) {
                rightBox.insert_child_at_index(this._panelButton, 0);
            }
        } catch (e) {
            log('[Big Shot Indicator] Failed to add to panel: ' + e.message);
        }
    }

    _destroyPanelButton() {
        if (this._panelButton) {
            let parent = this._panelButton.get_parent();
            if (parent) parent.remove_child(this._panelButton);
            this._panelButton.destroy();
            this._panelButton = null;
        }
        this._icon = null;
        this._timerLabel = null;
        this._stopBtn = null;
        this._stopIcon = null;
        this._pauseBtn = null;
    }

    _updatePanelButton() {
        if (!this._icon) return;

        if (this._isPaused) {
            this._icon.icon_name = 'media-playback-start-symbolic';
            // Change background to amber/orange when paused
            if (this._panelButton)
                this._panelButton.style = 'spacing: 2px; background-color: rgba(200, 140, 20, 0.9); border-radius: 6px; padding: 0 6px; margin: 2px 4px;';
        } else {
            this._icon.icon_name = 'media-playback-pause-symbolic';
            // Restore red background when recording
            if (this._panelButton)
                this._panelButton.style = 'spacing: 2px; background-color: rgba(220, 40, 40, 0.85); border-radius: 6px; padding: 0 6px; margin: 2px 4px;';
        }
    }

    _onPauseClicked() {
        if (this._ext) this._ext.togglePauseRecording();
    }

    _onStopClicked() {
        if (this._ext) this._ext._quickStop();
    }

    _startTimer() {
        this._stopTimer();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._elapsed++;
            this._updateTimerLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _updateTimerLabel() {
        if (!this._timerLabel) return;
        let total = this._pausedElapsed + this._elapsed;
        let minutes = Math.floor(total / 60);
        let seconds = total % 60;
        this._timerLabel.text = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    destroy() {
        this._stopTimer();
        this._destroyPanelButton();
        PartUI.prototype.destroy.call(this);
    }
};

PartIndicator.setGettext = function(fn) { _ = fn; };
