// Check if a node still exists in the document
function nodeExists(node) {
    try { var _ = node.id; return true; } catch (e) { return false; }
}

// Check if a node directly contains a Union/Boolean/Vector child
// Such parents must stay FIXED width — never FILL
function hasUnionChild(node) {
    if (!node.children) return false;
    for (var i = 0; i < node.children.length; i++) {
        var t = node.children[i].type;
        if (t === "BOOLEAN_OPERATION" || t === "VECTOR") return true;
    }
    return false;
}

// code.js — Banner Resizer Plugin
// Helper: extract size (w,h) from a variant node.
// Uses actual node dimensions as primary source.
// Also tries to parse from name: exact "1080x1920", or embedded "_1080x1920px_"
function extractVariantSize(v) {
    var vW = Math.round(v.width);
    var vH = Math.round(v.height);
    var sm = v.name.match(/^(\d+)\s*[x\u00D7]\s*(\d+)$/i) ||
        v.name.match(/_(\d+)\s*[x\u00D7]\s*(\d+)(?:px)?[_\s.]/i);
    if (sm) { vW = parseInt(sm[1], 10); vH = parseInt(sm[2], 10); }
    return { w: vW, h: vH };
}


console.log("=== BANNER RESIZER v4 LOADED ===");
var _stopRequested = false;
var _pauseRequested = false;
// Holds the state needed to resume a paused batch: { sel, sizes, startIndex, maxPerRow,
// retailerBreak, batchRow1Y, prevCol1, retailerRowFloorY, done, errors }. Null when no
// batch is paused.
var _pausedBatch = null;
// Holds the state needed to resume a paused export: { tasks, format, scale, startIndex,
// done, total }. Null when no export is paused.
var _pausedExport = null;
// Tracks the most recently batch-processed template package so a NEW template
// (a different template selected from the dropdown, OR a different physical master
// frame) can be chained immediately to the right of the previous package.
// IMPORTANT: templates are variant swaps inside the SAME frame (see SELECT_TEMPLATE) —
// the frame's id never changes between templates, so identity must include the
// currently selected variant name, not just the frame id.
// Reset naturally each time the plugin is reopened.
var _lastPackageKey = null;      // "<frameId>::<variantName>" for the last package
var _lastPackageRightX = null;   // rightmost edge (x + width) reached by the last package
var _lastPackageBaselineY = null; // the row1 Y used for the last package, so new packages align to it

figma.showUI(__html__, { width: 340, height: 480, title: "Banner Resizer" });

// ─── Persistent storage bridge ─────────────────────────────────────────────
// figma.clientStorage lives here in the plugin sandbox and persists reliably
// per-user-per-plugin, unaffected by whatever restricts localStorage in the
// UI iframe on some setups. ui.html can't call this directly, so we read it
// on startup and hand the values over via postMessage, then save back
// whatever ui.html tells us to.
Promise.all([
    figma.clientStorage.getAsync("mr-device-id"),
    figma.clientStorage.getAsync("mr-license-key")
]).then(function (values) {
    figma.ui.postMessage({
        type: "STORAGE_INIT",
        deviceId: values[0] || null,
        licenseKey: values[1] || null
    });
});

// ─── License gate ──────────────────────────────────────────────────────────
// The actual network call happens in ui.html (the sandbox here can't call
// fetch). This flag just reflects what the UI reported, and gates the
// value-producing actions below. See LICENSED_ACTIONS.
var licenseValid = false;

// Only these actions require a valid license. Read-only/info messages
// (GET_TEMPLATES, GET_MASTER_INFO, SELECT_TEMPLATE, etc.) stay open so
// people can preview the plugin before unlocking it.
var LICENSED_ACTIONS = ["RESIZE_BANNER", "BATCH_RESIZE", "CONTINUE_BATCH", "TRANSLATE_BANNERS", "EXPORT_BANNERS", "CONTINUE_EXPORT"];

function requiresLicense(type) {
    return LICENSED_ACTIONS.indexOf(type) !== -1;
}

// ─── Get selected frame ───────────────────────────────────────────────────────

function getSelectedFrame() {
    var sel = figma.currentPage.selection;
    if (!sel || sel.length === 0) return { node: null, error: "No frame selected." };
    if (sel.length > 1) return { node: null, error: "Select only one frame." };
    var node = sel[0];
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "INSTANCE")
        return { node: null, error: '"' + node.name + '" is not a frame.' };
    return { node: node, error: null };
}

// Store the user-selected variant name from the template dropdown
var selectedVariantName = null;

// ─── Swap best variant ────────────────────────────────────────────────────────

async function swapBestVariant(clone, newW, newH, ryLtRx) {
    // Include clone itself if it's an instance, plus all instance descendants
    var instances = clone.type === "INSTANCE" ? [clone] : [];
    var innerInstances = clone.findAll ? clone.findAll(function (n) { return n.type === "INSTANCE"; }) : [];
    instances = instances.concat(innerInstances);
    console.log("swapBestVariant: target=" + newW + "x" + newH + " instances=" + instances.length + " cloneType=" + clone.type);
    for (var i = 0; i < instances.length; i++) {
        try {
            var mc = await instances[i].getMainComponentAsync();
            console.log("  instance[" + i + "]: " + instances[i].name + " mc=" + (mc ? mc.name : "null") + " mcParentType=" + (mc && mc.parent ? mc.parent.type : "null"));
            if (mc && mc.parent && mc.parent.type === "COMPONENT_SET") {
                var cs = mc.parent;
                var firstClean = cs.children[0].name.indexOf('=') !== -1 ? cs.children[0].name.split('=').pop().trim() : cs.children[0].name;
                // Detect size CS:
                // 1. Name is purely a size e.g. "1080x1920"
                // 2. Name contains a size anywhere e.g. "EMEA_..._566x250px_..."
                // 3. Children have different dimensions from each other
                var isSizeCS = /^\d+\s*[x\u00D7]\s*\d+$/i.test(firstClean);
                if (!isSizeCS) {
                    var hasSizeInAnyName = false;
                    var firstW = Math.round(cs.children[0].width);
                    var firstH = Math.round(cs.children[0].height);
                    var hasDiffDims = false;
                    for (var si = 0; si < cs.children.length; si++) {
                        if (/\d+\s*[x\u00D7]\s*\d+/i.test(cs.children[si].name)) hasSizeInAnyName = true;
                        if (Math.round(cs.children[si].width) !== firstW || Math.round(cs.children[si].height) !== firstH) hasDiffDims = true;
                    }
                    isSizeCS = hasDiffDims || hasSizeInAnyName;
                }
                console.log("  CS: " + cs.name + " firstClean=" + firstClean + " isSizeCS=" + isSizeCS + " children=" + cs.children.length);

                if (!isSizeCS && selectedVariantName) {
                    // Outer campaign CS — swap to selected campaign
                    for (var j = 0; j < cs.children.length; j++) {
                        var vn = cs.children[j].name;
                        var vc = vn.indexOf('=') !== -1 ? vn.split('=').pop().trim() : vn;
                        if (vn === selectedVariantName || vc === selectedVariantName) {
                            instances[i].swapComponent(cs.children[j]);
                            console.log("Swap campaign: " + vc);
                            break;
                        }
                    }
                    // Continue to find inner size CS
                    continue;
                }

                if (isSizeCS) {
                    var targetRatio = newW / newH;
                    var targetIsPortrait = newH > newW;

                    // Prefer square (1080x1080) only when ry<rx for portrait targets
                    // Prefer square when target is square OR nearly square (ratio within 15% of 1:1)
                    var targetRatioVal = newW / newH;
                    var isNearlySquare = targetRatioVal > 0.85 && targetRatioVal < 1.15;
                    var preferSquare = ryLtRx || (newW === newH) || isNearlySquare;

                    var best = null; var bestDiff = Infinity;
                    var bestOrientation = null; var bestOrientationDiff = Infinity;
                    var squareVariant = null;
                    var globalBest = null; var globalBestDiff = Infinity;

                    for (var j = 0; j < cs.children.length; j++) {
                        var v = cs.children[j];
                        var sz2 = extractVariantSize(v);
                        var vW = sz2.w; var vH = sz2.h;
                        var vRatio = vW / vH;
                        var diff = Math.abs(vRatio - targetRatio);
                        // isSquare calculated AFTER parsing so float precision doesn't affect it
                        var isSquare = (vW === vH);
                        var isPortraitVariant = vH > vW;
                        console.log("  variant: " + v.name + " parsed=" + vW + "x" + vH + " isSquare=" + isSquare + " isPortrait=" + isPortraitVariant + " diff=" + diff.toFixed(3));

                        // Track the closest-fitting variant overall, regardless of orientation/square —
                        // this is our fallback so we never pick a wildly-mismatched aspect ratio just
                        // because it happens to share the target's orientation
                        if (diff < globalBestDiff) { globalBestDiff = diff; globalBest = v; }

                        // Detect square variant
                        if (isSquare) squareVariant = v;

                        // Orientation match:
                        // Portrait target → variant must be taller than wide (strict portrait, not square)
                        // Landscape target → variant must be wider than tall (strict landscape, not square)
                        // Square is only chosen via preferSquare, never via orientation match
                        // For nearly-square targets, don't match landscape/portrait orientation
                        // — only square template makes sense
                        var sameOrientation = !isNearlySquare && (
                            (targetIsPortrait && vH > vW && !isSquare) ||
                            (!targetIsPortrait && newW !== newH && vW > vH && !isSquare)
                        );
                        if (sameOrientation && diff < bestOrientationDiff) {
                            bestOrientationDiff = diff; bestOrientation = v;
                        }
                        // best = closest ratio, exclude square unless target is square or nearly square
                        var targetIsSquare = (newW === newH);
                        if (!isSquare || targetIsSquare || isNearlySquare) {
                            if (diff < bestDiff) { bestDiff = diff; best = v; }
                        }
                    }

                    // For nearly-square: always prefer square if available
                    // Otherwise: only trust an orientation match if it's not a drastically worse
                    // aspect-ratio fit than the closest variant overall (square included). A same-
                    // orientation variant whose ratio is way off (e.g. a 7.9:1 banner for a 1.3:1
                    // target) should lose to a square/other variant that actually fits the shape.
                    var ORIENTATION_TOLERANCE = 1.6;
                    var chosen;
                    if (isNearlySquare && squareVariant) {
                        chosen = squareVariant;
                    } else if (bestOrientation && bestOrientationDiff <= globalBestDiff * ORIENTATION_TOLERANCE) {
                        chosen = bestOrientation;
                    } else if (preferSquare && squareVariant) {
                        chosen = squareVariant;
                    } else {
                        chosen = globalBest || best;
                    }
                    console.log("Swap decision: target=" + newW + "x" + newH + " portrait=" + targetIsPortrait + " preferSquare=" + preferSquare + " bestOrientation=" + (bestOrientation ? bestOrientation.name : "null") + " best=" + (best ? best.name : "null") + " chosen=" + (chosen ? chosen.name : "null"));
                    if (chosen) {
                        instances[i].swapComponent(chosen);
                        console.log(
                            "After swap:",
                            instances[i].width,
                            instances[i].height
                        );
                        var chosenSz = extractVariantSize(chosen);
                        return { w: chosenSz.w, h: chosenSz.h, name: chosen.name };
                    }
                    break;
                }

                if (!isSizeCS && !selectedVariantName) {
                    // No dropdown selection, campaign CS — just continue to find size CS
                    continue;
                }

                break;
            }
        } catch (e) { console.error("swapBestVariant:", e); }
    }
}

// ─── Detach all instances ─────────────────────────────────────────────────────

function detachAllInstances(node) {
    if (!node.children) return;
    for (var i = node.children.length - 1; i >= 0; i--) {
        var child = node.children[i];
        if (child.type === "INSTANCE") {
            var detached = child.detachInstance();
            if (detached) detachAllInstances(detached);
        } else {
            detachAllInstances(child);
        }
    }
}

// ─── PHASE 1: Read all data from the clone into a data map ───────────────────

function readAllData(node, map) {
    var entry = {
        id: node.id,
        name: node.name,
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        layoutPositioning: node.layoutPositioning || null,
        constraints: node.constraints ? { h: node.constraints.horizontal, v: node.constraints.vertical } : { h: "MIN", v: "MIN" },
        layoutMode: node.layoutMode || "NONE",
        layoutSizingH: node.layoutSizingHorizontal || null,
        layoutSizingV: node.layoutSizingVertical || null,
        constrainProportions: (function () { try { return node.targetAspectRatio !== null && node.targetAspectRatio !== undefined; } catch (_) { return false; } })(),
        paddingTop: typeof node.paddingTop === "number" ? node.paddingTop : null,
        paddingBottom: typeof node.paddingBottom === "number" ? node.paddingBottom : null,
        paddingLeft: typeof node.paddingLeft === "number" ? node.paddingLeft : null,
        paddingRight: typeof node.paddingRight === "number" ? node.paddingRight : null,
        itemSpacing: typeof node.itemSpacing === "number" ? node.itemSpacing : null,
        counterAxisSpacing: typeof node.counterAxisSpacing === "number" ? node.counterAxisSpacing : null,
        cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : null,
        topLeftRadius: typeof node.topLeftRadius === "number" ? node.topLeftRadius : null,
        topRightRadius: typeof node.topRightRadius === "number" ? node.topRightRadius : null,
        bottomLeftRadius: typeof node.bottomLeftRadius === "number" ? node.bottomLeftRadius : null,
        bottomRightRadius: typeof node.bottomRightRadius === "number" ? node.bottomRightRadius : null,
        strokeWeight: typeof node.strokeWeight === "number" ? node.strokeWeight : null,
        fontSize: null, lineHeight: null, letterSpacing: null,
    };

    if (node.type === "TEXT") {
        entry.fontSize = node.fontSize !== figma.mixed ? node.fontSize : null;
        entry.lineHeight = (node.lineHeight !== figma.mixed && node.lineHeight.unit === "PIXELS") ? node.lineHeight.value : null;
        entry.letterSpacing = (node.letterSpacing !== figma.mixed && node.letterSpacing.unit === "PIXELS") ? node.letterSpacing.value : null;
    }

    map[node.id] = entry;

    // Don't recurse into Union/Boolean children — Figma manages them internally
    if (node.type === "BOOLEAN_OPERATION" || node.type === "VECTOR" || node.type === "STAR" || node.type === "POLYGON") {
        return;
    }

    if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
            readAllData(node.children[i], map);
        }
    }
}

