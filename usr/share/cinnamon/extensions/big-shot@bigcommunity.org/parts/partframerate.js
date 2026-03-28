/**
 * Big Shot — Framerate selector
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const PartBase = imports.parts.partbase;
const PartPopupSelect = PartBase.PartPopupSelect;

let _ = function(str) { return str; };

var PartFramerate = class PartFramerate extends PartPopupSelect {
    constructor(screenshotUI, extension) {
        super(
            screenshotUI,
            extension,
            [15, 24, 30, 60],
            30,
            function(v) { return v + ' FPS'; },
            _('Frames per second')
        );
    }
};

PartFramerate.setGettext = function(fn) { _ = fn; };
