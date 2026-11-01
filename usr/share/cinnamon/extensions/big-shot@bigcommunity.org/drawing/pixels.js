/**
 * Big Shot — Pixel helpers shared by the drawing actions and the exporter.
 *
 * Pure buffer operations (pixelate / blur / invert) work in place on a
 * region buffer described by (width, height, rowstride, nChannels), so the
 * exporter only touches the pixels an effect actually covers.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

try {
    imports.gi.versions.Gdk = '3.0';
} catch (e) {
    // Already pinned by Cinnamon's environment.
}

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const GLib = imports.gi.GLib;
const cairo = imports.gi.cairo;

var Operator = {
    CLEAR: 0,
    SOURCE: 1,
    OVER: 2,
    DIFFERENCE: (cairo.Operator && cairo.Operator.DIFFERENCE) || 23,
};

var Filter = {
    GOOD: 1,
    NEAREST: 3,
    BILINEAR: 4,
};

var MAX_BLUR_RADIUS = 256;

/** Release a Cairo context's native memory (GJS does not do it eagerly). */
function disposeContext(cr) {
    if (cr && typeof cr.$dispose === 'function')
        cr.$dispose();
}

/**
 * Clamp a [left, top, right, bottom] box to an image of maxW x maxH,
 * on both sides. Returns null when nothing (or < minSize) is left.
 */
function clampRect(left, top, right, bottom, maxW, maxH, minSize) {
    const min = minSize === undefined ? 1 : minSize;
    const x0 = Math.max(0, Math.min(maxW, Math.round(Math.min(left, right))));
    const y0 = Math.max(0, Math.min(maxH, Math.round(Math.min(top, bottom))));
    const x1 = Math.max(0, Math.min(maxW, Math.round(Math.max(left, right))));
    const y1 = Math.max(0, Math.min(maxH, Math.round(Math.max(top, bottom))));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < min || h < min)
        return null;
    return { x: x0, y: y0, w, h };
}

/** Copy a pixbuf's pixels into a fresh, mutable Uint8Array (native copy). */
function copyPixels(pixbuf) {
    const bytes = pixbuf.read_pixel_bytes();
    const data = bytes.get_data();
    return data instanceof Uint8Array ? new Uint8Array(data) : Uint8Array.from(data);
}

/** Wrap a buffer back into a GdkPixbuf with the given geometry. */
function pixbufFromData(data, hasAlpha, width, height, rowstride) {
    return GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(data),
        GdkPixbuf.Colorspace.RGB,
        hasAlpha,
        8,
        width,
        height,
        rowstride
    );
}

/** Paint a pixbuf into a new ARGB32 ImageSurface (no disk round-trip). */
function pixbufToSurface(pixbuf) {
    const surface = new cairo.ImageSurface(
        cairo.Format.ARGB32,
        pixbuf.get_width(),
        pixbuf.get_height()
    );
    const cr = new cairo.Context(surface);
    try {
        Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
        cr.paint();
    } finally {
        disposeContext(cr);
    }
    surface.flush();
    return surface;
}

/** Read back a rectangle of an ImageSurface as an RGBA pixbuf. */
function surfaceToPixbuf(surface, x, y, width, height) {
    surface.flush();
    return Gdk.pixbuf_get_from_surface(surface, x, y, width, height);
}

/** Set a pixbuf as the source of `cr` at (x, y). */
function setSourcePixbuf(cr, pixbuf, x, y) {
    Gdk.cairo_set_source_pixbuf(cr, pixbuf, x, y);
}

/**
 * Average colour of every block of a region. Blocks are aligned to the
 * region origin; the last row/column may be partial.
 * Returns { cols, rows, rgb } with 3 bytes per block.
 */