// ─── PHASE 2: Calculate new values based on ratio ────────────────────────────

function calcNewValues(map, rx, ry, ratio) {
    var newMap = {};
    var textRatio = ratio;
    for (var id in map) {
        var d = map[id];
        var n = {};
        // Use rx/ry for element sizes to match frame scaling — fills frame without gaps
        n.width = d.type !== "GROUP" && d.type !== "TEXT" ? Math.round(d.width * rx) : d.width;
        n.height = d.type !== "GROUP" && d.type !== "TEXT" ? Math.round(d.height * ry) : d.height;
        // Spacing
        n.paddingTop = d.paddingTop !== null ? Math.round(d.paddingTop * ratio) : null;
        n.paddingBottom = d.paddingBottom !== null ? Math.round(d.paddingBottom * ratio) : null;
        n.paddingLeft = d.paddingLeft !== null ? Math.round(d.paddingLeft * ratio) : null;
        n.paddingRight = d.paddingRight !== null ? Math.round(d.paddingRight * ratio) : null;
        n.itemSpacing = d.itemSpacing !== null ? Math.round(d.itemSpacing * ratio) : null;
        n.counterAxisSpacing = d.counterAxisSpacing !== null ? Math.round(d.counterAxisSpacing * ratio) : null;
        // Radius
        n.cornerRadius = d.cornerRadius !== null ? Math.round(d.cornerRadius * ratio) : null;
        n.topLeftRadius = d.topLeftRadius !== null ? Math.round(d.topLeftRadius * ratio) : null;
        n.topRightRadius = d.topRightRadius !== null ? Math.round(d.topRightRadius * ratio) : null;
        n.bottomLeftRadius = d.bottomLeftRadius !== null ? Math.round(d.bottomLeftRadius * ratio) : null;
        n.bottomRightRadius = d.bottomRightRadius !== null ? Math.round(d.bottomRightRadius * ratio) : null;
        // Stroke
        n.strokeWeight = d.strokeWeight !== null ? Math.max(0.01, d.strokeWeight * ratio) : null;
        // Text
        n.fontSize = d.fontSize !== null
            ? Math.max(10, Math.round(d.fontSize * textRatio))
            : null;

        n.lineHeight = d.lineHeight !== null
            ? Math.max(14, Math.round(d.lineHeight * textRatio))
            : null;

        n.letterSpacing = d.letterSpacing !== null
            ? Math.round(d.letterSpacing * textRatio)
            : null;
        newMap[id] = n;
    }
    return newMap;
}

// ─── PHASE 3: Apply new values to the clone ──────────────────────────────────

async function applyAllData(node, oldMap, newMap, rx, ry, oldParentW, oldParentH, rootTargetW, rootTargetH) {
    if (!node.children) return;

    // Actual new parent dimensions
    var newParentW = oldParentW * rx;
    var newParentH = oldParentH * ry;
    // Geometric mean ratio for uniform elements (logos, boolean ops)
    var ratio = Math.sqrt(rx * ry);

    for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        var old = oldMap[child.id];
        var nw = newMap[child.id];
        if (!old || !nw) {
            await applyAllData(child, oldMap, newMap, rx, ry, oldParentW, oldParentH, rootTargetW, rootTargetH);
            continue;
        }

        var parentIsAutoLayout = node.layoutMode !== undefined && node.layoutMode !== "NONE";
        var childIsAbsolute = old.layoutPositioning === "ABSOLUTE";

        // Force resize nodes with image fills OR full-size frames (same as banner) to match new banner size
        var hasImageFill = false;
        if (child.fills && child.fills !== figma.mixed) {
            for (var fi = 0; fi < child.fills.length; fi++) {
                if (child.fills[fi].type === "IMAGE") { hasImageFill = true; break; }
            }
        }
        var isFullSizeFrame = (Math.round(old.width) === Math.round(oldParentW) && Math.round(old.height) === Math.round(oldParentH));
        if ((hasImageFill || isFullSizeFrame) && child.type !== "GROUP" && child.type !== "TEXT" && child.type !== "BOOLEAN_OPERATION" && child.type !== "VECTOR") {
            try { child.unlockAspectRatio(); } catch (_) { }
            if (hasImageFill && child.name.toLowerCase() === "bg") {
                try {
                    var bgW = (rootTargetW && rootTargetW > 0) ? Math.round(rootTargetW) : Math.round(newParentW);
                    var bgH = (rootTargetH && rootTargetH > 0) ? Math.round(rootTargetH) : Math.round(newParentH);
                    var origRatio = old.width / old.height;
                    var bannerRatio = bgW / bgH;
                    var newImgW, newImgH;
                    if (origRatio > bannerRatio) {
                        newImgH = bgH;
                        newImgW = Math.round(newImgH * origRatio);
                    } else {
                        newImgW = bgW;
                        newImgH = Math.round(newImgW / origRatio);
                    }

                    // Snapshot imageTransform BEFORE any resize mutates it
                    var bgFillsSnap = (child.fills && child.fills !== figma.mixed)
                        ? JSON.parse(JSON.stringify(child.fills))
                        : null;


                    if (bgFillsSnap && child.fills && child.fills !== figma.mixed) {
                        var moveWidth = (newImgW - bgW) / newImgW;
                        var moveHeight = (newImgH - bgH) / newImgH;

                        // Calculate new tx/ty and build FILL fills list
                        var bgTransforms = [];
                        var fillFills = [];
                        for (var fi2 = 0; fi2 < bgFillsSnap.length; fi2++) {
                            var sf = bgFillsSnap[fi2];
                            if (sf.type !== "IMAGE" || !sf.imageTransform) {
                                fillFills.push(sf);
                                bgTransforms.push(null);
                                continue;
                            }
                            var t = sf.imageTransform;
                            var origTx = t[0][2];
                            var origTy = t[1][2];
                            var origA = t[0][0];
                            var origD = t[1][1];

                            // Formula: keep same display scale (pixels per image-pixel) on new layer.
                            // origA was calibrated for newImgW (cover-fit size e.g. 2200).
                            // New layer is bgW (canvas size e.g. 1200).
                            // a_new = origA \u00D7 (bgW / newImgW) → 0.984 \u00D7 (1200/2200) = 0.537
                            // d_new = origD \u00D7 (bgH / newImgH) → 0.455 \u00D7 (1000/1000) = 0.455
                            // Both axes covered (< 1), same display scale, no distortion.
                            var newA = origA * (bgW / newImgW);
                            var newD = origD * (bgH / newImgH);

                            var newTx = origTx;
                            var newTy = origTy;
                            if (moveWidth !== 0) newTx = origTx + moveWidth / 2;
                            if (moveHeight !== 0) newTy = origTy + moveHeight / 2;

                            bgTransforms.push({ newA: newA, newD: newD, newTx: newTx, newTy: newTy, t: t });
                            console.log("[bg] a=" + origA.toFixed(4) + "→" + newA.toFixed(4) + " d=" + origD.toFixed(4) + "→" + newD.toFixed(4) + " tx=" + origTx.toFixed(4) + "→" + newTx.toFixed(4) + " ty=" + origTy.toFixed(4) + "→" + newTy.toFixed(4));

                            // Step 1: resize to canvas size, set to FILL to reset Figma state
                            child.resize(bgW, bgH);
                            child.x = 0;
                            child.y = 0;

                            var fillVersion = Object.assign({}, sf);
                            fillVersion.scaleMode = "FILL";
                            delete fillVersion.imageTransform;
                            fillFills.push(fillVersion);
                        }

                        // Step 2: apply FILL to reset Figma internal state
                        child.fills = fillFills;

                        // Step 3: wait 400ms for Figma to settle
                        await new Promise(function (resolve) { setTimeout(resolve, 400); });

                        // Step 4: apply CROP + imageTransform BEFORE any further resize
                        // Any resize after this will recalculate fills internally and wipe our values
                        var cropFills = child.fills.slice();
                        for (var fi2 = 0; fi2 < bgTransforms.length; fi2++) {
                            if (!bgTransforms[fi2]) continue;
                            var tr = bgTransforms[fi2];
                            var cropFill = Object.assign({}, cropFills[fi2]);
                            cropFill.scaleMode = "CROP";
                            cropFill.imageTransform = [
                                [tr.newA, tr.t[0][1], tr.newTx],
                                [tr.t[1][0], tr.newD, tr.newTy]
                            ];
                            cropFills[fi2] = cropFill;
                        }
                        child.fills = cropFills;

                        // bg stays at exact canvas size — imageTransform handles crop/position
                        console.log("[bg] FILL→CROP done: canvas=" + bgW + "x" + bgH + " x=0 y=0");
                    }
                } catch (e) { console.error("[bg] resize/transform failed:", e); }
            } else {
                try { child.resize(Math.round(newParentW), Math.round(newParentH)); child.x = 0; child.y = 0; } catch (e) { }
            }
        } else if (!parentIsAutoLayout || childIsAbsolute) {
            // Apply size — always unlock aspect ratio first so resize() works freely
            if (child.type !== "GROUP" && child.type !== "TEXT") {
                try {
                    // Step 1: Always unlock first
                    try { child.unlockAspectRatio(); } catch (_) { }

                    // Step 2: Resize — use uniform ratio for locked-ratio nodes and Boolean Operations
                    var needsUniform = old.constrainProportions || child.type === "BOOLEAN_OPERATION";

                    if (needsUniform) {
                        child.resize(
                            Math.round(old.width * ratio),
                            Math.round(old.height * ratio)
                        );
                    } else {
                        child.resize(nw.width, nw.height);
                    }
                } catch (e) { console.error("resize [" + child.name + "]:", e); }
            }

            // Apply X position — map proportionally to actual new frame width
            var h = old.constraints.h;
            var v = old.constraints.v;

            var TOL = 1.5;
            var isPinnedLeft = old.x <= TOL;
            var isPinnedRight = (old.x + old.width) >= (oldParentW - TOL);
            var isPinnedTop = old.y <= TOL;
            var isPinnedBottom = (old.y + old.height) >= (oldParentH - TOL);
            var isFullWidth = isPinnedLeft && isPinnedRight && Math.abs(old.width - oldParentW) <= TOL;
            var isFullHeight = isPinnedTop && isPinnedBottom && Math.abs(old.height - oldParentH) <= TOL;

            // X position
            if (isFullWidth) {
                try { child.x = 0; } catch (e) { }
            } else if (h === "MIN" || h === "SCALE") {
                try { child.x = Math.round(old.x / oldParentW * newParentW); } catch (e) { }
            } else if (h === "MAX") {
                var dfr = oldParentW - old.x - old.width;
                try { child.x = Math.round(newParentW - dfr / oldParentW * newParentW - child.width); } catch (e) { }
            } else if (h === "CENTER") {
                var oldCenterX = old.x + old.width / 2;
                try { child.x = Math.round(oldCenterX / oldParentW * newParentW - child.width / 2); } catch (e) { }
            }

            // Y position
            if (isFullHeight) {
                try { child.y = 0; } catch (e) { }
            } else if (isPinnedBottom && !isPinnedTop) {
                try { child.y = Math.round(newParentH) - Math.round(child.height); } catch (e) { }
            } else if (isPinnedTop) {
                try { child.y = 0; } catch (e) { }
            } else if (v === "MIN" || v === "SCALE") {
                try { child.y = Math.round(old.y / oldParentH * newParentH); } catch (e) { }
            } else if (v === "MAX") {
                var dfb = oldParentH - old.y - old.height;
                try { child.y = Math.round(newParentH - dfb / oldParentH * newParentH - child.height); } catch (e) { }
            } else if (v === "CENTER") {
                var oldCenterY = old.y + old.height / 2;
                try { child.y = Math.round(oldCenterY / oldParentH * newParentH - child.height / 2); } catch (e) { }
            }

            console.log("[" + child.name + "] x=" + child.x + " y=" + child.y + " w=" + child.width + " h=" + child.height);
        } else if (parentIsAutoLayout && !childIsAbsolute &&
            (old.layoutSizingH === "FIXED" || old.layoutSizingV === "FIXED")) {
            // FIXED-sized child inside Auto Layout — resize it explicitly
            // (HUG and FILL are handled by restoring layoutSizing later)
            if (child.type !== "GROUP" && child.type !== "TEXT") {
                try {
                    try { child.unlockAspectRatio(); } catch (_) { }
                    var needsUniform2 = old.constrainProportions || child.type === "BOOLEAN_OPERATION";

                    if (needsUniform2) {
                        child.resize(
                            Math.round(old.width * ratio),
                            Math.round(old.height * ratio)
                        );
                    } else {
                        child.resize(nw.width, nw.height);
                    }
                } catch (e) { console.error("resize AL FIXED [" + child.name + "]:", e); }
            }
        }
        try {
            if (old.layoutMode !== "NONE") {
                if (nw.paddingTop !== null) child.paddingTop = nw.paddingTop;
                if (nw.paddingBottom !== null) child.paddingBottom = nw.paddingBottom;
                if (nw.paddingLeft !== null) child.paddingLeft = nw.paddingLeft;
                if (nw.paddingRight !== null) child.paddingRight = nw.paddingRight;
                if (nw.itemSpacing !== null) child.itemSpacing = nw.itemSpacing;
                if (nw.counterAxisSpacing !== null) child.counterAxisSpacing = nw.counterAxisSpacing;
            }
            if (nw.cornerRadius !== null) {
                child.cornerRadius = nw.cornerRadius;
            } else {
                if (nw.topLeftRadius !== null) child.topLeftRadius = nw.topLeftRadius;
                if (nw.topRightRadius !== null) child.topRightRadius = nw.topRightRadius;
                if (nw.bottomLeftRadius !== null) child.bottomLeftRadius = nw.bottomLeftRadius;
                if (nw.bottomRightRadius !== null) child.bottomRightRadius = nw.bottomRightRadius;
            }
            if (nw.strokeWeight !== null) child.strokeWeight = nw.strokeWeight;
        } catch (e) { }

        // Apply text properties
        if (child.type === "TEXT" && (nw.fontSize !== null || nw.lineHeight !== null || nw.letterSpacing !== null)) {
            try {
                if (child.fontName !== figma.mixed) {
                    await figma.loadFontAsync(child.fontName);
                } else {
                    var seen = new Map();
                    for (var c = 0; c < child.characters.length; c++) {
                        var f = child.getRangeFontName(c, c + 1);
                        if (f !== figma.mixed) seen.set(f.family + "::" + f.style, f);
                    }
                    var fl = []; seen.forEach(function (font) { fl.push(font); });
                    for (var fi = 0; fi < fl.length; fi++) await figma.loadFontAsync(fl[fi]);
                }
                if (nw.fontSize !== null) child.fontSize = nw.fontSize;
                if (nw.lineHeight !== null) child.lineHeight = { unit: "PIXELS", value: nw.lineHeight };
                if (nw.letterSpacing !== null) child.letterSpacing = { unit: "PIXELS", value: nw.letterSpacing };
            } catch (e) { console.error("text [" + child.name + "]:", e); }

        }

        // Restore attributes in correct order:
        // 1. Aspect ratio lock first — must be before HUG/FILL so sizing respects the lock
        try { if (old.constrainProportions) { try { child.lockAspectRatio(old.width / old.height); } catch (_) { } }; } catch (_) { }

        // 2. HUG sizing — wraps content, safe to always restore
        try {
            if (old.layoutSizingH === "HUG") child.layoutSizingHorizontal = "HUG";
            if (old.layoutSizingV === "HUG") child.layoutSizingVertical = "HUG";
        } catch (_) { }

        // 3. FILL sizing — only for auto layout children (not absolute), never for Boolean/Union, Logo, or Union-parent
        try {
            var isLogoNode = child.name.toLowerCase().indexOf("logo") !== -1;
            var isUnionParent = hasUnionChild(child);
            if (parentIsAutoLayout && !childIsAbsolute && child.type !== "BOOLEAN_OPERATION" && child.type !== "VECTOR" && !isLogoNode && !isUnionParent) {
                if (old.layoutSizingH === "FILL") child.layoutSizingHorizontal = "FILL";
                if (old.layoutSizingV === "FILL") child.layoutSizingVertical = "FILL";
            }
        } catch (_) { }

        // 4. Auto layout direction — restore last so it doesn't interfere with sizing
        try {
            if (old.layoutMode && old.layoutMode !== "NONE") child.layoutMode = old.layoutMode;
        } catch (_) { }

        // Skip recursion into Union/Boolean operations and standalone Vectors —
        // Figma manages their children internally; scaling them individually breaks shapes
        if (child.type === "BOOLEAN_OPERATION" || child.type === "VECTOR" || child.type === "STAR" || child.type === "POLYGON" || child.type === "ELLIPSE") {
            continue;
        }

        // Recurse with old dimensions as parent dims
        await applyAllData(child, oldMap, newMap, rx, ry, old.width, old.height, rootTargetW, rootTargetH);
    }
}

