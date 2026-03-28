/**
 * Big Shot — Audio recording (Desktop + Mic)
 *
 * Adds toggle buttons for desktop audio and microphone capture.
 * Uses PulseAudio via Cvc.MixerControl to detect audio devices.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Cvc = imports.gi.Cvc;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

let _ = function(str) { return str; };

// =============================================================================
// Simple Icon+Label button (replaces GObject.registerClass version)
// =============================================================================

function _createIconLabelButton(gicon, labelText, params) {
    let btn = new St.Button(params);

    let container = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 4px;',
    });
    btn.set_child(container);

    container.add_child(new St.Icon({ gicon: gicon, icon_size: 16 }));

    let labelActor = new St.Label({
        text: labelText,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'font-size: 11px;',
    });
    container.add_child(labelActor);

    return btn;
}

// =============================================================================
// PartAudio — Desktop + Mic audio capture
// =============================================================================

var PartAudio = class PartAudio extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._desktopDevice = null;
        this._micDevice = null;
        this._selectedMicId = null;
        this._iconsDir = Gio.File.new_for_path(extension.path + '/data/icons');

        // Initialize audio mixer
        this._mixer = new Cvc.MixerControl({ name: 'Big Shot Audio' });
        this._mixer.open();

        this._mixerReadyId = this._mixer.connect('state-changed', () => {
            if (this._mixer.get_state() === Cvc.MixerControlState.READY)
                this._onMixerReady();
        });

        this._createButtons();
    }

    _createButtons() {
        // In Cinnamon, add audio buttons to the control container
        let container = this._ui.controlContainer;
        if (!container) container = this._ui.panel;
        if (!container) return;

        // Desktop audio button
        this._desktopButton = _createIconLabelButton(
            new Gio.FileIcon({ file: this._iconsDir.get_child('screenshot-ui-speaker-symbolic.svg') }),
            _('Desktop'),
            {
                style_class: 'big-shot-audio-button',
                toggle_mode: true,
                reactive: false,
            }
        );

        // Mic button
        this._micButton = _createIconLabelButton(
            new Gio.FileIcon({ file: this._iconsDir.get_child('screenshot-ui-mic-symbolic.svg') }),
            _('Mic'),
            {
                style_class: 'big-shot-audio-button',
                toggle_mode: true,
                reactive: false,
            }
        );

        container.add_child(this._desktopButton);
        container.add_child(this._micButton);

        // Notify toolbar when mic is toggled
        this._micButton.connect('clicked', () => {
            if (this._micToggledCallback) {
                this._micToggledCallback(this._micButton.checked);
            }
        });

        // Simple tooltips (no Screenshot.Tooltip in Cinnamon)
        this._desktopTooltip = new St.Label({
            text: _('Record Desktop Audio'),
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
            visible: false,
        });
        this._micTooltip = new St.Label({
            text: _('Record Microphone'),
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
            visible: false,
        });

        this._ui.actor.add_child(this._desktopTooltip);
        this._ui.actor.add_child(this._micTooltip);

        this._desktopButton.connect('enter-event', () => {
            this._showTooltip(this._desktopButton, this._desktopTooltip);
        });
        this._desktopButton.connect('leave-event', () => {
            this._desktopTooltip.visible = false;
        });
        this._micButton.connect('enter-event', () => {
            this._showTooltip(this._micButton, this._micTooltip);
        });
        this._micButton.connect('leave-event', () => {
            this._micTooltip.visible = false;
        });

        // Initially hidden
        this._desktopButton.visible = false;
        this._micButton.visible = false;
    }

    _showTooltip(button, tooltip) {
        tooltip.visible = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!tooltip.visible) return GLib.SOURCE_REMOVE;
            let pos = button.get_transformed_position();
            let bx = pos[0];
            let by = pos[1];
            let bw = button.width;
            let tw = tooltip.width;
            tooltip.set_position(bx + (bw - tw) / 2, by - tooltip.height - 4);
            return GLib.SOURCE_REMOVE;
        });
    }

    _disconnectMixer() {
        if (this._mixerReadyId) {
            if (this._mixer) this._mixer.disconnect(this._mixerReadyId);
            this._mixerReadyId = null;
        }
    }

    _onMixerReady() {
        this._disconnectMixer();
        this._updateDevices();
    }

    _updateDevices() {
        let defaultSink = this._mixer.get_default_sink();
        if (defaultSink) {
            this._desktopDevice = defaultSink.get_name() + '.monitor';
            let desc = defaultSink.get_description() || _('Desktop');
            if (this._desktopTooltip)
                this._desktopTooltip.text = _('Record Desktop Audio') + '\n' + desc;
        }

        let defaultSource = this._mixer.get_default_source();
        if (defaultSource) {
            this._micDevice = defaultSource.get_name();
            let desc = defaultSource.get_description() || _('Mic');
            if (this._micTooltip)
                this._micTooltip.text = _('Record Microphone') + '\n' + desc;
        }
    }

    set selectedMicId(id) {
        this._selectedMicId = id;
    }

    onMicToggled(callback) {
        this._micToggledCallback = callback;
    }

    enumerateMicrophones() {
        let sources = this._mixer.get_sources();
        let mics = [];
        for (let i = 0; i < sources.length; i++) {
            let src = sources[i];
            let name = src.get_name() || '';
            if (name.endsWith('.monitor'))
                continue;
            mics.push({
                id: src.get_id(),
                name: src.get_description() || name,
                pulseDevice: name,
            });
        }
        return mics;
    }

    _resolveMicDevice() {
        if (this._selectedMicId !== null) {
            let stream = this._mixer.lookup_stream_id(this._selectedMicId);
            if (stream)
                return stream.get_name();
        }
        return this._micDevice;
    }

    makeAudioInput() {
        this._updateDevices();

        let micDeviceName = this._resolveMicDevice();
        let desktopActive = this._desktopButton && this._desktopButton.checked && this._desktopDevice;
        let micActive = this._micButton && this._micButton.checked && micDeviceName;

        if (!desktopActive && !micActive) {
            return null;
        }

        // Desktop audio source
        let desktopSource = null;
        let desktopChannels = 2;
        if (desktopActive) {
            let sink = this._mixer.get_default_sink();
            if (sink) {
                let channelMap = sink.get_channel_map();
                if (channelMap)
                    desktopChannels = channelMap.get_num_channels();
            }
            desktopSource = [
                'pulsesrc device=' + this._desktopDevice + ' provide-clock=false',
                'capsfilter caps=audio/x-raw,channels=' + desktopChannels,
                'audioconvert',
                'queue',
            ].join(' ! ');
        }

        // Microphone source
        let micSource = null;
        if (micActive) {
            let micChannels = 2;
            if (this._selectedMicId !== null) {
                let stream = this._mixer.lookup_stream_id(this._selectedMicId);
                if (stream) {
                    let channelMap = stream.get_channel_map();
                    if (channelMap)
                        micChannels = channelMap.get_num_channels();
                }
            } else {
                let src = this._mixer.get_default_source();
                if (src) {
                    let channelMap = src.get_channel_map();
                    if (channelMap)
                        micChannels = channelMap.get_num_channels();
                }
            }
            micSource = [
                'pulsesrc device=' + micDeviceName + ' provide-clock=false',
                'capsfilter caps=audio/x-raw,channels=' + micChannels,
                'audioconvert',
                'queue',
            ].join(' ! ');
        }

        // Both active — mix them
        if (desktopSource && micSource) {
            return desktopSource + ' ! audiomixer name=am latency=100000000 ' +
                   micSource + ' ! am. ' +
                   'am. ! capsfilter caps=audio/x-raw,channels=' + desktopChannels + ' ! audioconvert ! queue';
        }

        return desktopSource || micSource;
    }

    _onModeChanged(isCast) {
        PartUI.prototype._onModeChanged.call(this, isCast);
        if (this._desktopButton) {
            this._desktopButton.visible = isCast;
            this._desktopButton.reactive = isCast;
        }
        if (this._micButton) {
            this._micButton.visible = isCast;
            this._micButton.reactive = isCast;
            if (!isCast && this._micToggledCallback)
                this._micToggledCallback(false);
        }
    }

    destroy() {
        if (this._desktopTooltip) {
            let p = this._desktopTooltip.get_parent();
            if (p) p.remove_child(this._desktopTooltip);
            this._desktopTooltip.destroy();
            this._desktopTooltip = null;
        }
        if (this._micTooltip) {
            let p = this._micTooltip.get_parent();
            if (p) p.remove_child(this._micTooltip);
            this._micTooltip.destroy();
            this._micTooltip = null;
        }
        if (this._desktopButton) {
            let parent = this._desktopButton.get_parent();
            if (parent) parent.remove_child(this._desktopButton);
            this._desktopButton.destroy();
            this._desktopButton = null;
        }
        if (this._micButton) {
            let parent = this._micButton.get_parent();
            if (parent) parent.remove_child(this._micButton);
            this._micButton.destroy();
            this._micButton = null;
        }
        this._disconnectMixer();
        if (this._mixer) {
            this._mixer.close();
            this._mixer = null;
        }
        PartUI.prototype.destroy.call(this);
    }
};

PartAudio.setGettext = function(fn) { _ = fn; };
