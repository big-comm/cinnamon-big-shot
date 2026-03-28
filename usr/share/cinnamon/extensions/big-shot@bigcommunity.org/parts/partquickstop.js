/**
 * Big Shot — Quick Stop for screencast
 *
 * Placeholder — actual open() interception is handled in extension.js.
 *
 * Cinnamon CJS version.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

var PartQuickStop = class PartQuickStop extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        // Quick-stop logic is handled in extension.js
    }
};
