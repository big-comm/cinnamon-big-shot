/**
 * Big Shot — Color palette and utilities (Cinnamon)
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

var PALETTE = [
    '#ed333b', // Red
    '#ff7800', // Orange
    '#f8e45c', // Yellow
    '#57e389', // Green
    '#62a0ea', // Blue
    '#9141ac', // Purple
    '#ffffff', // White
    '#000000', // Black
    '#c0bfbc', // Light Gray
    '#77767b', // Dark Gray
    '#e01b24', // Dark Red
    '#ff6600', // Dark Orange
];

/**
 * Convert a "#rrggbb" or "#rgb" string to [r, g, b, a] (0-1 range).
 * Returns null for anything else, so callers can fall back explicitly
 * instead of drawing with NaN components.
 */
var hexToRGBA = function(hex, alpha) {
    if (alpha === undefined) alpha = 1.0;
    if (typeof hex !== 'string')
        return null;
    let value = hex.trim();
    if (/^#[0-9a-fA-F]{3}$/.test(value))
        value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    if (!/^#[0-9a-fA-F]{6}$/.test(value))
        return null;
    const r = parseInt(value.slice(1, 3), 16) / 255;
    const g = parseInt(value.slice(3, 5), 16) / 255;
    const b = parseInt(value.slice(5, 7), 16) / 255;
    return [r, g, b, alpha];
};