// ─── Main flow ────────────────────────────────────────────────────────────────

async function duplicateAndResize(master, newW, newH, label, row1YHint, maxPerRow, col1, forceNewRow, rowFloorY, anchorX) {
    var oldW = master.width;
    var oldH = master.height;
    var ratioX = newW / oldW;
    var ratioY = newH / oldH;
    var ratio = Math.min(ratioX, ratioY);
    console.log("oldW=" + oldW + " oldH=" + oldH + " newW=" + newW + " newH=" + newH);
    console.log("ratioX=" + ratioX + " ratioY=" + ratioY + " ratio=" + ratio);

    // 1. Clone and place on canvas
    var clone = master.clone();
    figma.currentPage.appendChild(clone);
    clone.name = label || ("Banner " + newW + "x" + newH);

    // ── Placement constants ──────────────────────────────────────────────────
    var GAP = 60;
    var MAX_PER_ROW = (maxPerRow && maxPerRow > 0) ? maxPerRow : 6;
    var page = figma.currentPage;
    // anchorX overrides the normal "just right of this master" starting point — used to
    // chain a new template's package immediately to the right of a previous template's
    // whole package, regardless of where this master itself sits on the canvas.
    var firstCreatedX = (anchorX != null) ? anchorX : (master.x + master.width + GAP);
    // Reference X used to decide which existing frames on the page belong to THIS
    // package (mirrors firstCreatedX so sibling-detection stays consistent with the override).
    var packageRightEdgeRef = (anchorX != null) ? (anchorX - GAP) : (master.x + master.width);

    // Initial position — final position set after processing
    clone.x = firstCreatedX;
    clone.y = master.y;

    // 2. Swap variant
    // Only apply square preference for portrait targets where ry < rx
    var ryLtRx = ((ratioY < ratioX) && (newH > newW)) || (newW === newH);
    console.log("ryLtRx=" + ryLtRx + " ratioX=" + ratioX.toFixed(3) + " ratioY=" + ratioY.toFixed(3) + " portrait=" + (newH > newW));
    var swappedVariant = await swapBestVariant(clone, newW, newH, ryLtRx);
    console.log("[swap] chosen variant: " + (swappedVariant ? swappedVariant.name + " " + swappedVariant.w + "x" + swappedVariant.h : "none"));

    // 3. Detach all instances so everything is editable
    if (clone.type === "INSTANCE") clone = clone.detachInstance();
    detachAllInstances(clone);

    console.log("===== AFTER DETACH =====");

    var theme = clone.findOne(function (n) {
        return n.name === "Theme 1";
    });

    console.log("Clone:", clone.width, clone.height);

    if (theme) {
        console.log(
            "Theme1:",
            theme.width,
            theme.height,
            theme.layoutSizingHorizontal,
            theme.layoutSizingVertical
        );
    }

    // 4. Wait for Figma to fully settle after swap + detach
    await new Promise(function (resolve) { setTimeout(resolve, 300); });

    // After swap+detach, find the content frame.
    // The swapped variant may be an INSTANCE or FRAME child with different dimensions.
    // Walk all direct children to find one whose dimensions differ from the wrapper (clone).
    // If found, use it. Otherwise use clone itself.
    // Find actual dimensions of the swapped variant without discarding any nodes.
    // Walk children to find a FRAME/INSTANCE that matches the swapped size.
    // Use its dimensions for ratio calculation but keep clone as the content frame.
    // Log clone structure to debug
    console.log("[clone] type=" + clone.type + " name=" + clone.name + " w=" + Math.round(clone.width) + " h=" + Math.round(clone.height) + " children=" + (clone.children ? clone.children.length : 0));
    if (clone.children) {
        for (var dci = 0; dci < clone.children.length; dci++) {
            var dc = clone.children[dci];
            console.log("  [child " + dci + "] type=" + dc.type + " name=" + dc.name + " w=" + Math.round(dc.width) + " h=" + Math.round(dc.height));
        }
    }

    // Always use clone as content frame — never lift out children (would lose siblings)
    var contentFrame = clone;

    function findContentFrame(root, targetW, targetH) {

        var best = null;

        function walk(node) {

            if (
                node.type === "FRAME" &&
                Math.round(node.width) === targetW &&
                Math.round(node.height) === targetH
            ) {
                best = node;
                return;
            }

            if (!node.children) return;

            for (var i = 0; i < node.children.length; i++) {
                walk(node.children[i]);
                if (best) return;
            }
        }

        walk(root);

        return best;
    }

    // Used ONLY as a fallback dimension source below (when the variant name can't be
    // parsed) — must NOT replace contentFrame itself, or only that nested frame gets
    // resized/renamed/positioned while the actual outer banner frame (clone) is left at
    // its stale pre-swap size, which is the bug this comment used to warn about above.
    var matchedInnerFrame = swappedVariant ? findContentFrame(clone, swappedVariant.w, swappedVariant.h) : null;

    // Use swapped variant name-parsed dimensions as actualOldW/H
    // contentFrame.width/height stays at master wrapper size after swapComponent
    var actualOldW, actualOldH;
    if (swappedVariant && swappedVariant.w > 0 && swappedVariant.h > 0) {
        actualOldW = swappedVariant.w;
        actualOldH = swappedVariant.h;
        console.log("[actualOldW/H] from swapped variant name: " + actualOldW + "x" + actualOldH);
    } else if (matchedInnerFrame) {
        actualOldW = Math.round(matchedInnerFrame.width);
        actualOldH = Math.round(matchedInnerFrame.height);
        console.log("[actualOldW/H] from matched inner frame: " + actualOldW + "x" + actualOldH);
    } else {
        actualOldW = Math.round(contentFrame.width);
        actualOldH = Math.round(contentFrame.height);
        console.log("[actualOldW/H] from contentFrame: " + actualOldW + "x" + actualOldH);
    }
    console.log("Content frame: " + contentFrame.name + " " + contentFrame.width + "x" + contentFrame.height);
    // Recalculate ratios — use pre-computed actualOldW/H from inner child if available
    var ratioX = newW / actualOldW;
    var ratioY = newH / actualOldH;
    var ratio = Math.min(ratioX, ratioY);
    console.log("actualOldW=" + actualOldW + " actualOldH=" + actualOldH + " ratioX=" + ratioX + " ratioY=" + ratioY + " ratio=" + ratio);
    console.log("contentFrame before resize: " + contentFrame.width + "x" + contentFrame.height + " name=" + contentFrame.name);

    // PHASE 1: Read ALL current data from contentFrame AFTER variant is set and detached
    var oldDataMap = {};
    readAllData(contentFrame, oldDataMap);
    console.log("Read " + Object.keys(oldDataMap).length + " nodes from settled variant");
    console.log("contentFrame children: " + (contentFrame.children ? contentFrame.children.length : 0));

    // Snapshot ALL sizing before resize converts HUG/FILL to FIXED
    var hugSnap = [];
    var allNodes = contentFrame.findAll(function (n) { return true; });
    allNodes.push(contentFrame);
    for (var i = 0; i < allNodes.length; i++) {
        var n = allNodes[i];
        if (n.layoutSizingHorizontal !== undefined || n.layoutSizingVertical !== undefined) {
            hugSnap.push({ node: n, h: n.layoutSizingHorizontal, v: n.layoutSizingVertical });
            if (n.layoutSizingHorizontal === "HUG" || n.layoutSizingVertical === "HUG" ||
                n.layoutSizingHorizontal === "FILL" || n.layoutSizingVertical === "FILL") {
                console.log("[snap] " + n.name + " H=" + n.layoutSizingHorizontal + " V=" + n.layoutSizingVertical + " locked=" + n.locked);
            }
        }
    }

    // PHASE 2: Calculate ALL new values based on ratio
    var newDataMap = calcNewValues(oldDataMap, ratioX, ratioY, ratio);

    // If contentFrame is ITSELF an auto-layout frame set to "Hug contents" on either axis
    // (primaryAxisSizingMode/counterAxisSizingMode = "AUTO"), calling resize() below would
    // get silently overridden right back to fit its current (still full-size, not-yet-
    // shrunk) children — since the children aren't scaled down until Phase 3 below. Force
    // it to FIXED first so the resize actually holds.
    console.log("[contentFrame self-sizing] layoutMode=" + contentFrame.layoutMode + " primaryAxisSizingMode=" + contentFrame.primaryAxisSizingMode + " counterAxisSizingMode=" + contentFrame.counterAxisSizingMode);
    if (contentFrame.layoutMode && contentFrame.layoutMode !== "NONE") {
        try {
            var cfWasLocked = contentFrame.locked;
            if (cfWasLocked) contentFrame.locked = false;
            if (contentFrame.primaryAxisSizingMode !== undefined) contentFrame.primaryAxisSizingMode = "FIXED";
            if (contentFrame.counterAxisSizingMode !== undefined) contentFrame.counterAxisSizingMode = "FIXED";
            if (cfWasLocked) contentFrame.locked = true;
            console.log("[contentFrame self-sizing] forced to FIXED before resize");
        } catch (e) { console.log("[contentFrame self-sizing] FAILED to force FIXED: " + e.message); }
    }

    // 5. Resize the content frame
    contentFrame.resize(newW, newH);
    // Always clip contents to the frame's own bounds. Text/CTA containers are set to
    // "Hug contents" further down so wrapped text can grow — without clipping, a longer
    // translated string can make those containers overflow past this frame's edge and
    // visually bleed into the next row/package, even though this frame's own x/y and
    // size are correct. This also carries over to translated clones automatically,
    // since clone() preserves this property.
    try { contentFrame.clipsContent = true; } catch (e) { console.log("[clip] failed: " + e.message); }
    console.log("[contentFrame self-sizing] after resize: w=" + contentFrame.width + " h=" + contentFrame.height);
    // Name: build from variant name template
    // - Strip "Property 1=" prefix
    // - Replace size with new size
    // - If batch label has a prefix (text before the size), replace the campaign segment
    //   e.g. "Growline" in "EMEA_..._728x90px_Growline_EN" → batch first column text
    var frameName;
    if (swappedVariant && swappedVariant.name) {
        var baseName = swappedVariant.name.indexOf('=') !== -1 ? swappedVariant.name.split('=').pop().trim() : swappedVariant.name;
        // Replace size portion
        var replaced = baseName.replace(/\d+\s*[x\u00D7]\s*\d+\s*(?:px)?/gi, newW + "x" + newH);
        // If batch label has a text prefix, replace campaign segment (word between size and locale suffix)
        // Use col1 (first batch column) to replace "RetailerName" in the variant name
        // If no col1, remove "_RetailerName" entirely (including the underscore before it)
        console.log("[name] col1=" + col1 + " label=" + label);
        if (col1) {
            // Replace "-RetailerName" or "_RetailerName" with "_col1" (always use _ separator)
            replaced = replaced.replace(/[-_]RetailerName/g, '_' + col1);
        } else {
            replaced = replaced.replace(/[-_]RetailerName/g, '');
        }
        frameName = replaced;
        console.log("[name] variant=" + swappedVariant.name + " → " + frameName);
    } else if (label) {
        frameName = label;
    } else {
        frameName = "Banner " + newW + "x" + newH;
    }
    contentFrame.name = frameName;
    console.log("Content frame resized: " + contentFrame.width + "x" + contentFrame.height);

    // PHASE 3: Apply all new values
    await applyAllData(contentFrame, oldDataMap, newDataMap, ratioX, ratioY, actualOldW, actualOldH, newW, newH);

    // Restore ALL sizing values (HUG, FILL) back to pre-resize state
    // FIXED nodes are already at correct pixel size from applyAllData — no need to restore
    // Skip root contentFrame so it stays at the new fixed size
    for (var i = 0; i < hugSnap.length; i++) {
        var s = hugSnap[i];
        try { if (!s.node || !s.node.id) continue; } catch (_) { continue; }
        if (s.node.id === contentFrame.id) continue;
        if (s.h !== "HUG" && s.h !== "FILL" && s.v !== "HUG" && s.v !== "FILL") continue;
        try {
            var wasLocked = false;
            try { wasLocked = s.node.locked; if (wasLocked) s.node.locked = false; } catch (_) { }
            var isLogoRestore = s.node.name.toLowerCase().indexOf("logo") !== -1;
            var isUnionParentRestore = hasUnionChild(s.node);
            // Never restore FILL on Logo or Union-parent nodes — keep them at fixed pixel size
            var skipFill = isLogoRestore || isUnionParentRestore;
            var hVal = (s.h === "FILL" && skipFill) ? null : s.h;
            var vVal = (s.v === "FILL" && skipFill) ? null : s.v;
            if (hVal === "HUG" || hVal === "FILL") {
                try { s.node.layoutSizingHorizontal = hVal; console.log("[restore] H=" + hVal + ": " + s.node.name); }
                catch (e) { console.log("[restore] H=" + hVal + " FAIL: " + s.node.name + " " + e.message); }
            }
            if (vVal === "HUG" || (vVal === "FILL" && s.node.type !== "BOOLEAN_OPERATION" && s.node.type !== "VECTOR")) {
                try { s.node.layoutSizingVertical = vVal; console.log("[restore] V=" + vVal + ": " + s.node.name); }
                catch (e) { console.log("[restore] V=" + vVal + " FAIL: " + s.node.name + " " + e.message); }
            }
            if (wasLocked) { try { s.node.locked = true; } catch (_) { } }
        } catch (_) { }
    }

    // ── SET TEXT NODES + THEIR PARENTS TO HUG HEIGHT ────────────────────────────
    // After resize, text nodes should HUG their content height (not stay FIXED)
    // Their parent frames should also HUG height so layout adjusts correctly
    var allAfterNodes = contentFrame.findAll(function (n) { return true; });
    var textParentIds = {};

    // Pass 1: set all TEXT nodes to HUG height
    for (var ti = 0; ti < allAfterNodes.length; ti++) {
        var tn = allAfterNodes[ti];
        if (tn.type !== "TEXT") continue;
        try {
            var tnLocked = false;
            try { tnLocked = tn.locked; if (tnLocked) tn.locked = false; } catch (_) { }
            if (tn.layoutSizingVertical !== undefined) {
                tn.layoutSizingVertical = "HUG";
            }
            if (tnLocked) { try { tn.locked = true; } catch (_) { } }
            // Mark parent for HUG too
            if (tn.parent && tn.parent.id !== contentFrame.id) {
                textParentIds[tn.parent.id] = tn.parent;
            }
        } catch (e) { }
    }

    // Pass 2: walk up ancestors of text nodes and set HUG height
    // Stops at contentFrame or when a Union-parent / bg / logo is found
    var visitedAncestors = {};
    for (var pid in textParentIds) {
        var ancestor = textParentIds[pid];
        while (ancestor && ancestor.id !== contentFrame.id) {
            try {
                if (visitedAncestors[ancestor.id]) break; // already processed
                visitedAncestors[ancestor.id] = true;
                if (!nodeExists(ancestor)) break;
                if (hasUnionChild(ancestor)) break; // stop — must stay FIXED
                var aName = ancestor.name.toLowerCase();
                if (aName === "bg") break;
                if (aName.indexOf("logo") !== -1) break;
                var aLocked = false;
                try { aLocked = ancestor.locked; if (aLocked) ancestor.locked = false; } catch (_) { }
                if (ancestor.layoutSizingVertical !== undefined) {
                    ancestor.layoutSizingVertical = "HUG";
                    console.log("[text-hug] HUG V ancestor: " + ancestor.name);
                }
                if (aLocked) { try { ancestor.locked = true; } catch (_) { } }
                ancestor = ancestor.parent;
            } catch (e) { break; }
        }
    }

    // ── SET CTA AND ALL CHILDREN TO HUG WIDTH (runs last, overrides FIXED from Rule 1) ──
    var allCTANodes = contentFrame.findAll(function (n) {
        return n.name.toLowerCase().indexOf("cta") !== -1;
    });
    for (var ci = 0; ci < allCTANodes.length; ci++) {
        var ctaNode = allCTANodes[ci];
        try {
            var ctaLocked = ctaNode.locked;
            if (ctaLocked) ctaNode.locked = false;
            if (ctaNode.layoutSizingHorizontal !== undefined) {
                ctaNode.layoutSizingHorizontal = "HUG";
                console.log("[cta-hug] HUG width: " + ctaNode.name);
            }
            if (ctaLocked) ctaNode.locked = true;
        } catch (e) { }
        if (!ctaNode.findAll) continue;
        var ctaChildren = ctaNode.findAll(function (c) { return true; });
        for (var cci = 0; cci < ctaChildren.length; cci++) {
            var cc = ctaChildren[cci];
            try {
                if (!nodeExists(cc)) continue;
                var ccLocked = cc.locked;
                if (ccLocked) cc.locked = false;
                if (cc.layoutSizingHorizontal !== undefined) {
                    cc.layoutSizingHorizontal = "HUG";
                    console.log("[cta-hug] HUG width child: " + cc.name);
                }
                if (ccLocked) cc.locked = true;
            } catch (e) { }
        }
    }

    // ── SET TEXT LAYERS TO FILL WIDTH (if not inside CTA) ───────────────────────
    // Text nodes outside CTA should fill their parent width for proper wrapping
    var allTextNodes = contentFrame.findAll(function (n) { return n.type === "TEXT"; });
    for (var ti2 = 0; ti2 < allTextNodes.length; ti2++) {
        var tn2 = allTextNodes[ti2];
        try {
            // Check if any ancestor has "cta" in name — if so, skip (CTA handles its own sizing)
            var insideCTA2 = false;
            var anc = tn2.parent;
            while (anc && anc.id !== contentFrame.id) {
                if (anc.name.toLowerCase().indexOf("cta") !== -1) { insideCTA2 = true; break; }
                anc = anc.parent;
            }
            if (insideCTA2) continue;
            // Parent must be auto-layout for FILL to work
            if (!tn2.parent || !tn2.parent.layoutMode || tn2.parent.layoutMode === "NONE") continue;
            if (tn2.layoutSizingHorizontal === undefined) continue;
            var tn2Locked = tn2.locked;
            if (tn2Locked) tn2.locked = false;
            tn2.layoutSizingHorizontal = "FILL";
            if (tn2Locked) tn2.locked = true;
        } catch (e) { }
    }

    // Set final position AFTER all processing
    var batchMode = (row1YHint !== undefined && row1YHint !== null);
    var finalSiblings = [];

    // Collect siblings to the right of the master
    // In batch mode: exclude frames that are strictly ABOVE row1YHint (from previous themes)
    // but include frames at row1Y and below (current theme's row1 and row2+)
    for (var si = 0; si < page.children.length; si++) {
        var n = page.children[si];
        if (n.id === master.id || n.id === contentFrame.id) continue;
        if (n.x < packageRightEdgeRef - 1) continue;
        // In batch mode: skip frames that are above row1YHint (they belong to earlier themes)
        if (batchMode && n.y < row1YHint - 2) continue;
        finalSiblings.push(n);
    }
    finalSiblings.sort(function (a, b) { return a.x - b.x; });

    // row1Y = use hint if provided (batch mode), else find from siblings
    var row1Y = batchMode ? row1YHint : null;
    if (row1Y === null) {
        row1Y = finalSiblings.length > 0 ? finalSiblings[0].y : master.y;
        for (var i = 1; i < finalSiblings.length; i++) {
            if (finalSiblings[i].y < row1Y) row1Y = finalSiblings[i].y;
        }
    }
    console.log("row1Y=" + row1Y + " finalSiblings=" + finalSiblings.length);

    // Split into row1 and row2+
    // In batch mode: use exact Y match (row1Y is passed precisely from batch controller)
    // In single mode: use GAP tolerance since Y is detected from canvas
    var row1Banners = [];
    var otherBanners = [];
    // batchMode already declared above
    for (var i = 0; i < finalSiblings.length; i++) {
        var s = finalSiblings[i];
        var tolerance = batchMode ? 2 : GAP;
        if (Math.abs(s.y - row1Y) <= tolerance) {
            row1Banners.push(s);
        } else {
            otherBanners.push(s);
        }
    }
    console.log("batchMode=" + batchMode + " row1Banners=" + row1Banners.length + " otherBanners=" + otherBanners.length + " MAX_PER_ROW=" + MAX_PER_ROW);
    for (var i = 0; i < row1Banners.length; i++) console.log("  row1[" + i + "] x=" + Math.round(row1Banners[i].x) + " y=" + Math.round(row1Banners[i].y) + " w=" + Math.round(row1Banners[i].width));
    for (var i = 0; i < otherBanners.length; i++) console.log("  other[" + i + "] x=" + Math.round(otherBanners[i].x) + " y=" + Math.round(otherBanners[i].y));
    row1Banners.sort(function (a, b) { return a.x - b.x; });
    otherBanners.sort(function (a, b) { return a.y !== b.y ? a.y - b.y : a.x - b.x; });

    var finalX, finalY;

    // ── Retailer break: force this banner onto a brand-new row, below everything
    // placed so far, regardless of how much space is left in the current row ──
    if (forceNewRow) {
        var allBottom = -Infinity;
        for (var i = 0; i < row1Banners.length; i++) {
            var b = row1Banners[i].y + row1Banners[i].height;
            if (b > allBottom) allBottom = b;
        }
        for (var i = 0; i < otherBanners.length; i++) {
            var b = otherBanners[i].y + otherBanners[i].height;
            if (b > allBottom) allBottom = b;
        }
        finalX = firstCreatedX;
        finalY = (allBottom === -Infinity) ? (batchMode ? row1Y : master.y) : allBottom + GAP;
        console.log("[retailerBreak] forcing new row at y=" + Math.round(finalY));
    } else if (row1Banners.length < MAX_PER_ROW && (rowFloorY == null || row1Y >= rowFloorY - 2)) {
        if (row1Banners.length === 0) {
            finalX = firstCreatedX;
            finalY = batchMode ? row1Y : master.y; // Align to the row1 hint (e.g. a chained package baseline) if given, else to master
        } else {
            var last1 = row1Banners[row1Banners.length - 1];
            finalX = last1.x + last1.width + GAP;
            finalY = row1Y; // Align to actual row 1 Y

        }
    } else {
        // Row 1 full (or below the current retailer's row floor) — find bottom of tallest banner in row 1
        // In batch mode: only use banners at exactly row1Y to avoid mixing with other themes
        var row1Bottom = -Infinity;
        for (var i = 0; i < row1Banners.length; i++) {
            var rb = row1Banners[i];
            // Only count banners that are truly on row1 (within 2px of row1Y)
            if (batchMode && Math.abs(rb.y - row1Y) > 2) continue;
            var b = rb.y + rb.height;
            console.log("  row1[" + i + "] y=" + Math.round(rb.y) + " h=" + Math.round(rb.height) + " bottom=" + Math.round(b));
            if (b > row1Bottom) row1Bottom = b;
        }
        // Also include current frame height in row1Bottom calculation
        if (row1Bottom === -Infinity) row1Bottom = row1Y + newH;
        console.log("row1Bottom=" + Math.round(row1Bottom) + " row2Y=" + Math.round(row1Bottom + GAP));
        var row2Y = row1Bottom + GAP;

        // Group otherBanners into rows by Y — use exact match in batch mode
        var otherRows = [];
        for (var i = 0; i < otherBanners.length; i++) {
            var s = otherBanners[i];
            var placed = false;
            var otherTolerance = batchMode ? 2 : GAP;
            for (var r = 0; r < otherRows.length; r++) {
                if (Math.abs(s.y - otherRows[r][0].y) <= otherTolerance) {
                    otherRows[r].push(s); placed = true; break;
                }
            }
            if (!placed) otherRows.push([s]);
        }
        for (var r = 0; r < otherRows.length; r++) otherRows[r].sort(function (a, b) { return a.x - b.x; });

        console.log("otherRows=" + otherRows.length + " row2Y=" + Math.round(row2Y));
        for (var r = 0; r < otherRows.length; r++) {
            console.log("  otherRow[" + r + "] count=" + otherRows[r].length + " y=" + Math.round(otherRows[r][0].y));
        }

        // Find first row with space — skip rows above the current retailer's row floor
        // (those belong to an earlier retailer group and must not be backfilled)
        var targetOtherRow = null;
        for (var r = 0; r < otherRows.length; r++) {
            if (rowFloorY != null && otherRows[r][0].y < rowFloorY - 2) continue;
            if (otherRows[r].length < MAX_PER_ROW) { targetOtherRow = otherRows[r]; break; }
        }

        if (otherRows.length === 0) {
            // No other rows yet — start row 2
            finalX = firstCreatedX;
            finalY = row2Y;
        } else if (targetOtherRow !== null) {
            // Found a row with space — append to it
            var lastOther = targetOtherRow[targetOtherRow.length - 1];
            finalX = lastOther.x + lastOther.width + GAP;
            finalY = targetOtherRow[0].y;
        } else {
            // All other rows full (or below the floor) — start a new row below the last one
            var lastOtherRow = otherRows[otherRows.length - 1];
            var lastOtherBottom = -Infinity;
            for (var i = 0; i < lastOtherRow.length; i++) {
                var b = lastOtherRow[i].y + lastOtherRow[i].height;
                if (b > lastOtherBottom) lastOtherBottom = b;
            }
            finalX = firstCreatedX;
            finalY = lastOtherBottom + GAP;
        }
    }
    contentFrame.x = finalX;
    contentFrame.y = finalY;


    console.log("Final position: x=" + contentFrame.x + " y=" + contentFrame.y + " w=" + contentFrame.width + " h=" + contentFrame.height);

    // ── LAST STEP: Fix "bg" layer image fill ─────────────────────────────────────
    // Must run after all scaling and positioning is complete
    var bgNodes = contentFrame.findAll(function (n) {
        return n.name.toLowerCase() === "bg";
    });
    for (var bi = 0; bi < bgNodes.length; bi++) {
        var bgNode = bgNodes[bi];
        if (!bgNode.fills || bgNode.fills === figma.mixed || bgNode.fills.length === 0) continue;
        try {
            // Wait 1s for Figma to fully settle before touching the image fill
            await new Promise(function (resolve) { setTimeout(resolve, 1000); });

            // Step 1: Set to FILL — Figma recalculates transform to cover the new frame size
            var fillFills = [];
            for (var fi = 0; fi < bgNode.fills.length; fi++) {
                var fill = bgNode.fills[fi];
                if (fill.type === "IMAGE") {
                    var f = {}; for (var key in fill) { f[key] = fill[key]; }
                    f.scaleMode = "FILL";
                    fillFills.push(f);
                } else { fillFills.push(fill); }
            }
            bgNode.fills = fillFills;
            console.log("bg set to FILL: " + bgNode.name);

            // Wait 1s for FILL transform to be fully applied
            await new Promise(function (resolve) { setTimeout(resolve, 200); });

            // Step 2: Set to CROP — keeps the FILL-calculated transform
            var cropFills = [];

            for (var fi = 0; fi < bgNode.fills.length; fi++) {

                var fill = bgNode.fills[fi];

                if (fill.type === "IMAGE") {

                    var f = {};

                    for (var key in fill) {
                        f[key] = fill[key];
                    }

                    // preserve transform from FILL
                    f.scaleMode = "CROP";

                    cropFills.push(f);

                } else {

                    cropFills.push(fill);

                }
            }

            bgNode.fills = cropFills;
            console.log("bg set to CROP: " + bgNode.name);
        } catch (e) { console.error("bg fix failed:", e); }
    }

    // ── POST-RESIZE SIZING RULES ─────────────────────────────────────────────────
    // Rule 1: ABSOLUTE layer → FIXED width
    // Rule 3: CTA inside absolute → HUG
    // Rule 4: nodes inside CTA ancestor → HUG
    var allNodes = contentFrame.findAll(function (n) { return true; });
    for (var ai = 0; ai < allNodes.length; ai++) {
        var n = allNodes[ai];
        try {
            var layoutPos;
            try { layoutPos = n.layoutPositioning; } catch (e) { continue; }
            if (layoutPos !== "ABSOLUTE") continue;

            // Rule 1: absolute layer itself → FIXED (skip CTA — stays HUG)
            try {
                if (n.layoutSizingHorizontal !== undefined && n.name.toLowerCase().indexOf("cta") === -1) {
                    n.layoutSizingHorizontal = "FIXED";
                    console.log("[sizing] FIXED: " + n.name);
                }
            } catch (e) { }

            // Rules 3 & 4: CTA nodes inside this absolute layer → HUG
            if (!n.children) continue;
            var innerNodes = n.findAll(function (c) { return true; });
            for (var ii = 0; ii < innerNodes.length; ii++) {
                var inner = innerNodes[ii];
                try {
                    if (inner.layoutSizingHorizontal === undefined) continue;

                    // Rule 3: node named CTA → HUG width only
                    if (inner.name.toLowerCase().indexOf("cta") !== -1) {
                        try { if (inner.layoutSizingHorizontal !== undefined) inner.layoutSizingHorizontal = "HUG"; } catch (e) { }
                        console.log("[sizing] HUG W (CTA): " + inner.name);
                        continue;
                    }

                    // Rule 4: node inside a CTA ancestor → HUG width only
                    var insideCTA = false;
                    var ancestor = inner.parent;
                    while (ancestor && ancestor !== n) {
                        if (ancestor.name.toLowerCase().indexOf("cta") !== -1) { insideCTA = true; break; }
                        ancestor = ancestor.parent;
                    }
                    if (insideCTA) {
                        try { if (inner.layoutSizingHorizontal !== undefined) inner.layoutSizingHorizontal = "HUG"; } catch (e) { }
                        console.log("[sizing] HUG W (inside CTA): " + inner.name);
                    }
                } catch (e) { console.error("[sizing] failed on " + inner.name + ":", e); }
            }
        } catch (e) { console.error("[sizing] failed on " + n.name + ":", e); }
    }

    figma.viewport.scrollAndZoomIntoView([contentFrame]);
    return contentFrame;
}

