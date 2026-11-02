/**
 * Big Shot — Export compositor
 *
 * Renders the annotation list onto the captured screenshot exactly in the
 * order the user created it: a censor/blur/invert covers everything drawn
 * before it (image and annotations), and a zoom callout magnifies the
 * already-processed pixels below it. Everything happens in memory — no PNG
 * round-trips through /tmp.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const cairo = imports.gi.cairo;

const Actions = imports.drawing.actions;
const Pixels = imports.drawing.pixels;

function _isPixelEffect(action) {
    return typeof action.applyEffect === 'function' &&
        typeof action.getEffectRect === 'function';
}

/**
 * Apply a pixel effect to the part of the screenshot it covers, in place
 * on the canvas surface. Effects never touch the expanded margin.
 */
function _applyEffect(cr, surface, action, toCanvas, scale, image) {
    const box = action.getEffectRect(toCanvas);
    const rect = Pixels.clampRect(
        box[0] - image.x, box[1] - image.y,
        box[2] - image.x, box[3] - image.y,
        image.w, image.h, 2
    );
    if (!rect)
        return;

    const x = rect.x + image.x;
    const y = rect.y + image.y;
    const region = Pixels.surfaceToPixbuf(surface, x, y, rect.w, rect.h);
    const rowstride = region.get_rowstride();
    const data = Pixels.copyPixels(region);
    action.applyEffect(data, rect.w, rect.h, rowstride,
        region.get_n_channels(), scale);
    const result = Pixels.pixbufFromData(
        data, region.get_has_alpha(), rect.w, rect.h, rowstride);

    cr.save();
    cr.setOperator(Pixels.Operator.SOURCE);
    Pixels.setSourcePixbuf(cr, result, x, y);
    cr.rectangle(x, y, rect.w, rect.h);
    cr.fill();
    cr.restore();
}

/**
 * Draw a zoom callout whose magnified content is the current composite
 * (inside the screenshot) on top of earlier annotations (outside it).
 */
function _drawZoom(cr, surface, actions, index, toCanvas, scale, image) {
    const action = actions[index];
    const [sx0, sy0] = toCanvas(action.srcStart[0], action.srcStart[1]);
    const [sx1, sy1] = toCanvas(action.srcEnd[0], action.srcEnd[1]);
    const clip = Pixels.clampRect(
        Math.floor(sx0) - image.x, Math.floor(sy0) - image.y,
        Math.ceil(sx1) - image.x, Math.ceil(sy1) - image.y,
        image.w, image.h, 1
    );

    // Copy the processed pixels before the callout itself is drawn
    let snapshot = null;
    let snapX = 0;
    let snapY = 0;
    if (clip) {
        snapX = clip.x + image.x;
        snapY = clip.y + image.y;
        snapshot = new cairo.ImageSurface(cairo.Format.ARGB32, clip.w, clip.h);
        const snapCr = new cairo.Context(snapshot);
        try {
            snapCr.setSourceSurface(surface, -snapX, -snapY);
            snapCr.setOperator(Pixels.Operator.SOURCE);
            snapCr.paint();
        } finally {
            Pixels.disposeContext(snapCr);
        }
        snapshot.flush();
    }

    const underlay = c => {
        // Outside the screenshot the raw source is shown; repeat the
        // earlier annotations (effects via their previews) over it.
        for (let j = 0; j < index; j++) {
            const previous = actions[j];
            if (previous instanceof Actions.ZoomCalloutAction)
                continue;
            c.save();
            c.newPath();
            try {
                previous.draw(c, toCanvas, scale);
            } catch (e) {
                log('[Big Shot] Zoom underlay draw failed: ' + e.message);
            }
            c.restore();
        }
        if (snapshot) {
            c.save();
            c.rectangle(snapX, snapY, clip.w, clip.h);
            c.clip();
            c.setSourceSurface(snapshot, snapX, snapY);
            c.paint();
            c.restore();
        }
    };

    try {
        cr.save();
        cr.newPath();
        action.draw(cr, toCanvas, scale, underlay);
        cr.restore();
    } finally {
        if (snapshot)
            snapshot.finish();
    }
}

