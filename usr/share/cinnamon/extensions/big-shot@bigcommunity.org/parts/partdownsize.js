/**
 * Big Shot — Resolution downsize selector
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const PartBase = imports.parts.partbase;
const PartPopupSelect = PartBase.PartPopupSelect;

let _ = function(str) { return str; };

var PartDownsize = class PartDownsize extends PartPopupSelect {
    constructor(screenshotUI, extension) {
        super(
            screenshotUI,
            extension,
            [1.00, 0.75, 0.50, 0.33],
            1.00,
            function(v) { return Math.round(v * 100) + '%'; },
            _('Recording resolution')
        );
    }
};

PartDownsize.setGettext = function(fn) { _ = fn; };