// ─── Resumable batch queue ─────────────────────────────────────────────────────
// Runs (or resumes) a batch of sizes starting at state.startIndex. If the user hits
// Stop mid-run, progress is saved into _pausedBatch and a PAUSED message is sent so
// the UI can show a Continue button; CONTINUE_BATCH picks this function back up.
async function runBatchQueue(masterNode, sizes, maxPerRow, retailerBreak, verticalLayout, state) {
    var done = state.done;
    var errors = state.errors;
    var batchRow1Y = state.batchRow1Y;
    // Tracks the retailer (col1) of the previously placed banner, and the Y of the
    // row floor below which the current retailer's banners must not backfill —
    // both are only used when "Retailer break line" is enabled.
    var prevCol1 = state.prevCol1;
    var retailerRowFloorY = state.retailerRowFloorY;
    // When set, chains this whole package to the right of a previous template's package
    // (see BATCH_RESIZE handler). Stays constant for every banner in this run.
    var anchorX = state.anchorX != null ? state.anchorX : null;
    // Identifies which template (frame + selected variant) this run belongs to.
    var packageKey = state.packageKey;

    for (var si = state.startIndex; si < sizes.length; si++) {
        if (_stopRequested) {
            _pausedBatch = null;
            figma.ui.postMessage({ type: "DONE", message: "Stopped after " + done + " banners" });
            return;
        }
        if (_pauseRequested) {
            _pausedBatch = {
                sel: masterNode, sizes: sizes, maxPerRow: maxPerRow, retailerBreak: retailerBreak, verticalLayout: verticalLayout,
                startIndex: si, done: done, errors: errors,
                batchRow1Y: batchRow1Y, prevCol1: prevCol1, retailerRowFloorY: retailerRowFloorY, anchorX: anchorX, packageKey: packageKey
            };
            figma.ui.postMessage({ type: "PAUSED", message: "Paused after " + done + "/" + sizes.length + " banners", done: done, total: sizes.length });
            return;
        }
        try {
            var s = sizes[si];
            var curCol1 = s.col1 || null;
            // Vertical layout: every banner gets its own row, stacked in a single column
            // below the master. Otherwise, force a brand-new row whenever the retailer
            // (col1) changes from the previous banner ("Retailer break line").
            var forceNewRow = verticalLayout || (retailerBreak && prevCol1 !== null && curCol1 !== prevCol1);

            figma.ui.postMessage({ type: "PROGRESS", done: done, total: sizes.length, message: "Creating " + s.width + "x" + s.height + "…" });
            var result = await duplicateAndResize(masterNode, s.width, s.height, s.label || null, batchRow1Y, maxPerRow, s.col1 || null, forceNewRow, retailerRowFloorY, anchorX);

            // Only set row1Y once from the very first banner — never update it
            if (batchRow1Y === null) batchRow1Y = result.y;
            if (forceNewRow) retailerRowFloorY = result.y;

            // Keep the package tracker up to date so the NEXT template (if a different
            // template/variant is selected) chains immediately to the right of this one.
            _lastPackageKey = packageKey;
            _lastPackageBaselineY = batchRow1Y;
            var packageEdge = result.x + result.width;
            if (_lastPackageRightX === null || packageEdge > _lastPackageRightX) _lastPackageRightX = packageEdge;

            console.log("Batch [" + si + "] " + s.width + "x" + s.height + " placed x=" + Math.round(result.x) + " y=" + Math.round(result.y) + " batchRow1Y=" + Math.round(batchRow1Y) + " forceNewRow=" + forceNewRow + " retailer=" + curCol1);

            prevCol1 = curCol1;

            await new Promise(function (resolve) { setTimeout(resolve, 200); });
            done++;
        } catch (err) {
            console.error("Batch error at " + sizes[si].width + "x" + sizes[si].height + ":", err);
            errors++;
            done++;
        }
    }

    _pausedBatch = null;
    var msg2 = "✓ Created " + (done - errors) + "/" + sizes.length + " banners";
    if (errors > 0) msg2 += " (" + errors + " failed)";
    figma.ui.postMessage({ type: "SUCCESS", message: msg2 });
}