/**
 * Render `actions` onto `basePixbuf`.
 *
 * @param {GdkPixbuf.Pixbuf} basePixbuf - cropped screenshot
 * @param {Array} actions - annotation actions, in creation order
 * @param {object} opts
 * @param {number} opts.offsetX - logical x of the pixbuf's left edge
 * @param {number} opts.offsetY - logical y of the pixbuf's top edge
 * @param {number} opts.bufScale - pixbuf pixels per logical pixel
 * @param {object} [opts.expansion] - result of computeCanvasExpansion()
 * @returns {GdkPixbuf.Pixbuf}
 */
function renderAnnotations(basePixbuf, actions, opts) {
    const imgW = basePixbuf.get_width();
    const imgH = basePixbuf.get_height();
    const expansion = opts.expansion && opts.expansion.expanded
        ? opts.expansion
        : null;
    const padLeft = expansion ? expansion.padLeft : 0;
    const padTop = expansion ? expansion.padTop : 0;
    const canvasW = expansion ? expansion.newWidth : imgW;
    const canvasH = expansion ? expansion.newHeight : imgH;
    const scale = opts.bufScale || 1;
    const offsetX = opts.offsetX || 0;
    const offsetY = opts.offsetY || 0;
    const image = { x: padLeft, y: padTop, w: imgW, h: imgH };

    const toCanvas = (ax, ay) => [
        (ax - offsetX) * scale + padLeft,
        (ay - offsetY) * scale + padTop,
    ];

    const surface = new cairo.ImageSurface(cairo.Format.ARGB32, canvasW, canvasH);
    const cr = new cairo.Context(surface);
    try {
        if (expansion) {
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.paint();
        }
        cr.save();
        Pixels.setSourcePixbuf(cr, basePixbuf, padLeft, padTop);
        cr.rectangle(padLeft, padTop, imgW, imgH);
        cr.fill();
        cr.restore();

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            try {
                if (_isPixelEffect(action)) {
                    _applyEffect(cr, surface, action, toCanvas, scale, image);
                } else if (action instanceof Actions.ZoomCalloutAction) {
                    _drawZoom(cr, surface, actions, i, toCanvas, scale, image);
                } else {
                    cr.save();
                    cr.newPath();
                    action.draw(cr, toCanvas, scale);
                    cr.restore();
                }
            } catch (e) {
                log('[Big Shot] Annotation export failed: ' + e.message);
            }
        }

        return Pixels.surfaceToPixbuf(surface, 0, 0, canvasW, canvasH);
    } finally {
        Pixels.disposeContext(cr);
        surface.finish();
    }
}

/**
 * Add padding, gradient background and rounded corners around a pixbuf.
 * Returns the input untouched when there is nothing to apply.
 */
function applyPresentation(pixbuf, opts) {
    const padding = Math.max(0, opts.padding || 0);
    const radius = Math.max(0, opts.radius || 0);
    const gradient = opts.gradient || null;
    if (padding === 0 && !gradient && radius === 0)
        return pixbuf;

    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    const width = w + padding * 2;
    const height = h + padding * 2;
    const surface = new cairo.ImageSurface(cairo.Format.ARGB32, width, height);
    const cr = new cairo.Context(surface);
    try {
        cr.setOperator(Pixels.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Pixels.Operator.OVER);
        if (gradient && opts.gradientPainter)
            opts.gradientPainter(cr, gradient, 0, 0, width, height);

        cr.save();
        if (radius > 0) {
            const x = padding;
            const y = padding;
            const r = Math.min(radius, w / 2, h / 2);
            cr.newSubPath();
            cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
            cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
            cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
            cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
            cr.closePath();
            cr.clip();
        }
        Pixels.setSourcePixbuf(cr, pixbuf, padding, padding);
        cr.paint();
        cr.restore();

        return Pixels.surfaceToPixbuf(surface, 0, 0, width, height);
    } finally {
        Pixels.disposeContext(cr);
        surface.finish();
    }
}