function averageBlocks(data, x, y, w, h, rowstride, nChannels, blockSize) {
    const cols = Math.ceil(w / blockSize);
    const rows = Math.ceil(h / blockSize);
    const rgb = new Uint8Array(cols * rows * 3);
    for (let by = 0; by < rows; by++) {
        const py0 = y + by * blockSize;
        const py1 = Math.min(py0 + blockSize, y + h);
        for (let bx = 0; bx < cols; bx++) {
            const px0 = x + bx * blockSize;
            const px1 = Math.min(px0 + blockSize, x + w);
            let r = 0, g = 0, b = 0, count = 0;
            for (let py = py0; py < py1; py++) {
                let off = py * rowstride + px0 * nChannels;
                for (let px = px0; px < px1; px++) {
                    r += data[off];
                    g += data[off + 1];
                    b += data[off + 2];
                    off += nChannels;
                    count++;
                }
            }
            const o = (by * cols + bx) * 3;
            if (count > 0) {
                rgb[o] = (r / count) | 0;
                rgb[o + 1] = (g / count) | 0;
                rgb[o + 2] = (b / count) | 0;
            }
        }
    }
    return { cols, rows, rgb };
}

/** Pixelate a whole region buffer in place (blocks aligned to 0,0). */
function pixelateBuffer(data, w, h, rowstride, nChannels, blockSize) {
    const bs = Math.max(1, blockSize | 0);
    for (let by0 = 0; by0 < h; by0 += bs) {
        const by1 = Math.min(by0 + bs, h);
        for (let bx0 = 0; bx0 < w; bx0 += bs) {
            const bx1 = Math.min(bx0 + bs, w);
            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let py = by0; py < by1; py++) {
                let off = py * rowstride + bx0 * nChannels;
                for (let px = bx0; px < bx1; px++) {
                    r += data[off];
                    g += data[off + 1];
                    b += data[off + 2];
                    if (nChannels === 4) a += data[off + 3];
                    off += nChannels;
                    count++;
                }
            }
            if (count === 0) continue;
            r = (r / count) | 0;
            g = (g / count) | 0;
            b = (b / count) | 0;
            a = nChannels === 4 ? (a / count) | 0 : 255;
            for (let py = by0; py < by1; py++) {
                let off = py * rowstride + bx0 * nChannels;
                for (let px = bx0; px < bx1; px++) {
                    data[off] = r;
                    data[off + 1] = g;
                    data[off + 2] = b;
                    if (nChannels === 4) data[off + 3] = a;
                    off += nChannels;
                }
            }
        }
    }
}

/** Invert RGB of a whole region buffer in place (alpha untouched). */
function invertBuffer(data, w, h, rowstride, nChannels) {
    for (let py = 0; py < h; py++) {
        let off = py * rowstride;
        for (let px = 0; px < w; px++) {
            data[off] = 255 - data[off];
            data[off + 1] = 255 - data[off + 1];
            data[off + 2] = 255 - data[off + 2];
            off += nChannels;
        }
    }
}

/**
 * One box-blur pass along a line using a running sum (O(n), independent
 * of the radius). Edges are clamped, window is always 2r+1 samples.
 */
function _blurLine(src, dst, start, step, count, radius) {
    const win = radius * 2 + 1;
    const last = count - 1;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
        const i = k < 0 ? 0 : (k > last ? last : k);
        sum += src[start + i * step];
    }
    for (let i = 0; i < count; i++) {
        dst[start + i * step] = (sum / win) | 0;
        let add = i + radius + 1;
        let sub = i - radius;
        if (add > last) add = last;
        if (sub < 0) sub = 0;
        sum += src[start + add * step] - src[start + sub * step];
    }
}

/**
 * Approximate Gaussian blur: `passes` x (horizontal + vertical) box blur
 * on a region buffer, in place. Cost is O(pixels * passes).
 */
function boxBlurBuffer(data, w, h, rowstride, nChannels, radius, passes) {
    const r = Math.max(1, Math.min(MAX_BLUR_RADIUS, radius | 0));
    const n = passes || 3;
    const tmp = new Uint8Array(data.length);
    for (let pass = 0; pass < n; pass++) {
        for (let y = 0; y < h; y++) {
            for (let c = 0; c < nChannels; c++)
                _blurLine(data, tmp, y * rowstride + c, nChannels, w, r);
        }
        for (let x = 0; x < w; x++) {
            for (let c = 0; c < nChannels; c++)
                _blurLine(tmp, data, x * nChannels + c, rowstride, h, r);
        }
    }
}