// ─── Resumable export queue ─────────────────────────────────────────────────────
// Runs (or resumes) an export over a flat list of { node, folder } tasks, starting at
// state.startIndex. Stop/Pause behave the same way as the batch queue above: Stop
// discards everything and ends; Pause saves progress into _pausedExport so
// CONTINUE_EXPORT can pick it back up exactly where it left off.
async function runExportQueue(tasks, format, scale, state) {
    var done = state.done;
    var total = state.total;

    for (var i = state.startIndex; i < tasks.length; i++) {
        if (_stopRequested) {
            _pausedExport = null;
            console.log("[export] stopped by user after " + done + "/" + total);
            figma.ui.postMessage({ type: "EXPORT_DONE", message: "Stopped after " + done + "/" + total + " frames", format: format, assetsExported: done, stopped: true });
            return;
        }
        if (_pauseRequested) {
            _pausedExport = { tasks: tasks, format: format, scale: scale, startIndex: i, done: done, total: total };
            console.log("[export] paused after " + done + "/" + total);
            figma.ui.postMessage({ type: "EXPORT_PAUSED", message: "Paused after " + done + "/" + total + " frames", done: done, total: total });
            return;
        }

        var task = tasks[i];
        var node = task.node;
        var folder = task.folder;
        try {
            console.log("[export] " + (i + 1) + "/" + total + ": " + (folder ? folder + "/" : "") + node.name);
            var bytes = await node.exportAsync({ format: format === "PDF" ? "PNG" : format, constraint: { type: "SCALE", value: scale } });
            figma.ui.postMessage({
                type: "EXPORT_FILE",
                name: node.name + ((format === "JPG") ? ".jpg" : ".png"),
                bytes: bytes,
                folder: folder || "",
                format: format,
                width: Math.round(node.width * scale),
                height: Math.round(node.height * scale),
                x: Math.round(node.x),
                y: Math.round(node.y)
            });
            done++;
            figma.ui.postMessage({ type: "EXPORT_PROGRESS", message: "Exporting…", done: done, total: total, detail: "✓ " + (folder ? folder + "/" : "") + node.name });
        } catch (e) {
            console.error("[export] FAILED: " + node.name + " — " + (e.message || e));
            figma.ui.postMessage({ type: "EXPORT_PROGRESS", message: "Exporting…", done: done, total: total, detail: "✗ " + node.name + ": " + (e.message || "error") });
        }
    }

    _pausedExport = null;
    console.log("=== EXPORT DONE ===");
    figma.ui.postMessage({ type: "EXPORT_DONE", message: "✓ Exported " + done + "/" + total + " frames", format: format, assetsExported: done });
}

// ─── Selection info ───────────────────────────────────────────────────────────

