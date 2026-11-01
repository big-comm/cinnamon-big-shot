/**
 * Big Shot — Gradient presets for screenshot beautification
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Cairo = imports.gi.cairo;

/**
 * Each gradient has:
 *   id     — Stable preset identifier
 *   stops  — Array of [offset, r, g, b] in 0-1 range
 *   angle  — Degrees (0 = top-to-bottom, 90 = left-to-right)
 */
var GRADIENTS = [
    {
        id: 'red-flame',
        angle: 135,
        stops: [
            [0.0, 0.93, 0.11, 0.14],
            [1.0, 1.0, 0.47, 0.0],
        ],
    },
    {
        id: 'sunset-orange',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.47, 0.0],
            [1.0, 1.0, 0.68, 0.0],
        ],
    },
    {
        id: 'golden-hour',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.68, 0.0],
            [1.0, 0.97, 0.89, 0.36],
        ],
    },
    {
        id: 'mint-fresh',
        angle: 135,
        stops: [
            [0.0, 0.34, 0.89, 0.54],
            [1.0, 0.0, 0.78, 0.58],
        ],
    },
    {
        id: 'ocean-breeze',
        angle: 135,
        stops: [
            [0.0, 0.38, 0.63, 0.92],
            [1.0, 0.2, 0.4, 0.74],
        ],
    },
    {
        id: 'purple-dream',
        angle: 135,
        stops: [
            [0.0, 0.57, 0.25, 0.67],
            [1.0, 0.35, 0.15, 0.60],
        ],
    },
    {
        id: 'night-sky',
        angle: 135,
        stops: [
            [0.0, 0.12, 0.12, 0.30],
            [1.0, 0.22, 0.18, 0.42],
        ],
    },
    {
        id: 'coral-pink',
        angle: 135,
        stops: [
            [0.0, 1.0, 0.44, 0.47],
            [1.0, 1.0, 0.63, 0.55],
        ],
    },
    {
        id: 'none',
        angle: 0,
        stops: [],
    },
];

/**
 * Helper: paint a gradient onto a Cairo context within the given rect.
 *
 * @param {Cairo.Context} cr
 * @param {Object} gradient — one of the GRADIENTS entries
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
var paintGradient = function(cr, gradient, x, y, w, h) {
    if (!gradient.stops || gradient.stops.length === 0)
        return;

    const rad = gradient.angle * (Math.PI / 180);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const diag = Math.sqrt(w * w + h * h) / 2;

    const x0 = cx - diag * Math.sin(rad);
    const y0 = cy - diag * Math.cos(rad);
    const x1 = cx + diag * Math.sin(rad);
    const y1 = cy + diag * Math.cos(rad);

    const pat = new Cairo.LinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < gradient.stops.length; i++) {
        const stop = gradient.stops[i];
        pat.addColorStopRGBA(stop[0], stop[1], stop[2], stop[3], 1.0);
    }

    cr.setSource(pat);
    cr.rectangle(x, y, w, h);
    cr.fill();
};