async function sendSelectionInfo() {
    var result = getSelectedFrame();
    if (!result.node) {
        figma.ui.postMessage({ type: "MASTER_INFO", found: false, error: result.error });
        return;
    }
    var node = result.node;
    var variants = [];

    // Find the first instance that belongs to a Component Set
    var instances = node.findAll(function (n) { return n.type === "INSTANCE"; });
    for (var i = 0; i < instances.length; i++) {
        try {
            var mc = await instances[i].getMainComponentAsync();
            if (mc && mc.parent && mc.parent.type === "COMPONENT_SET") {
                var cs = mc.parent;
                var csChild = cs.children[0];
                var cleanFirst = csChild.name.indexOf('=') !== -1 ? csChild.name.split('=').pop().trim() : csChild.name;
                // Detect size CS: strict name match, OR size pattern anywhere, OR different dimensions
                var isSizeVariant = /^\d+\s*[x\u00D7]\s*\d+$/i.test(cleanFirst);
                if (!isSizeVariant) {
                    var f0W = Math.round(cs.children[0].width), f0H = Math.round(cs.children[0].height);
                    for (var si = 0; si < cs.children.length; si++) {
                        if (/\d+\s*[x\u00D7]\s*\d+/i.test(cs.children[si].name)) { isSizeVariant = true; break; }
                        if (Math.round(cs.children[si].width) !== f0W || Math.round(cs.children[si].height) !== f0H) { isSizeVariant = true; break; }
                    }
                }

                if (isSizeVariant) {
                    // Component set variants ARE sizes — use actual node dimensions as primary
                    for (var j = 0; j < cs.children.length; j++) {
                        var v = cs.children[j];
                        var cleanName = v.name.indexOf('=') !== -1 ? v.name.split('=').pop().trim() : v.name;
                        var vW = Math.round(v.width); var vH = Math.round(v.height);
                        var sm = cleanName.match(/^(\d+)\s*[x\u00D7]\s*(\d+)$/i) ||
                            v.name.match(/_(\d+)[x\u00D7](\d+)(?:px)?[_\s]/i);
                        if (sm) { vW = parseInt(sm[1], 10); vH = parseInt(sm[2], 10); }
                        variants.push({ name: v.name, width: vW, height: vH });
                    }
                } else {
                    // Component set variants are campaigns (e.g. Summer Campaign 1)
                    // Look inside the current active variant for a nested Component Set with sizes
                    var innerInstances = instances[i].findAll(function (n) { return n.type === "INSTANCE"; });
                    var foundSizes = false;
                    for (var k = 0; k < innerInstances.length; k++) {
                        try {
                            var innerMc = await innerInstances[k].getMainComponentAsync();
                            if (innerMc && innerMc.parent && innerMc.parent.type === "COMPONENT_SET") {
                                var innerCs = innerMc.parent;
                                for (var j = 0; j < innerCs.children.length; j++) {
                                    var v = innerCs.children[j];
                                    var sz = extractVariantSize(v);
                                    variants.push({ name: v.name, width: sz.w, height: sz.h });
                                }
                                foundSizes = true;
                                break;
                            }
                        } catch (e) { }
                    }
                    // If no nested sizes found, show campaign names
                    if (!foundSizes) {
                        for (var j = 0; j < cs.children.length; j++) {
                            var v = cs.children[j];
                            var cleanName = v.name.indexOf('=') !== -1 ? v.name.split('=').pop().trim() : v.name;
                            variants.push({ name: cleanName, width: Math.round(v.width), height: Math.round(v.height) });
                        }
                    }
                }
                break;
            }
        } catch (e) { }
    }

    figma.ui.postMessage({
        type: "MASTER_INFO", found: true,
        name: node.name,
        width: Math.round(node.width), height: Math.round(node.height),
        variants: variants,
    });
}

// ─── Scan page for all top-level frames as templates ──────────────────────────

async function scanTemplates() {
    var page = figma.currentPage;
    var templates = [];

    // Find the master Template frame — top level frame containing a Component Set instance
    for (var i = 0; i < page.children.length; i++) {
        var topFrame = page.children[i];
        if (topFrame.type !== "FRAME" && topFrame.type !== "COMPONENT") continue;

        // Look for an INSTANCE inside that has a Component Set
        var instances = topFrame.findAll(function (n) { return n.type === "INSTANCE"; });
        for (var j = 0; j < instances.length; j++) {
            try {
                var mc = await instances[j].getMainComponentAsync();
                if (mc && mc.parent && mc.parent.type === "COMPONENT_SET") {
                    var cs = mc.parent;
                    // Found a Component Set — extract its variants as template options
                    for (var k = 0; k < cs.children.length; k++) {
                        var v = cs.children[k];
                        var sz = extractVariantSize(v);
                        templates.push({
                            id: topFrame.id,
                            componentId: v.id,
                            name: v.name,
                            variantRawName: v.name,
                            width: sz.w,
                            height: sz.h,
                        });
                        console.log("Template variant: " + v.name + " (" + sz.w + "x" + sz.h + ")");
                    }
                    break; // only use first component set found
                }
            } catch (e) { }
            break; // only check first instance
        }
        if (templates.length > 0) break; // found the master frame
    }

    figma.ui.postMessage({ type: "TEMPLATES_LIST", templates: templates });
}

figma.on("selectionchange", function () { sendSelectionInfo(); });

// Templates were previously only scanned once when the plugin panel first opened (or on
// manual refresh), so switching to a different Figma page never updated the Template
// dropdown — a page without templates would correctly hide it, but a later page that DID
// have templates would stay hidden too, since nothing ever looked again.
figma.on("currentpagechange", function () {
    scanTemplates();
    sendSelectionInfo();
});

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async function (msg) {
    if (msg.type === "LICENSE_STATUS") {
        licenseValid = !!msg.valid;
        if (!licenseValid) {
            console.log("License check failed: " + (msg.reason || "unknown"));
        }
        return;
    }

    if (msg.type === "SAVE_DEVICE_ID") {
        await figma.clientStorage.setAsync("mr-device-id", msg.deviceId);
        return;
    }

    if (msg.type === "SAVE_LICENSE_KEY") {
        await figma.clientStorage.setAsync("mr-license-key", msg.key);
        return;
    }

    if (msg.type === "CLEAR_LICENSE_KEY") {
        await figma.clientStorage.deleteAsync("mr-license-key");
        return;
    }

    if (requiresLicense(msg.type) && !licenseValid) {
        figma.ui.postMessage({ type: "ERROR", message: "Enter a valid license key to use this feature." });
        return;
    }

    if (msg.type === "STOP_PROCESS") {
        _stopRequested = true;
        _pausedBatch = null; // hard stop — discard any resumable state, no Continue button
        figma.ui.postMessage({ type: "STOPPED", message: "Stopped by user" });
        return;
    }

    if (msg.type === "PAUSE_PROCESS") {
        _pauseRequested = true;
        figma.ui.postMessage({ type: "PAUSING", message: "Pausing…" });
        return;
    }

    if (msg.type === "GET_MASTER_INFO") { sendSelectionInfo(); return; }

    if (msg.type === "GET_TEMPLATES") {
        await scanTemplates();
        return;
    }

    if (msg.type === "SELECT_TEMPLATE") {
        var page = figma.currentPage;
        var targetFrame = null;
        for (var i = 0; i < page.children.length; i++) {
            if (page.children[i].id === msg.id) { targetFrame = page.children[i]; break; }
        }
        if (targetFrame) {
            // Store selected variant name for use during banner creation
            selectedVariantName = msg.variantRawName || msg.variantName || null;
            console.log("Selected variant: " + selectedVariantName);

            // Swap on master so canvas preview updates
            if (selectedVariantName) {
                var instances = targetFrame.findAll(function (n) { return n.type === "INSTANCE"; });
                for (var i = 0; i < instances.length; i++) {
                    try {
                        var mc = await instances[i].getMainComponentAsync();
                        if (mc && mc.parent && mc.parent.type === "COMPONENT_SET") {
                            for (var j = 0; j < mc.parent.children.length; j++) {
                                var vn = mc.parent.children[j].name;
                                var vc = vn.indexOf('=') !== -1 ? vn.split('=').pop().trim() : vn;
                                if (vn === selectedVariantName || vc === selectedVariantName) {
                                    instances[i].swapComponent(mc.parent.children[j]);
                                    break;
                                }
                            }
                            break;
                        }
                    } catch (e) { }
                }
            }
            figma.currentPage.selection = [targetFrame];
            figma.viewport.scrollAndZoomIntoView([targetFrame]);
            await sendSelectionInfo();
        }
        return;
    }

    if (msg.type === "RESIZE_BANNER") {
        _stopRequested = false;
        var width = msg.width; var height = msg.height;
        if (!width || !height || width <= 0 || height <= 0) {
            figma.ui.postMessage({ type: "ERROR", message: "Please enter valid width and height." });
            return;
        }
        var sel = getSelectedFrame();
        if (!sel.node) { figma.ui.postMessage({ type: "ERROR", message: sel.error }); return; }
        try {
            figma.ui.postMessage({ type: "LOADING" });
            var clone = await duplicateAndResize(sel.node, width, height, msg.label);
            figma.ui.postMessage({ type: "SUCCESS", message: 'Created "' + clone.name + '" (' + width + 'x' + height + ')' });
        } catch (err) {
            figma.ui.postMessage({ type: "ERROR", message: "Error: " + err.message });
        }
        return;
    }

    if (msg.type === "BATCH_RESIZE") {
        _stopRequested = false;
        _pauseRequested = false;
        _pausedBatch = null;
        var sizes = msg.sizes;
        var maxPerRow = msg.maxPerRow || 5;
        var retailerBreak = !!msg.retailerBreak;
        var verticalLayout = !!msg.verticalLayout;
        var sel = getSelectedFrame();
        if (!sel.node) { figma.ui.postMessage({ type: "ERROR", message: sel.error }); return; }

        // Identity of "this template": the frame id plus the currently selected variant
        // name, since templates are variant swaps inside the SAME frame — the frame id
        // alone never changes between templates (see SELECT_TEMPLATE).
        var packageKey = sel.node.id + "::" + (selectedVariantName || "");

        // If a DIFFERENT template was used last time, chain this new template's whole
        // package immediately to the right of the previous package, aligned to the
        // same row1 baseline — instead of anchoring to this master's own position.
        var PACKAGE_GAP = 60;
        var isNewTemplate = (_lastPackageKey !== null && packageKey !== _lastPackageKey);
        var initialAnchorX = isNewTemplate ? (_lastPackageRightX + PACKAGE_GAP) : null;
        var initialRow1Y = isNewTemplate ? _lastPackageBaselineY : null;
        console.log("[batch] packageKey=" + packageKey + " isNewTemplate=" + isNewTemplate + " anchorX=" + initialAnchorX + " row1Y=" + initialRow1Y);

        figma.ui.postMessage({ type: "LOADING", message: "Starting batch — " + sizes.length + " banners…" });
        await runBatchQueue(sel.node, sizes, maxPerRow, retailerBreak, verticalLayout, {
            startIndex: 0, done: 0, errors: 0, batchRow1Y: initialRow1Y, prevCol1: null, retailerRowFloorY: null, anchorX: initialAnchorX, packageKey: packageKey
        });
        return;
    }

    if (msg.type === "CONTINUE_BATCH") {
        if (!_pausedBatch) {
            figma.ui.postMessage({ type: "ERROR", message: "Nothing to continue — no paused batch found." });
            return;
        }
        _stopRequested = false;
        _pauseRequested = false;
        var p = _pausedBatch;
        _pausedBatch = null;
        figma.ui.postMessage({ type: "LOADING", message: "Resuming batch — " + (p.sizes.length - p.startIndex) + " banners left…" });
        await runBatchQueue(p.sel, p.sizes, p.maxPerRow, p.retailerBreak, p.verticalLayout, {
            startIndex: p.startIndex, done: p.done, errors: p.errors,
            batchRow1Y: p.batchRow1Y, prevCol1: p.prevCol1, retailerRowFloorY: p.retailerRowFloorY, anchorX: p.anchorX, packageKey: p.packageKey
        });
        return;
    }

    if (msg.type === "GET_FRAME_COUNT") {
        var sourcePage = figma.currentPage;
        var count = 0;
        for (var ci = 0; ci < sourcePage.children.length; ci++) {
            var ch = sourcePage.children[ci];
            if (ch.name.toLowerCase() !== "master" && (ch.type === "FRAME" || ch.type === "COMPONENT" || ch.type === "INSTANCE")) count++;
        }
        figma.ui.postMessage({ type: "FRAME_COUNT", count: count });
        return;
    }

    if (msg.type === "GET_TEXT_LAYERS") {
        var layers = [];
        var seenTexts = {};

        // Scan across every relevant frame, not just one — otherwise auto-matching (and
        // therefore the mapping list) only ever sees text from a single template, missing
        // fields that live in the other templates on the page.
        var canvasSelection = figma.currentPage.selection;
        var sourceNodes = [];
        if (canvasSelection && canvasSelection.length > 0) {
            for (var ci = 0; ci < canvasSelection.length; ci++) {
                var csn = canvasSelection[ci];
                if (csn.type === "FRAME" || csn.type === "COMPONENT" || csn.type === "INSTANCE") sourceNodes.push(csn);
            }
        }
        // Nothing usable selected — fall back to every top-level frame on the page
        if (sourceNodes.length === 0) {
            for (var pi = 0; pi < figma.currentPage.children.length; pi++) {
                var child = figma.currentPage.children[pi];
                if (child.name.toLowerCase() === "master") continue;
                if (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "INSTANCE") sourceNodes.push(child);
            }
        }

        for (var sn = 0; sn < sourceNodes.length; sn++) {
            var textNodes = sourceNodes[sn].findAll(function (n) { return n.type === "TEXT"; });
            for (var i = 0; i < textNodes.length; i++) {
                var txt = textNodes[i].characters.trim();
                if (!txt || seenTexts[txt]) continue; // skip empty or duplicate text
                seenTexts[txt] = true;
                console.log("TEXT LAYER [" + textNodes[i].name + "] = " + JSON.stringify(txt.substring(0, 50)) + " (from " + sourceNodes[sn].name + ")");
                layers.push({ id: textNodes[i].id, name: textNodes[i].name, text: textNodes[i].characters });
            }
        }
        console.log("Total text layers: " + layers.length + " (scanned " + sourceNodes.length + " frame(s): " + sourceNodes.map(function (n) { return n.name; }).join(", ") + ")");
        figma.ui.postMessage({ type: "TEXT_LAYERS", layers: layers });
        return;
    }

    if (msg.type === "GET_SELECTED_TEXT_LAYER") {
        var sel = figma.currentPage.selection;
        if (sel.length === 1 && sel[0].type === "TEXT") {
            figma.ui.postMessage({ type: "TEXT_LAYER_SELECTED", id: sel[0].id, name: sel[0].name });
        } else {
            figma.ui.postMessage({ type: "NO_TEXT_LAYER" });
        }
        return;
    }

    if (msg.type === "TRANSLATE_BANNERS") {
        _stopRequested = false;
        var languages = msg.languages;
        var mappings = msg.mappings;
        var rows = msg.rows;
        var sizeRules = msg.sizeRules || null; // { 'DE': [{w,h},...], ... } or null = translate all
        var selectedSizes = msg.selectedSizes || null; // [{w,h},...] from UI checkboxes

        // Override with canvas selection if user has frames selected
        var canvasSel = figma.currentPage.selection;
        if (canvasSel && canvasSel.length > 0) {
            var canvasSizes = [];
            var canvasSizeKeys = {};
            for (var csi = 0; csi < canvasSel.length; csi++) {
                var csn = canvasSel[csi];
                if (csn.type !== "FRAME" && csn.type !== "COMPONENT" && csn.type !== "INSTANCE") continue;
                var key = Math.round(csn.width) + "x" + Math.round(csn.height);
                if (!canvasSizeKeys[key]) {
                    canvasSizeKeys[key] = true;
                    canvasSizes.push({ w: Math.round(csn.width), h: Math.round(csn.height) });
                }
            }
            if (canvasSizes.length > 0) {
                selectedSizes = canvasSizes;
                console.log("Canvas selection sizes: " + canvasSizes.map(function (s) { return s.w + 'x' + s.h; }).join(', '));
            }
        }

        var sourcePageId = figma.currentPage.id;
        var sourcePage = figma.currentPage;
        var total = languages.length;
        var done = 0;

        console.log("=== TRANSLATE START ===");
        console.log("Languages: " + languages.join(', '));
        console.log("Mappings: " + JSON.stringify(Object.keys(mappings)));
        console.log("Source page: " + sourcePage.name + " (" + sourcePage.children.length + " frames)");

        // Same "does this frame survive for this language" check used below when actually
        // cloning — duplicated here (not shared) so the proven per-frame skip logic in the
        // clone loop is never touched; this copy is only used to decide which ROWS end up
        // completely empty for a language, so their vertical space can be closed up.
        function frameSurvivesForLang(sourceFrame, lang) {
            if (sourceFrame.name.toLowerCase() === "master") return false;
            if (selectedSizes && selectedSizes.length > 0) {
                var fw2 = Math.round(sourceFrame.width);
                var fh2 = Math.round(sourceFrame.height);
                var sizeMatch = false;
                for (var ssi = 0; ssi < selectedSizes.length; ssi++) {
                    if (selectedSizes[ssi].w === fw2 && selectedSizes[ssi].h === fh2) { sizeMatch = true; break; }
                }
                if (!sizeMatch) return false;
            }
            if (sizeRules && sizeRules[lang] && sizeRules[lang].length > 0) {
                var allowedSizes = sizeRules[lang];
                var fw = Math.round(sourceFrame.width);
                var fh = Math.round(sourceFrame.height);
                var frameNameLower = sourceFrame.name.toLowerCase().replace(/[_\-\s]/g, '');
                var sizeAllowed = false;
                for (var si = 0; si < allowedSizes.length; si++) {
                    var rule = allowedSizes[si];
                    if (rule.w !== fw || rule.h !== fh) continue;
                    if (rule.retailer) {
                        var retailerNorm = rule.retailer.toLowerCase().replace(/[_\-\s\.]/g, '');
                        if (frameNameLower.indexOf(retailerNorm) !== -1) { sizeAllowed = true; break; }
                        var rWords = rule.retailer.toLowerCase().split(/\s+/);
                        var allFound = true;
                        for (var ri2 = 0; ri2 < rWords.length; ri2++) {
                            if (sourceFrame.name.toLowerCase().indexOf(rWords[ri2]) === -1) { allFound = false; break; }
                        }
                        if (allFound) { sizeAllowed = true; break; }
                    } else {
                        sizeAllowed = true; break;
                    }
                }
                if (!sizeAllowed) return false;
            }
            return true;
        }

        // Group all source frames into rows by Y (shared across every language, since it's
        // based on the EN page's own layout) — used purely to detect rows that end up with
        // zero surviving frames for a given language, so that gap can be closed instead of
        // leaving a big blank space where a skipped retailer/row used to be.
        var ROW_Y_TOLERANCE = 10;
        var ROW_GAP = 60;
        var sourceRows = []; // [{ y, frames: [...], height }], sorted ascending by y
        var frameRowY = {};  // sourceFrame.id -> its row's original y
        for (var bi = 0; bi < sourcePage.children.length; bi++) {
            var bn = sourcePage.children[bi];
            if (bn.name.toLowerCase() === "master") continue;
            if (bn.type !== "FRAME" && bn.type !== "COMPONENT" && bn.type !== "INSTANCE") continue;
            var placedRow = false;
            for (var br = 0; br < sourceRows.length; br++) {
                if (Math.abs(bn.y - sourceRows[br].y) <= ROW_Y_TOLERANCE) {
                    sourceRows[br].frames.push(bn);
                    sourceRows[br].height = Math.max(sourceRows[br].height, bn.height);
                    placedRow = true;
                    break;
                }
            }
            if (!placedRow) sourceRows.push({ y: bn.y, frames: [bn], height: bn.height });
        }
        sourceRows.sort(function (a, b) { return a.y - b.y; });
        for (var br2 = 0; br2 < sourceRows.length; br2++) {
            for (var bf2 = 0; bf2 < sourceRows[br2].frames.length; bf2++) {
                frameRowY[sourceRows[br2].frames[bf2].id] = sourceRows[br2].y;
            }
        }
        console.log("Source rows for compaction: " + sourceRows.length);

        figma.ui.postMessage({ type: "TRANSLATE_PROGRESS", message: "Starting…", done: 0, total: total, detail: "0/" + total });

        for (var li = 0; li < languages.length; li++) {
            if (_stopRequested) {
                console.log("  Stopped by user after " + done + "/" + total + " languages");
                figma.ui.postMessage({ type: "TRANSLATE_DONE", message: "Stopped after " + done + "/" + total + " languages" });
                return;
            }
            var lang = languages[li];
            // Re-fetch sourcePage each iteration — figma.createPage() switches currentPage
            // Re-fetch sourcePage by ID — .find() not available on Figma children
            for (var spi = 0; spi < figma.root.children.length; spi++) {
                if (figma.root.children[spi].id === sourcePageId) { sourcePage = figma.root.children[spi]; break; }
            }
            console.log("--- Processing: " + lang + " (" + (li + 1) + "/" + total + ") source=" + sourcePage.name);
            var langTranslations = rows[lang];
            if (!langTranslations) {
                console.log("  No translations found for: " + lang);
                done++; continue;
            }

            // If a masterfile was uploaded, it's meant to restrict which sizes get
            // created per language. If this language isn't in it at all (undefined —
            // e.g. a code mismatch between the masterfile and the translation file)
            // or it's explicitly listed with 0 rules, that means NO banners should be
            // created for it — skip entirely rather than falling through to
            // "no restriction", which used to translate everything unfiltered.
            if (sizeRules && (sizeRules[lang] === undefined || sizeRules[lang] === null || sizeRules[lang].length === 0)) {
                console.log("  Skipping " + lang + " — masterfile has 0 size+retailer rules for it");
                figma.ui.postMessage({ type: "TRANSLATE_PROGRESS", message: lang + ": 0 banners in masterfile, skipped", done: done, total: total, detail: lang + " skipped" });
                done++; continue;
            }

            // Find or create page
            var targetPage = null;
            for (var pi = 0; pi < figma.root.children.length; pi++) {
                if (figma.root.children[pi].name === lang) { targetPage = figma.root.children[pi]; break; }
            }
            if (!targetPage) {
                targetPage = figma.createPage();
                targetPage.name = lang;
                console.log("  Created new page: " + lang);
            } else {
                while (targetPage.children.length > 0) targetPage.children[0].remove();
                console.log("  Cleared existing page: " + lang);
            }

            // Compute this language's row-Y remap: walk the shared row groups in original
            // order, skip any row where nothing survives (closing its gap), and stack the
            // surviving rows back-to-back starting from the first surviving row's own Y.
            var rowYRemap = {};
            var compactCursorY = null;
            for (var cr = 0; cr < sourceRows.length; cr++) {
                var crow = sourceRows[cr];
                var anySurvive = false;
                for (var cf = 0; cf < crow.frames.length; cf++) {
                    if (frameSurvivesForLang(crow.frames[cf], lang)) { anySurvive = true; break; }
                }
                if (!anySurvive) continue;
                if (compactCursorY === null) compactCursorY = crow.y;
                rowYRemap[crow.y] = compactCursorY;
                compactCursorY += crow.height + ROW_GAP;
            }

            // Clone frames
            console.log("  Cloning " + sourcePage.children.length + " frames…");
            for (var fi = 0; fi < sourcePage.children.length; fi++) {
                if (_stopRequested) {
                    console.log("  Stopped by user mid-language (" + lang + "), after " + done + "/" + total + " languages");
                    figma.ui.postMessage({ type: "TRANSLATE_DONE", message: "Stopped during " + lang + " (" + done + "/" + total + " languages complete)" });
                    return;
                }
                var sourceFrame = sourcePage.children[fi];
                // Skip frames named "Master"
                if (sourceFrame.name.toLowerCase() === "master") {
                    console.log("  Skipping Master frame");
                    continue;
                }
                // Check selectedSizes — user manually selected specific sizes in UI
                if (selectedSizes && selectedSizes.length > 0) {
                    var fw2 = Math.round(sourceFrame.width);
                    var fh2 = Math.round(sourceFrame.height);
                    var sizeMatch = false;
                    for (var ssi = 0; ssi < selectedSizes.length; ssi++) {
                        if (selectedSizes[ssi].w === fw2 && selectedSizes[ssi].h === fh2) { sizeMatch = true; break; }
                    }
                    if (!sizeMatch) {
                        console.log("  Skipping " + sourceFrame.name + " (" + fw2 + "x" + fh2 + ") — not in selected sizes");
                        continue;
                    }
                }

                // Check sizeRules — filter by BOTH size AND retailer name in frame name
                if (sizeRules && sizeRules[lang] && sizeRules[lang].length > 0) {
                    var allowedSizes = sizeRules[lang];
                    var fw = Math.round(sourceFrame.width);
                    var fh = Math.round(sourceFrame.height);
                    var frameNameLower = sourceFrame.name.toLowerCase().replace(/[_\-\s]/g, '');
                    var sizeAllowed = false;
                    for (var si = 0; si < allowedSizes.length; si++) {
                        var rule = allowedSizes[si];
                        if (rule.w !== fw || rule.h !== fh) continue; // size must match first
                        if (rule.retailer) {
                            // Retailer must also appear in frame name
                            var retailerNorm = rule.retailer.toLowerCase().replace(/[_\-\s\.]/g, '');
                            if (frameNameLower.indexOf(retailerNorm) !== -1) {
                                sizeAllowed = true;
                                console.log("  Allow: " + sourceFrame.name + " matched retailer=" + rule.retailer);
                                break;
                            }
                            // Word-by-word fallback for multi-word retailers e.g. "Nido Di Grazia"
                            var rWords = rule.retailer.toLowerCase().split(/\s+/);
                            var allFound = true;
                            for (var ri2 = 0; ri2 < rWords.length; ri2++) {
                                if (sourceFrame.name.toLowerCase().indexOf(rWords[ri2]) === -1) { allFound = false; break; }
                            }
                            if (allFound) { sizeAllowed = true; break; }
                        } else {
                            // No retailer in rule — size match alone is enough
                            sizeAllowed = true; break;
                        }
                    }
                    if (!sizeAllowed) {
                        console.log("  Skipping " + sourceFrame.name + " (" + fw + "x" + fh + ") — no matching size+retailer for " + lang);
                        continue;
                    }
                }
                var cloned = sourceFrame.clone();
                targetPage.appendChild(cloned);
                cloned.x = sourceFrame.x;
                var origRowY = frameRowY[sourceFrame.id];
                cloned.y = (origRowY !== undefined && rowYRemap[origRowY] !== undefined) ? rowYRemap[origRowY] : sourceFrame.y;
                // Replace language code suffix (e.g. _EN → _DE), or append if not found
                var baseName = sourceFrame.name.replace(/([_-])([A-Z]{2})$/i, '');
                var oldLangMatch = sourceFrame.name.match(/[_-]([A-Z]{2})$/i);
                var sep = oldLangMatch ? sourceFrame.name.charAt(sourceFrame.name.length - 3) : '_';
                cloned.name = baseName + sep + lang;
                console.log("  Frame [" + cloned.name + "] cloned");

                // Replace text
                for (var colName in mappings) {
                    var mapping = mappings[colName];
                    var translatedText = langTranslations[colName];
                    if (!translatedText) {
                        console.log("    No translation for col: " + colName);
                        continue;
                    }

                    var textNodes = cloned.findAll(function (n) { return n.type === "TEXT"; });
                    var sourceNode = null;
                    try { sourceNode = figma.getNodeById(mapping.id); } catch (e) { }
                    var targetName = sourceNode ? sourceNode.name : mapping.name;
                    console.log("    Looking for layer [" + targetName + "] to set: " + translatedText.substring(0, 30));

                    // Also try matching by original text content (colName = EN text for Format B)
                    var found = false;
                    for (var ti = 0; ti < textNodes.length; ti++) {
                        var tn = textNodes[ti];
                        // Match by layer name OR by current text content matching the EN source text
                        var nameMatch = tn.name === targetName;
                        var textMatch = tn.characters && tn.characters.trim() === colName.trim();
                        if (nameMatch || textMatch) {
                            if (!nameMatch) console.log("    Matched by text content: [" + tn.name + "] = " + tn.characters.substring(0, 30));
                            var textNode = textNodes[ti];
                            try {
                                // Load all fonts used in this node
                                if (textNode.fontName !== figma.mixed) {
                                    await figma.loadFontAsync(textNode.fontName);
                                } else {
                                    var fonts = {};
                                    for (var ci = 0; ci < textNode.characters.length; ci++) {
                                        var fn = textNode.getRangeFontName(ci, ci + 1);
                                        if (fn !== figma.mixed) fonts[JSON.stringify(fn)] = fn;
                                    }
                                    for (var fkey in fonts) { await figma.loadFontAsync(fonts[fkey]); }
                                }

                                // Snapshot original character styles (font, size, lineHeight) before replacing
                                var origLen = textNode.characters.length;
                                var origLineHeight = textNode.lineHeight; // snapshot node-level lineHeight
                                var charStyles = [];
                                for (var si = 0; si < origLen; si++) {
                                    charStyles.push({
                                        font: textNode.getRangeFontName(si, si + 1),
                                        size: textNode.getRangeFontSize(si, si + 1),
                                    });
                                }

                                // Replace text
                                textNode.characters = translatedText;
                                var newLen = textNode.characters.length;

                                // Calculate font scale ratio based on text length change
                                // Longer translation → smaller font, shorter → bigger font
                                // Capped between 70% and 130% of original size
                                var lengthRatio = origLen > 0 ? origLen / newLen : 1;
                                var fontScale = Math.max(0.70, Math.min(1.30, lengthRatio));
                                console.log("    font scale: " + origLen + " EN chars → " + newLen + " translated chars, scale=" + fontScale.toFixed(2));

                                // Reapply character styles with scaled font size
                                for (var ni = 0; ni < newLen; ni++) {
                                    var origIdx = Math.min(Math.round(ni / newLen * origLen), origLen - 1);
                                    var style = charStyles[origIdx];
                                    try {
                                        if (style && style.font !== figma.mixed) {
                                            await figma.loadFontAsync(style.font);
                                            textNode.setRangeFontName(ni, ni + 1, style.font);
                                        }
                                        if (style && typeof style.size === 'number') {
                                            var scaledSize = Math.round(style.size * fontScale * 10) / 10;
                                            scaledSize = Math.max(10, scaledSize);
                                            textNode.setRangeFontSize(ni, ni + 1, scaledSize);
                                        }
                                    } catch (e) { }
                                }

                                // Scale line-height by same ratio (only for PIXELS unit)
                                try {
                                    var lh = origLineHeight;
                                    if (lh && lh !== figma.mixed && lh.unit === 'PIXELS') {
                                        var scaledLH = Math.round(lh.value * fontScale * 10) / 10;
                                        scaledLH = Math.max(14, scaledLH);
                                        textNode.lineHeight = { unit: 'PIXELS', value: scaledLH };
                                        console.log("    lineHeight: " + lh.value + " → " + scaledLH);
                                    }
                                } catch (e) { }

                                console.log("    ✓ Set [" + targetName + "] = " + translatedText.substring(0, 30));
                                found = true;
                            } catch (e) { console.error("    ✗ Error setting [" + targetName + "]:", e); }
                            break;
                        }
                    }
                    if (!found) console.log("    ✗ Layer not found: " + targetName);
                }

                // ── POST-TRANSLATION SIZING RULES ──────────────────────────────────────
                // Rule 1: all TEXT nodes → FIXED width
                // Rule 2: ABSOLUTE frame that contains a CTA → HUG width
                var allTranslatedNodes = cloned.findAll(function (n) { return true; });

                // Rule 1: all text → FIXED
                for (var tri = 0; tri < allTranslatedNodes.length; tri++) {
                    var tn = allTranslatedNodes[tri];
                    if (tn.type !== "TEXT") continue;
                    try {
                        if (tn.layoutSizingHorizontal !== undefined) {
                            tn.layoutSizingHorizontal = "FIXED";
                        }
                    } catch (e) { }
                }

                // Rule 2: absolute frame containing CTA → HUG
                for (var tri = 0; tri < allTranslatedNodes.length; tri++) {
                    var tn = allTranslatedNodes[tri];
                    if (tn.layoutPositioning !== "ABSOLUTE") continue;
                    try {
                        // Check if this absolute frame has any CTA descendant
                        var hasCTA = tn.findAll(function (c) {
                            return c.name.toLowerCase().indexOf("cta") !== -1;
                        }).length > 0;
                        if (hasCTA && tn.layoutSizingHorizontal !== undefined) {
                            tn.layoutSizingHorizontal = "HUG";
                            console.log("    [translate-sizing] HUG absolute (has CTA): " + tn.name);
                        }
                    } catch (e) { }
                }
            }

            // ── SET CTA AND CHILDREN TO HUG WIDTH (after translation) ─────────
            for (var fi = 0; fi < targetPage.children.length; fi++) {
                var tf = targetPage.children[fi];
                if (!tf.findAll) continue;
                var ctaNodes = tf.findAll(function (n) {
                    return n.name.toLowerCase().indexOf("cta") !== -1;
                });
                for (var ci = 0; ci < ctaNodes.length; ci++) {
                    var ctaNode = ctaNodes[ci];
                    try {
                        var ctaLocked = ctaNode.locked;
                        if (ctaLocked) ctaNode.locked = false;
                        if (ctaNode.layoutSizingHorizontal !== undefined) ctaNode.layoutSizingHorizontal = "HUG";
                        if (ctaLocked) ctaNode.locked = true;
                    } catch (e) { }
                    if (!ctaNode.findAll) continue;
                    var ctaKids = ctaNode.findAll(function (c) { return true; });
                    for (var ki = 0; ki < ctaKids.length; ki++) {
                        try {
                            var kLocked = ctaKids[ki].locked;
                            if (kLocked) ctaKids[ki].locked = false;
                            if (ctaKids[ki].layoutSizingHorizontal !== undefined) ctaKids[ki].layoutSizingHorizontal = "HUG";
                            if (kLocked) ctaKids[ki].locked = true;
                        } catch (e) { }
                    }
                }
            }

            // Note: frame positions are already set above (cloned.x = sourceFrame.x,
            // cloned.y = sourceFrame.y), which exactly preserves the EN page's layout —
            // including the side-by-side template packages. A "REALIGN" step used to run
            // here and re-flow every frame into a generic 5-per-row grid, which discarded
            // that layout entirely and collapsed everything into one long stacked column.
            // Removed so translated pages keep the same alignment as EN.

            done++;
            console.log("  Done: " + lang + " (" + done + "/" + total + ")");
            figma.ui.postMessage({ type: "TRANSLATE_PROGRESS", message: "Translating…", done: done, total: total, detail: lang + " ✓" });
        }

        console.log("=== TRANSLATE COMPLETE: " + done + "/" + total + " ===");
        figma.ui.postMessage({ type: "TRANSLATE_DONE", message: "✓ Created " + done + " language pages" });
        return;
    }

    if (msg.type === "GET_PAGES") {
        try { await figma.loadAllPagesAsync(); } catch (e) { }
        var pageNames = [];
        console.log("GET_PAGES: figma.root.children.length=" + figma.root.children.length);
        for (var pi = 0; pi < figma.root.children.length; pi++) {
            console.log("  page[" + pi + "]: " + figma.root.children[pi].name);
            pageNames.push(figma.root.children[pi].name);
        }
        console.log("Sending PAGES_LIST with " + pageNames.length + " pages");
        figma.ui.postMessage({ type: "PAGES_LIST", pages: pageNames });
        return;
    }

    if (msg.type === "EXPORT_BANNERS") {
        _stopRequested = false;
        _pauseRequested = false;
        _pausedExport = null;
        var scope = msg.scope;
        var format = msg.format;
        var scale = msg.scale || 1;
        var languages = msg.languages || [];

        function isMasterFrame(name) { return /local[_\s]?master/i.test(name); }

        // Extract the "group" segment from a frame name — the token immediately before
        // the WxH size, e.g. "Growline" in "EMEA_Nighti-26_Web-banners_Babymarkt.de_
        // Growline_600x350_DE", or "Image-1" in "..._Image-1_1920x1080px_EN". Splitting
        // on underscores (rather than a single regex) keeps hyphenated tokens like
        // "Image-1" intact instead of chopping them at the hyphen.
        function extractGroupSegment(name) {
            var segments = name.split('_');
            for (var gi = 1; gi < segments.length; gi++) {
                if (/^\d+\s*[x\u00D7]\s*\d+(?:px)?$/i.test(segments[gi])) {
                    return segments[gi - 1] || null;
                }
            }
            return null;
        }

        console.log("=== EXPORT START scope=" + scope + " format=" + format + " scale=" + scale + " langs=" + languages.join(','));

        var tasks = []; // flat list of { node, folder } to export, in order

        if (scope === "selected") {
            var sel = figma.currentPage.selection;
            if (!sel.length) { figma.ui.postMessage({ type: "EXPORT_ERROR", message: "No frames selected" }); return; }

            // Build ID set of all selected nodes
            var selIds = {};
            for (var i = 0; i < sel.length; i++) selIds[sel[i].id] = true;

            // Filter out wrapper frames — a wrapper is a frame whose direct children are also selected
            var exportNodes = [];
            for (var i = 0; i < sel.length; i++) {
                var nd = sel[i];
                if (nd.type !== "FRAME" && nd.type !== "COMPONENT" && nd.type !== "INSTANCE" && nd.type !== "GROUP") {
                    continue; // skip non-frame nodes
                }
                var isWrapper = false;
                if (nd.children) {
                    for (var ci = 0; ci < nd.children.length; ci++) {
                        if (selIds[nd.children[ci].id]) { isWrapper = true; break; }
                    }
                }
                if (isWrapper) {
                    console.log("[export] skip wrapper: " + nd.name + " (children are selected individually)");
                } else {
                    exportNodes.push(nd);
                }
            }

            // Fallback: if everything was filtered (single wrapper selected), export its children
            if (exportNodes.length === 0 && sel.length === 1 && sel[0].children) {
                for (var ci = 0; ci < sel[0].children.length; ci++) {
                    var ch = sel[0].children[ci];
                    if (ch.type === "FRAME" || ch.type === "COMPONENT" || ch.type === "INSTANCE") {
                        exportNodes.push(ch);
                    }
                }
                console.log("[export] exporting " + exportNodes.length + " children of single wrapper");
            }

            console.log("[export] total frames to export: " + exportNodes.length + " (from " + sel.length + " selected)");
            for (var eni = 0; eni < exportNodes.length; eni++) {
                var enNode = exportNodes[eni];
                var enGroup = extractGroupSegment(enNode.name);
                tasks.push({ node: enNode, folder: enGroup || "" });
            }

        } else {
            // Must load all pages first with dynamic-page access
            console.log("Loading all pages async...");
            try { await figma.loadAllPagesAsync(); } catch (e) { console.log("loadAllPagesAsync not needed: " + e); }

            var pages = figma.root.children;
            var selectedPages = [];
            for (var pi = 0; pi < pages.length; pi++) {
                console.log("Checking page: " + pages[pi].name + " children=" + pages[pi].children.length);
                if (languages.length === 0 || languages.indexOf(pages[pi].name) !== -1) {
                    selectedPages.push(pages[pi]);
                }
            }
            console.log("Selected pages: " + selectedPages.map(function (p) { return p.name; }).join(', '));

            for (var pi2 = 0; pi2 < selectedPages.length; pi2++) {
                var page = selectedPages[pi2];
                for (var fi = 0; fi < page.children.length; fi++) {
                    if (isMasterFrame(page.children[fi].name)) {
                        console.log("  Skip master: " + page.children[fi].name);
                        continue;
                    }
                    var pageFrameNode = page.children[fi];
                    var pageGroup = extractGroupSegment(pageFrameNode.name);
                    var pageFolder = pageGroup ? (page.name + "/" + pageGroup) : page.name;
                    tasks.push({ node: pageFrameNode, folder: pageFolder });
                }
            }
            console.log("Total exportable frames: " + tasks.length);
        }

        figma.ui.postMessage({ type: "EXPORT_PROGRESS", message: "Exporting " + tasks.length + " frames…", done: 0, total: tasks.length, detail: "Starting…" });
        await runExportQueue(tasks, format, scale, { startIndex: 0, done: 0, total: tasks.length });
        return;
    }

    if (msg.type === "CONTINUE_EXPORT") {
        if (!_pausedExport) {
            figma.ui.postMessage({ type: "EXPORT_ERROR", message: "Nothing to continue — no paused export found." });
            return;
        }
        _stopRequested = false;
        _pauseRequested = false;
        var pe = _pausedExport;
        _pausedExport = null;
        figma.ui.postMessage({ type: "EXPORT_PROGRESS", message: "Resuming export — " + (pe.total - pe.startIndex) + " frames left…", done: pe.done, total: pe.total, detail: "Resuming…" });
        await runExportQueue(pe.tasks, pe.format, pe.scale, { startIndex: pe.startIndex, done: pe.done, total: pe.total });
        return;
    }
};