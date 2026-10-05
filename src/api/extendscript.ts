/**
 * Helper functions for ExtendScript API
 * ExtendScript is the legacy scripting API for Photoshop
 */

import { jsxEnum, jsxString } from '../utils/jsx.js';

export const BLEND_MODES = [
  'NORMAL',
  'DISSOLVE',
  'DARKEN',
  'MULTIPLY',
  'COLORBURN',
  'LINEARBURN',
  'DARKERCOLOR',
  'LIGHTEN',
  'SCREEN',
  'COLORDODGE',
  'LINEARDODGE',
  'LIGHTERCOLOR',
  'OVERLAY',
  'SOFTLIGHT',
  'HARDLIGHT',
  'VIVIDLIGHT',
  'LINEARLIGHT',
  'PINLIGHT',
  'HARDMIX',
  'DIFFERENCE',
  'EXCLUSION',
  'SUBTRACT',
  'DIVIDE',
  'HUE',
  'SATURATION',
  'COLOR',
  'LUMINOSITY',
] as const;

export const NOISE_DISTRIBUTIONS = ['UNIFORM', 'GAUSSIAN'] as const;

export const TEXT_JUSTIFICATIONS = [
  'LEFT',
  'CENTER',
  'RIGHT',
  'LEFTJUSTIFIED',
  'CENTERJUSTIFIED',
  'RIGHTJUSTIFIED',
  'FULLYJUSTIFIED',
] as const;

export const RESAMPLE_METHODS = [
  'BICUBIC',
  'BICUBICSHARPER',
  'BICUBICSMOOTHER',
  'BILINEAR',
  'NEARESTNEIGHBOR',
  'PRESERVEDETAILS',
  'AUTOMATIC',
] as const;

export const ANCHOR_POSITIONS = [
  'TOPLEFT',
  'TOPCENTER',
  'TOPRIGHT',
  'MIDDLELEFT',
  'MIDDLECENTER',
  'MIDDLERIGHT',
  'BOTTOMLEFT',
  'BOTTOMCENTER',
  'BOTTOMRIGHT',
] as const;

const NEW_DOCUMENT_MODES = [
  'NewDocumentMode.RGB',
  'NewDocumentMode.CMYK',
  'NewDocumentMode.GRAYSCALE',
] as const;

/**
 * Helper functions for character/string ID conversion
 */
const helperFunctions = `
function cTID(s) { return app.charIDToTypeID(s); }
function sTID(s) { return app.stringIDToTypeID(s); }
`;

/**
 * Helper function to get current context information
 */
const getContextInfo = `
function getContextInfo() {
  var context = {
    hasDocument: app.documents.length > 0
  };
  
  if (context.hasDocument) {
    var doc = app.activeDocument;
    context.document = {
      name: doc.name,
      width: doc.width.as('px'),
      height: doc.height.as('px'),
      resolution: doc.resolution,
      colorMode: String(doc.mode),
      layerCount: doc.layers.length,
      hasSelection: (function() { try { return doc.selection.bounds ? true : false; } catch(e) { return false; } })()
    };
    
    if (doc.activeLayer) {
      var layer = doc.activeLayer;
      context.activeLayer = {
        name: layer.name,
        kind: String(layer.kind),
        opacity: layer.opacity,
        blendMode: String(layer.blendMode),
        visible: layer.visible,
        locked: layer.allLocked,
        isBackground: layer.isBackgroundLayer
      };
      
      // Add bounds if available
      try {
        var bounds = layer.bounds;
        context.activeLayer.bounds = {
          left: bounds[0].as('px'),
          top: bounds[1].as('px'),
          right: bounds[2].as('px'),
          bottom: bounds[3].as('px')
        };
      } catch (e) {
        // Bounds not available for some layer types
      }
    }
  }
  
  return context;
}
`;

/**
 * Resolves a "Group/Sub/Layer" path to a layer.
 *
 * Two behaviours that the previous inline walks got wrong:
 *  - a missing segment now reports the sibling names actually present, so a
 *    name mismatch is distinguishable from a wrong hierarchy;
 *  - identically named siblings are an error rather than a silent first match,
 *    which used to export art from the wrong layer with no warning. Pass an
 *    explicit 0-based index to pick one: "Group[1]/Layer".
 */
export const layerPathResolver = `
function psSiblingNames(collection) {
  var names = [];
  for (var i = 0; i < collection.length; i++) {
    names.push('"' + collection[i].name + '"' + (collection[i].typename === "LayerSet" ? "/" : ""));
  }
  return names.length ? names.join(", ") : "(none)";
}

function psResolveLayerPath(doc, path) {
  var parts = path.split('/');
  var collection = doc.layers;
  var layer = null;

  for (var p = 0; p < parts.length; p++) {
    var seg = parts[p];
    var want = -1;
    var m = seg.match(/^(.*)\\[(\\d+)\\]$/);
    if (m) { seg = m[1]; want = parseInt(m[2], 10); }

    var matches = [];
    for (var i = 0; i < collection.length; i++) {
      if (collection[i].name === seg) { matches.push(collection[i]); }
    }

    if (matches.length === 0) {
      throw new Error(
        'Layer not found at path segment: "' + seg + '" (under "' +
        (p === 0 ? "<document>" : parts.slice(0, p).join('/')) +
        '"). Siblings here: ' + psSiblingNames(collection)
      );
    }

    if (want >= 0) {
      if (want >= matches.length) {
        throw new Error(
          'Path segment "' + seg + '[' + want + ']" is out of range: only ' +
          matches.length + ' sibling(s) named "' + seg + '"'
        );
      }
      layer = matches[want];
    } else if (matches.length > 1) {
      throw new Error(
        'Path segment "' + seg + '" is ambiguous: ' + matches.length +
        ' siblings share that name. Disambiguate with "' + seg + '[0]" through "' +
        seg + '[' + (matches.length - 1) + ']"'
      );
    } else {
      layer = matches[0];
    }

    if (p < parts.length - 1) {
      if (layer.typename !== "LayerSet") {
        throw new Error('Layer "' + seg + '" is not a group');
      }
      collection = layer.layers;
    }
  }

  return layer;
}
`;

/**
 * JSON.stringify for ExtendScript, which has no JSON object. toSource() (what
 * results are otherwise sent as) leaves raw line breaks inside strings, so text
 * layers containing a newline made the whole result unparseable.
 */
export const jsonStringifyHelper = `
function psJSON(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') {
    var out = '"';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i), code = v.charCodeAt(i);
      if (c === '"' || c === '\\\\') out += '\\\\' + c;
      else if (c === '\\n') out += '\\\\n';
      else if (c === '\\r') out += '\\\\r';
      else if (c === '\\t') out += '\\\\t';
      else if (code < 32 || code === 0x2028 || code === 0x2029) out += '\\\\u' + ('000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }
  if (v instanceof Array) {
    var a = [];
    for (var j = 0; j < v.length; j++) a.push(psJSON(v[j]));
    return '[' + a.join(',') + ']';
  }
  var parts = [];
  for (var k in v) if (v.hasOwnProperty(k) && typeof v[k] !== 'function') parts.push(psJSON(k) + ':' + psJSON(v[k]));
  return '{' + parts.join(',') + '}';
}
`;

/**
 * Common ExtendScript snippets
 */
export const ExtendScriptSnippets = {
  /**
   * Get Photoshop application info
   */
  getAppInfo: () => `
    return {
      name: app.name,
      version: app.version,
      build: app.build
    };
  `,

  /**
   * Create a new document
   */
  newDocument: (
    width: number,
    height: number,
    resolution = 72,
    colorMode = 'NewDocumentMode.RGB'
  ) => `
    var doc = app.documents.add(
      UnitValue(${width}, 'px'),
      UnitValue(${height}, 'px'),
      ${resolution},
      'New Document',
      ${jsxEnum(colorMode, NEW_DOCUMENT_MODES, 'color mode')}
    );
    return { id: doc.id, name: doc.name };
  `,

  /**
   * Get active document info
   */
  getDocumentInfo: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var context = getContextInfo();
    return context;
  `,

  /**
   * Create a text layer
   */
  createTextLayer: (text: string, x = 100, y = 100, fontSize = 24) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var textLayer = doc.artLayers.add();
    textLayer.kind = LayerKind.TEXT;
    textLayer.textItem.contents = ${jsxString(text)};
    textLayer.textItem.position = [${x}, ${y}];
    textLayer.textItem.size = ${fontSize};
    
    var result = {
      created: true,
      layerName: textLayer.name,
      text: ${jsxString(text)},
      position: { x: ${x}, y: ${y} },
      fontSize: ${fontSize},
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Place an image file as a layer
   */
  placeImage: (filePath: string, x = 0, y = 0) => `
    ${helperFunctions}
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var imageFile = new File(${jsxString(filePath)});
    if (!imageFile.exists) {
      throw new Error('Image file not found: ' + ${jsxString(filePath)});
    }
    
    // Place image using ActionDescriptor
    var desc = new ActionDescriptor();
    desc.putPath(cTID('null'), imageFile);
    desc.putEnumerated(cTID('FTcs'), cTID('QCSt'), cTID('Qcsa'));
    
    var offsetDesc = new ActionDescriptor();
    offsetDesc.putUnitDouble(cTID('Hrzn'), cTID('#Pxl'), ${x});
    offsetDesc.putUnitDouble(cTID('Vrtc'), cTID('#Pxl'), ${y});
    desc.putObject(cTID('Ofst'), cTID('Ofst'), offsetDesc);
    
    executeAction(cTID('Plc '), desc, DialogModes.NO);
    
    var layer = app.activeDocument.activeLayer;
    var result = { 
      placed: true,
      layerName: layer.name,
      filePath: ${jsxString(filePath)},
      position: { x: ${x}, y: ${y} },
      layerBounds: {
        width: layer.bounds[2].as('px') - layer.bounds[0].as('px'),
        height: layer.bounds[3].as('px') - layer.bounds[1].as('px')
      },
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Open an image file as a new document
   */
  openImage: (filePath: string) => `
    var imageFile = new File(${jsxString(filePath)});
    if (!imageFile.exists) {
      throw new Error('Image file not found: ' + ${jsxString(filePath)});
    }
    
    var doc = app.open(imageFile);
    return {
      id: doc.id,
      name: doc.name,
      width: doc.width.as('px'),
      height: doc.height.as('px')
    };
  `,

  /**
   * Save document as PSD
   */
  saveAsPSD: (path: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${jsxString(path)});
    var psdOptions = new PhotoshopSaveOptions();
    psdOptions.embedColorProfile = true;
    doc.saveAs(saveFile, psdOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Save document as JPEG
   */
  saveAsJPEG: (path: string, quality = 8) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${jsxString(path)});
    var jpegOptions = new JPEGSaveOptions();
    jpegOptions.quality = ${quality};
    jpegOptions.embedColorProfile = true;
    doc.saveAs(saveFile, jpegOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Save document as PNG
   */
  saveAsPNG: (path: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var saveFile = new File(${jsxString(path)});
    var pngOptions = new PNGSaveOptions();
    pngOptions.compression = 9;
    doc.saveAs(saveFile, pngOptions, true);
    return { path: saveFile.fsName };
  `,

  /**
   * Close active document
   */
  closeDocument: (save = false) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.close(${save ? 'SaveOptions.SAVECHANGES' : 'SaveOptions.DONOTSAVECHANGES'});
    return { closed: true };
  `,

  /**
   * Create a new layer
   */
  newLayer: (name?: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.artLayers.add();
    ${name ? `layer.name = ${jsxString(name)};` : ''}
    
    var result = { 
      created: true,
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Delete active layer
   */
  deleteLayer: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    if (doc.activeLayer) {
      doc.activeLayer.remove();
      return { deleted: true };
    }
    throw new Error('No active layer');
  `,

  /**
   * Fill layer with color
   */
  fillLayer: (red: number, green: number, blue: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var color = new SolidColor();
    color.rgb.red = ${red};
    color.rgb.green = ${green};
    color.rgb.blue = ${blue};
    // Layers have no fill method (fillPath, used before, does not exist), so
    // fill through the selection like Edit > Fill does: an existing selection
    // is filled and kept, otherwise the whole layer is filled.
    var hadSelection = false;
    try { hadSelection = !!doc.selection.bounds; } catch (e) {}
    if (!hadSelection) doc.selection.selectAll();
    doc.selection.fill(color);
    if (!hadSelection) doc.selection.deselect();
    return { filled: true, scope: hadSelection ? 'selection' : 'layer' };
  `,

  /**
   * Resize image
   */
  resizeImage: (width?: number, height?: number, resample = 'BICUBIC') => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var ow = doc.width.as('px'), oh = doc.height.as('px');
    var w = ${width ?? 'null'}, h = ${height ?? 'null'};
    if (w === null && h === null) throw new Error('Pass width, height, or both');
    // Only one given: keep the aspect ratio, which callers otherwise did by hand.
    if (w === null) w = Math.round(ow * h / oh);
    if (h === null) h = Math.round(oh * w / ow);
    doc.resizeImage(
      UnitValue(w, 'px'),
      UnitValue(h, 'px'),
      null,
      ResampleMethod.${jsxEnum(resample, RESAMPLE_METHODS, 'resample method')}
    );
    return {
      from: { width: ow, height: oh },
      width: doc.width.as('px'),
      height: doc.height.as('px')
    };
  `,

  /**
   * Resize the canvas (no resampling), anchored at a position
   */
  resizeCanvas: (width?: number, height?: number, anchor = 'MIDDLECENTER') => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var ow = doc.width.as('px'), oh = doc.height.as('px');
    var w = ${width ?? 'null'}, h = ${height ?? 'null'};
    if (w === null && h === null) throw new Error('Pass width, height, or both');
    if (w === null) w = ow;
    if (h === null) h = oh;
    doc.resizeCanvas(UnitValue(w, 'px'), UnitValue(h, 'px'),
      AnchorPosition.${jsxEnum(anchor, ANCHOR_POSITIONS, 'anchor')});
    return {
      from: { width: ow, height: oh },
      width: doc.width.as('px'),
      height: doc.height.as('px')
    };
  `,

  /**
   * Get all layer names
   */
  getLayerNames: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layers = [];
    for (var i = 0; i < doc.layers.length; i++) {
      var layer = doc.layers[i];
      layers.push({
        name: layer.name,
        kind: String(layer.kind),
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: String(layer.blendMode)
      });
    }
    
    var result = {
      layerCount: layers.length,
      layers: layers,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Select layer by name
   */
  selectLayer: (name: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].name === ${jsxString(name)}) {
        doc.activeLayer = doc.layers[i];
        return { selected: true, name: doc.layers[i].name };
      }
    }
    throw new Error('Layer not found: ' + ${jsxString(name)});
  `,

  /**
   * Scale active layer to fit document (maintain aspect ratio)
   */
  fitLayerToDocument: (fillDocument = false) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot transform background layer');
    }
    
    // Get canvas dimensions
    var canvasWidth = doc.width.as('px');
    var canvasHeight = doc.height.as('px');
    
    // Get layer bounds
    var bounds = layer.bounds;
    var layerWidth = bounds[2].as('px') - bounds[0].as('px');
    var layerHeight = bounds[3].as('px') - bounds[1].as('px');
    
    // Calculate scale ratios
    var widthRatio = canvasWidth / layerWidth;
    var heightRatio = canvasHeight / layerHeight;
    
    // Choose scale factor based on fill or fit mode
    var scaleFactor;
    if (${fillDocument}) {
      // Fill: scale to cover entire canvas (may crop)
      scaleFactor = Math.max(widthRatio, heightRatio);
    } else {
      // Fit: scale to fit within canvas (may have margins)
      scaleFactor = Math.min(widthRatio, heightRatio);
    }
    
    // Apply scale
    var scalePercent = scaleFactor * 100;
    layer.resize(scalePercent, scalePercent, AnchorPosition.MIDDLECENTER);
    
    // Center the layer
    layer.translate(
      canvasWidth / 2 - (bounds[0].as('px') + layerWidth / 2),
      canvasHeight / 2 - (bounds[1].as('px') + layerHeight / 2)
    );
    
    var result = {
      fitted: true,
      mode: ${fillDocument} ? 'fill' : 'fit',
      originalSize: { width: layerWidth, height: layerHeight },
      newSize: { 
        width: layerWidth * scaleFactor, 
        height: layerHeight * scaleFactor 
      },
      scaleFactor: scaleFactor,
      scalePercent: scalePercent,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Scale active layer by percentage
   */
  scaleLayer: (scalePercent: number, centerAnchor = true) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot transform background layer');
    }
    
    var anchor = ${centerAnchor ? 'AnchorPosition.MIDDLECENTER' : 'AnchorPosition.TOPLEFT'};
    layer.resize(${scalePercent}, ${scalePercent}, anchor);
    
    return { 
      scaled: true,
      percent: ${scalePercent}
    };
  `,

  /**
   * Move/translate active layer
   */
  moveLayer: (deltaX: number, deltaY: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot move background layer');
    }
    
    layer.translate(${deltaX}, ${deltaY});
    
    return { 
      moved: true,
      deltaX: ${deltaX},
      deltaY: ${deltaY}
    };
  `,

  /**
   * Rotate active layer
   */
  rotateLayer: (degrees: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (layer.isBackgroundLayer) {
      throw new Error('Cannot rotate background layer');
    }
    
    layer.rotate(${degrees}, AnchorPosition.MIDDLECENTER);
    
    return { 
      rotated: true,
      degrees: ${degrees}
    };
  `,

  /**
   * Set layer opacity
   */
  setLayerOpacity: (opacity: number) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.opacity = ${opacity};
    
    var result = { 
      updated: true,
      property: 'opacity',
      value: layer.opacity,
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Set layer blend mode
   */
  setLayerBlendMode: (blendMode: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.blendMode = BlendMode.${jsxEnum(blendMode, BLEND_MODES, 'blend mode')};
    
    var result = { 
      updated: true,
      property: 'blendMode',
      value: String(layer.blendMode),
      layerName: layer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Set layer visibility
   */
  setLayerVisibility: (visible: boolean, path?: string) => `
    ${layerPathResolver}
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var targetPath = ${jsxString(path ?? '')};
    var layer = targetPath === "" ? doc.activeLayer : psResolveLayerPath(doc, targetPath);

    layer.visible = ${visible};

    return {
      visible: layer.visible,
      name: layer.name,
      target: targetPath === "" ? "activeLayer" : targetPath
    };
  `,

  /**
   * Lock/unlock layer
   */
  setLayerLocked: (locked: boolean) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    layer.allLocked = ${locked};
    
    return { 
      locked: layer.allLocked,
      name: layer.name
    };
  `,

  /**
   * Rename active layer
   */
  renameLayer: (newName: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    var oldName = layer.name;
    layer.name = ${jsxString(newName)};
    
    return { 
      oldName: oldName,
      newName: layer.name
    };
  `,

  /**
   * Duplicate active layer
   */
  duplicateLayer: (newName?: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    var duplicated = layer.duplicate();
    ${newName ? `duplicated.name = ${jsxString(newName)};` : ''}
    
    return { 
      originalName: layer.name,
      newName: duplicated.name
    };
  `,

  /**
   * Merge visible layers
   */
  mergeVisibleLayers: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.mergeVisibleLayers();
    
    return { 
      merged: true
    };
  `,

  /**
   * Flatten image (merge all layers)
   */
  flattenImage: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.flatten();
    
    return { 
      flattened: true
    };
  `,

  /**
   * Apply Gaussian Blur filter
   */
  applyGaussianBlur: (radius: number) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    var wasRasterized = false;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
      wasRasterized = true;
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers. Layer kind: ' + layer.kind);
    }
    
    layer.applyGaussianBlur(${radius});
    
    var result = { 
      applied: true,
      filter: 'Gaussian Blur',
      radius: ${radius},
      wasRasterized: wasRasterized,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Apply Unsharp Mask (sharpen)
   */
  applyUnsharpMask: (amount: number, radius: number, threshold: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    layer.applyUnSharpMask(${amount}, ${radius}, ${threshold});
    
    return { 
      filter: 'Unsharp Mask',
      amount: ${amount},
      radius: ${radius},
      threshold: ${threshold}
    };
  `,

  /**
   * Apply Add Noise filter
   */
  applyAddNoise: (amount: number, distribution: string, monochromatic: boolean) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    var distEnum = NoiseDistribution.${jsxEnum(distribution, NOISE_DISTRIBUTIONS, 'noise distribution')};
    layer.applyAddNoise(${amount}, distEnum, ${monochromatic});
    
    return { 
      filter: 'Add Noise',
      amount: ${amount},
      distribution: ${jsxString(distribution)},
      monochromatic: ${monochromatic}
    };
  `,

  /**
   * Apply Motion Blur filter
   */
  applyMotionBlur: (angle: number, radius: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Can only apply filters to normal (raster) layers');
    }
    
    layer.applyMotionBlur(${angle}, ${radius});
    
    return { 
      filter: 'Motion Blur',
      angle: ${angle},
      radius: ${radius}
    };
  `,

  /**
   * Adjust brightness and contrast
   */
  adjustBrightnessContrast: (brightness: number, contrast: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.adjustBrightnessContrast(${brightness}, ${contrast});
    
    return { 
      adjustment: 'Brightness/Contrast',
      brightness: ${brightness},
      contrast: ${contrast}
    };
  `,

  /**
   * Adjust hue and saturation
   */
  adjustHueSaturation: (hue: number, saturation: number, lightness: number) => {
    // The Hue/Saturation dialog only takes integers in these ranges; anything
    // else makes executeAction fail with a generic "not available" error.
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
    const h = clamp(hue, -180, 180);
    const s = clamp(saturation, -100, 100);
    const l = clamp(lightness, -100, 100);
    // The DOM has no Hue/Saturation method (adjustColorBalance, used before,
    // is Color Balance), so this replays the action the dialog records.
    return `
    ${helperFunctions}
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Hue/Saturation needs a pixel layer; active layer is ' + String(layer.kind));
    }

    var adj = new ActionDescriptor();
    adj.putInteger(cTID('H   '), ${h});
    adj.putInteger(cTID('Strt'), ${s});
    adj.putInteger(cTID('Lght'), ${l});
    var adjList = new ActionList();
    adjList.putObject(cTID('Hst2'), adj);

    var desc = new ActionDescriptor();
    desc.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    desc.putBoolean(cTID('Clrz'), false);
    desc.putList(cTID('Adjs'), adjList);
    executeAction(cTID('HStr'), desc, DialogModes.NO);

    return {
      adjustment: 'Hue/Saturation',
      hue: ${h},
      saturation: ${s},
      lightness: ${l}
    };
  `;
  },

  /**
   * Auto levels adjustment
   */
  autoLevels: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.autoLevels();
    
    return { 
      adjustment: 'Auto Levels'
    };
  `,

  /**
   * Auto contrast adjustment
   */
  autoContrast: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.autoContrast();
    
    return { 
      adjustment: 'Auto Contrast'
    };
  `,

  /**
   * Desaturate (convert to grayscale without changing color mode)
   */
  desaturate: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.desaturate();
    
    return { 
      adjustment: 'Desaturate'
    };
  `,

  /**
   * Invert colors
   */
  invert: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    // Auto-rasterize if needed
    if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
      layer.rasterize(RasterizeType.ENTIRELAYER);
    }
    
    layer.invert();
    
    return { 
      adjustment: 'Invert'
    };
  `,

  /**
   * Crop document
   */
  cropDocument: (left: number, top: number, right: number, bottom: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    var bounds = [${left}, ${top}, ${right}, ${bottom}];
    doc.crop(bounds);
    
    return { 
      cropped: true,
      newWidth: doc.width.as('px'),
      newHeight: doc.height.as('px')
    };
  `,

  /**
   * Set text layer font
   */
  setTextFont: (fontName: string, fontSize?: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.font = ${jsxString(fontName)};
    ${fontSize ? `layer.textItem.size = ${fontSize};` : ''}
    
    return { 
      font: layer.textItem.font,
      size: layer.textItem.size
    };
  `,

  /**
   * Set text color
   */
  setTextColor: (red: number, green: number, blue: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    var color = new SolidColor();
    color.rgb.red = ${red};
    color.rgb.green = ${green};
    color.rgb.blue = ${blue};
    layer.textItem.color = color;
    
    return { 
      color: 'RGB(' + ${red} + ', ' + ${green} + ', ' + ${blue} + ')'
    };
  `,

  /**
   * Set text alignment
   */
  setTextAlignment: (alignment: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.justification = Justification.${jsxEnum(alignment, TEXT_JUSTIFICATIONS, 'text alignment')};
    
    return { 
      alignment: ${jsxString(alignment)}
    };
  `,

  /**
   * Update text content
   */
  updateTextContent: (newText: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind !== LayerKind.TEXT) {
      throw new Error('Active layer is not a text layer');
    }
    
    layer.textItem.contents = ${jsxString(newText)};
    
    return { 
      text: layer.textItem.contents
    };
  `,

  /**
   * Create rectangular selection
   */
  selectRectangle: (left: number, top: number, right: number, bottom: number) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    var bounds = [[${left}, ${top}], [${right}, ${top}], [${right}, ${bottom}], [${left}, ${bottom}]];
    doc.selection.select(bounds);
    
    return { 
      selection: 'rectangle',
      bounds: [${left}, ${top}, ${right}, ${bottom}]
    };
  `,

  /**
   * Select all
   */
  selectAll: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.selectAll();
    
    return { 
      selection: 'all'
    };
  `,

  /**
   * Deselect
   */
  deselect: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.deselect();
    
    return { 
      deselected: true
    };
  `,

  /**
   * Invert selection
   */
  invertSelection: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    doc.selection.invert();
    
    return { 
      inverted: true
    };
  `,

  /**
   * Create layer mask from selection
   */
  createLayerMask: () => `
    ${helperFunctions}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    // Create mask using ActionDescriptor
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('Nw  '), ref);
    desc.putEnumerated(cTID('Usng'), cTID('UsrM'), cTID('RvlS'));
    executeAction(cTID('Mk  '), desc, DialogModes.NO);
    
    return { 
      maskCreated: true
    };
  `,

  /**
   * Delete layer mask
   */
  deleteLayerMask: () => `
    ${helperFunctions}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    executeAction(cTID('Dlt '), desc, DialogModes.NO);
    
    return { 
      maskDeleted: true
    };
  `,

  /**
   * Apply layer mask
   */
  applyLayerMask: () => `
    ${helperFunctions}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Msk '));
    desc.putReference(cTID('null'), ref);
    executeAction(cTID('Aply'), desc, DialogModes.NO);
    
    return { 
      maskApplied: true
    };
  `,

  /**
   * Play an action from Actions palette
   */
  playAction: (actionName: string, actionSetName: string) => `
    app.doAction(${jsxString(actionName)}, ${jsxString(actionSetName)});
    
    return { 
      action: ${jsxString(actionName)},
      set: ${jsxString(actionSetName)}
    };
  `,

  /**
   * Execute custom JavaScript code
   */
  executeCustomScript: (code: string) => {
    // Auto-add return to the last expression if user didn't include one
    const trimmed = code.trim();
    const lines = trimmed.split('\n');
    const lastLine = lines[lines.length - 1].trim();

    // Add return if last line is an expression (not a statement like if/for/var/return/}/;)
    const isStatement =
      /^(if|for|while|var|let|const|return|throw|try|catch|function|\/\/|\}|;$)/.test(lastLine);
    if (!isStatement && !lastLine.startsWith('return ')) {
      lines[lines.length - 1] = 'return ' + lines[lines.length - 1];
    }

    return lines.join('\n');
  },

  /**
   * Rasterize active layer
   */
  rasterizeLayer: () => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var layer = app.activeDocument.activeLayer;
    
    if (layer.kind === LayerKind.NORMAL) {
      return { 
        message: 'Layer is already rasterized',
        kind: 'NORMAL'
      };
    }
    
    var originalKind = String(layer.kind);
    layer.rasterize(RasterizeType.ENTIRELAYER);
    
    return { 
      rasterized: true,
      originalKind: originalKind,
      newKind: 'NORMAL'
    };
  `,

  /**
   * Undo last operation (step backward in history)
   */
  undo: (steps = 1) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    // Get current history state index
    var currentIndex = -1;
    for (var i = 0; i < doc.historyStates.length; i++) {
      if (doc.historyStates[i] === doc.activeHistoryState) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1) {
      throw new Error('Could not find current history state');
    }
    
    // Calculate target index
    var targetIndex = Math.max(0, currentIndex - ${steps});
    
    // Set active history state to go back
    if (targetIndex < doc.historyStates.length) {
      doc.activeHistoryState = doc.historyStates[targetIndex];
    }
    
    var result = {
      undone: true,
      steps: currentIndex - targetIndex,
      currentHistoryState: doc.activeHistoryState.name,
      remainingStates: currentIndex - targetIndex,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Redo operation (step forward in history)
   */
  redo: (steps = 1) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    
    // Get current history state index
    var currentIndex = -1;
    for (var i = 0; i < doc.historyStates.length; i++) {
      if (doc.historyStates[i] === doc.activeHistoryState) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1) {
      throw new Error('Could not find current history state');
    }
    
    // Calculate target index
    var targetIndex = Math.min(doc.historyStates.length - 1, currentIndex + ${steps});
    
    // Set active history state to go forward
    if (targetIndex >= 0) {
      doc.activeHistoryState = doc.historyStates[targetIndex];
    }
    
    var result = {
      redone: true,
      steps: targetIndex - currentIndex,
      currentHistoryState: doc.activeHistoryState.name,
      availableRedoSteps: doc.historyStates.length - 1 - targetIndex,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Get history states
   */
  getHistoryStates: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;

    var states = [];
    var currentIndex = -1;

    var hsLen = 0;
    try { hsLen = doc.historyStates.length; } catch(eLen) {
      return {
        totalStates: 0,
        currentIndex: -1,
        currentState: 'Unknown',
        canUndo: false,
        canRedo: false,
        states: [],
        error: 'Cannot access history states: ' + eLen.message,
        context: getContextInfo()
      };
    }

    var activeStateName = '';
    try { activeStateName = doc.activeHistoryState.name; } catch(eActive) {}

    for (var i = 0; i < hsLen; i++) {
      try {
        var state = doc.historyStates[i];
        var stateName = '';
        try { stateName = state.name; } catch(e2) { stateName = 'State ' + i; }
        var isSnapshot = false;
        try { isSnapshot = state.snapshot || false; } catch(e3) {}
        states.push({
          name: stateName,
          snapshot: isSnapshot
        });
        if (stateName === activeStateName) {
          currentIndex = i;
        }
      } catch(e5) {}
    }

    var result = {
      totalStates: states.length,
      currentIndex: currentIndex,
      currentState: currentIndex >= 0 ? states[currentIndex].name : 'Unknown',
      canUndo: currentIndex > 0,
      canRedo: currentIndex < states.length - 1,
      states: states,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to specific position (reorder)
   */
  moveLayerToPosition: (targetLayerName: string, position: string) => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var activeLayer = doc.activeLayer;
    
    // Find target layer
    var targetLayer = null;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].name === ${jsxString(targetLayerName)}) {
        targetLayer = doc.layers[i];
        break;
      }
    }
    
    if (!targetLayer) {
      throw new Error('Target layer not found: ' + ${jsxString(targetLayerName)});
    }
    
    // Determine ElementPlacement
    var placement;
    if (${jsxString(position)} === "ABOVE") {
      placement = ElementPlacement.PLACEBEFORE;
    } else if (${jsxString(position)} === "BELOW") {
      placement = ElementPlacement.PLACEAFTER;
    } else if (${jsxString(position)} === "TOP") {
      placement = ElementPlacement.PLACEATBEGINNING;
    } else if (${jsxString(position)} === "BOTTOM") {
      placement = ElementPlacement.PLACEATEND;
    } else {
      throw new Error('Invalid position. Use: ABOVE, BELOW, TOP, or BOTTOM');
    }
    
    // Move the layer
    activeLayer.move(targetLayer, placement);
    
    var result = {
      moved: true,
      layerName: activeLayer.name,
      position: ${jsxString(position)},
      relativeTo: targetLayer.name,
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to top of layer stack
   */
  moveLayerToTop: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (doc.layers.length > 0) {
      layer.move(doc.layers[0], ElementPlacement.PLACEBEFORE);
    }
    
    var result = {
      moved: true,
      layerName: layer.name,
      position: 'top',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer to bottom of layer stack
   */
  moveLayerToBottom: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    if (doc.layers.length > 0) {
      layer.move(doc.layers[doc.layers.length - 1], ElementPlacement.PLACEAFTER);
    }
    
    var result = {
      moved: true,
      layerName: layer.name,
      position: 'bottom',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Move layer up one position
   */
  moveLayerUp: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    // Find current layer index
    var currentIndex = -1;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i] === layer) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex <= 0) {
      return {
        moved: false,
        message: 'Layer is already at the top',
        context: getContextInfo()
      };
    }
    
    // Move before the layer above
    layer.move(doc.layers[currentIndex - 1], ElementPlacement.PLACEBEFORE);
    
    var result = {
      moved: true,
      layerName: layer.name,
      direction: 'up',
      context: getContextInfo()
    };
    return result;
  `,

  /**
   * Get full layer tree with recursive group traversal.
   * Returns the complete hierarchy including groups, nested layers,
   * text properties, bounds, and smart object flags.
   */
  getLayerTree: (rootPath?: string, maxDepth?: number) => `
    ${layerPathResolver}
    ${jsonStringifyHelper}
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var maxDepth = ${typeof maxDepth === 'number' && maxDepth > 0 ? maxDepth : -1};
    var rootPath = ${jsxString(rootPath ?? '')};

    // Walks the layer list through ActionManager, one flat pass by index, and
    // rebuilds the tree from the group start/end markers. The previous DOM
    // walk (layer.layers[i], .bounds, .kind, .textItem ...) cost a scripting
    // round trip per property and did not finish within 15 minutes on a real
    // UI document. Layers outside the requested subtree, or below max_depth,
    // only have their section marker and ID read.
    function cTID(s) { return app.charIDToTypeID(s); }
    function sTID(s) { return app.stringIDToTypeID(s); }
    function tSID(t) { return app.typeIDToStringID(t); }

    function layerRef(index, prop) {
      var r = new ActionReference();
      if (prop) r.putProperty(cTID('Prpr'), sTID(prop));
      r.putIndex(cTID('Lyr '), index);
      return r;
    }
    function getProp(index, prop) {
      try { return executeActionGet(layerRef(index, prop)); } catch (e) { return null; }
    }

    var docRef = new ActionReference();
    docRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
    var layerCount = executeActionGet(docRef).getInteger(sTID('numberOfLayers'));

    // Index 0 exists only when the document has a Background layer.
    var firstIndex = getProp(0, 'layerID') ? 0 : 1;

    var KINDS = { 1: 'LayerKind.NORMAL', 2: 'LayerKind.ADJUSTMENT', 3: 'LayerKind.TEXT',
                  4: 'LayerKind.SOLIDFILL', 5: 'LayerKind.SMARTOBJECT', 6: 'LayerKind.VIDEO',
                  7: 'GROUP', 8: 'LayerKind.3D', 9: 'LayerKind.GRADIENTFILL',
                  10: 'LayerKind.PATTERNFILL', 11: 'LayerKind.SOLIDFILL', 12: 'LayerKind.NORMAL' };
    var ALIGN = { left: 'Justification.LEFT', center: 'Justification.CENTER', right: 'Justification.RIGHT',
                  justifyLeft: 'Justification.LEFTJUSTIFIED', justifyCenter: 'Justification.CENTERJUSTIFIED',
                  justifyRight: 'Justification.RIGHTJUSTIFIED', justifyAll: 'Justification.FULLYJUSTIFIED' };

    function px(d, key) { return Math.round(d.getUnitDoubleValue(sTID(key))); }

    function readText(d) {
      try {
        var tk = d.getObjectValue(sTID('textKey'));
        var info = { content: tk.getString(cTID('Txt ')), font: null, size: null, color: null, alignment: null };
        var scale = 1;
        try { scale = tk.getObjectValue(sTID('transform')).getDouble(sTID('yy')); } catch (e) {}
        try {
          var st = tk.getList(sTID('textStyleRange')).getObjectValue(0).getObjectValue(sTID('textStyle'));
          try { info.font = st.getString(sTID('fontPostScriptName')); } catch (e) {}
          try {
            var sz = st.hasKey(sTID('impliedFontSize')) ? st.getUnitDoubleValue(sTID('impliedFontSize'))
                                                         : st.getUnitDoubleValue(sTID('size')) * scale;
            info.size = Math.round(sz * 100) / 100;
          } catch (e) {}
          try {
            var c = st.getObjectValue(sTID('color'));
            info.color = { r: Math.round(c.getDouble(cTID('Rd  '))), g: Math.round(c.getDouble(cTID('Grn '))),
                           b: Math.round(c.getDouble(cTID('Bl  '))) };
          } catch (e) {}
        } catch (e) {}
        try {
          var ps = tk.getList(sTID('paragraphStyleRange')).getObjectValue(0).getObjectValue(sTID('paragraphStyle'));
          var a = tSID(ps.getEnumerationValue(sTID('align')));
          info.alignment = ALIGN[a] || a;
        } catch (e) {}
        return info;
      } catch (e) {
        return null;
      }
    }

    function readLayer(index, depth, isGroup) {
      var d = executeActionGet(layerRef(index));
      var kind = isGroup ? 7 : (d.hasKey(sTID('layerKind')) ? d.getInteger(sTID('layerKind')) : 1);
      var info = {
        name: d.getString(cTID('Nm  ')),
        type: KINDS[kind] || ('LayerKind.' + kind),
        visible: d.getBoolean(cTID('Vsbl')),
        opacity: Math.round(d.getInteger(cTID('Opct')) / 2.55),
        blendMode: 'BlendMode.' + tSID(d.getEnumerationValue(cTID('Md  '))).toUpperCase(),
        depth: depth
      };
      try {
        var b = d.getObjectValue(sTID('bounds'));
        var l = px(b, 'left'), t = px(b, 'top'), r = px(b, 'right'), bt = px(b, 'bottom');
        info.bounds = { left: l, top: t, right: r, bottom: bt, width: r - l, height: bt - t };
      } catch (e) {
        info.bounds = null;
      }
      if (kind === 3) info.text = readText(d);
      if (kind === 5) info.isSmartObject = true;
      if (isGroup) info.children = [];
      return info;
    }

    // ActionManager reports a group's bounds as the whole canvas. The DOM
    // reported the union of its contents (hidden ones included; zero when
    // empty), so groups are given that, built up from their layers.
    function readBounds(index) {
      var d = getProp(index, 'bounds');
      if (!d) return null;
      var b = d.getObjectValue(sTID('bounds'));
      var l = px(b, 'left'), t = px(b, 'top'), r = px(b, 'right'), bt = px(b, 'bottom');
      return { left: l, top: t, right: r, bottom: bt, width: r - l, height: bt - t };
    }
    function growBounds(owners, b) {
      if (!b || b.width <= 0 || b.height <= 0) return;
      for (var k = 0; k < owners.length; k++) {
        var g = owners[k];
        if (!g.__u) { g.__u = { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; continue; }
        if (b.left < g.__u.left) g.__u.left = b.left;
        if (b.top < g.__u.top) g.__u.top = b.top;
        if (b.right > g.__u.right) g.__u.right = b.right;
        if (b.bottom > g.__u.bottom) g.__u.bottom = b.bottom;
      }
    }
    function finishGroup(g) {
      var u = g.__u || { left: 0, top: 0, right: 0, bottom: 0 };
      g.bounds = { left: u.left, top: u.top, right: u.right, bottom: u.bottom,
                   width: u.right - u.left, height: u.bottom - u.top };
      delete g.__u;
    }

    var rootId = null;
    if (rootPath !== '') {
      var rootLayer = psResolveLayerPath(doc, rootPath);
      if (rootLayer.typename !== 'LayerSet') {
        throw new Error('Layer "' + rootPath + '" is not a group, so it has no subtree');
      }
      rootId = rootLayer.id;
    }

    var result = [];
    // Each open group is a frame. collect: children are read in full and
    // added to frame.list. A truncated group's own frame counts its direct
    // children instead (counter); frames nested inside skipped regions do neither.
    // owners: reported groups that contain this frame, whose bounds grow with it.
    var stack = [{ collect: rootId === null, list: result, depth: -1, counter: null, owners: [], group: null }];

    for (var i = layerCount; i >= firstIndex; i--) {
      var sec = getProp(i, 'layerSection');
      if (!sec) continue;
      var section = tSID(sec.getEnumerationValue(sTID('layerSection')));

      if (section === 'layerSectionEnd') {
        if (stack.length > 1) {
          var closed = stack.pop();
          if (closed.group) finishGroup(closed.group);
        }
        continue;
      }
      var isGroup = section === 'layerSectionStart';
      var frame = stack[stack.length - 1];
      if (frame.counter) frame.counter.childCount++;

      if (!frame.collect) {
        if (isGroup) {
          var isRoot = rootId !== null && getProp(i, 'layerID').getInteger(sTID('layerID')) === rootId;
          stack.push(isRoot ? { collect: true, list: result, depth: -1, counter: null, owners: [], group: null }
                            : { collect: false, list: null, depth: frame.depth + 1, counter: null, owners: frame.owners, group: null });
        } else if (frame.owners.length) {
          // Below a max_depth cut: not reported, but it still sizes its group.
          growBounds(frame.owners, readBounds(i));
        }
        continue;
      }

      var depth = frame.depth + 1;
      var info = readLayer(i, depth, isGroup);
      frame.list.push(info);
      if (isGroup) {
        var owners = frame.owners.concat([info]);
        if (maxDepth > 0 && depth + 1 >= maxDepth) {
          delete info.children;
          info.childCount = 0;
          info.truncated = true;
          stack.push({ collect: false, list: null, depth: depth, counter: info, owners: owners, group: info });
        } else {
          stack.push({ collect: true, list: info.children, depth: depth, counter: null, owners: owners, group: info });
        }
      } else {
        growBounds(frame.owners, info.bounds);
      }
    }

    return psJSON({
      documentName: doc.name,
      width:  Math.round(doc.width.as('px')),
      height: Math.round(doc.height.as('px')),
      root: rootPath === '' ? null : rootPath,
      maxDepth: maxDepth > 0 ? maxDepth : null,
      layers: result
    });
  `,

  /**
   * Select a layer by its path through the group hierarchy.
   * Path format: "GroupName/SubGroupName/LayerName"
   * Also supports flat layer name (no slash).
   */
  selectLayerByPath: (path: string) => `
    ${layerPathResolver}
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = psResolveLayerPath(doc, ${jsxString(path)});

    doc.activeLayer = layer;
    return {
      selected: true,
      name: layer.name,
      type: layer.typename === "LayerSet" ? "GROUP" : String(layer.kind),
      path: ${jsxString(path)}
    };
  `,

  /**
   * Create a new layer group (folder)
   */
  createLayerGroup: (name?: string) => `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var group = doc.layerSets.add();
    ${name ? `group.name = ${jsxString(name)};` : ''}
    return {
      created: true,
      groupName: group.name
    };
  `,

  /**
   * Get Unity RectTransform values for a layer.
   * Computes anchoredPosition and sizeDelta relative to the layer's parent group
   * (or the document if the layer is top-level).
   * Y is negated to convert from PSD (Y-down) to Unity (Y-up) coordinate space.
   */
  getLayerRT: (layerPath: string, scaleFactor: number) => `
    ${layerPathResolver}
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;

    var layer = psResolveLayerPath(doc, ${jsxString(layerPath)});

    var sf = ${scaleFactor};

    // Layer bounds
    var lb = layer.bounds;
    var lLeft   = lb[0].as('px');
    var lTop    = lb[1].as('px');
    var lRight  = lb[2].as('px');
    var lBottom = lb[3].as('px');
    var lW = lRight - lLeft;
    var lH = lBottom - lTop;
    var lCX = (lLeft + lRight) / 2;
    var lCY = (lTop + lBottom) / 2;

    // Parent bounds (group or document)
    var pLeft, pTop, pRight, pBottom;
    if (layer.parent && layer.parent !== doc) {
      var pb = layer.parent.bounds;
      pLeft   = pb[0].as('px');
      pTop    = pb[1].as('px');
      pRight  = pb[2].as('px');
      pBottom = pb[3].as('px');
    } else {
      pLeft   = 0;
      pTop    = 0;
      pRight  = doc.width.as('px');
      pBottom = doc.height.as('px');
    }
    var pCX = (pLeft + pRight) / 2;
    var pCY = (pTop + pBottom) / 2;

    // Compute RT (negate Y for PSD-down → Unity-up)
    var posX  = Math.round((lCX - pCX) * sf * 100) / 100;
    var posY  = Math.round(-(lCY - pCY) * sf * 100) / 100;
    var sizeW = Math.round(lW * sf * 100) / 100;
    var sizeH = Math.round(lH * sf * 100) / 100;

    return {
      pos:  [posX, posY],
      size: [sizeW, sizeH],
      rot:  0,
      psd_bounds: {
        layer:  { left: lLeft, top: lTop, right: lRight, bottom: lBottom, width: lW, height: lH },
        parent: { left: pLeft, top: pTop, right: pRight, bottom: pBottom }
      },
      scale_factor: sf
    };
  `,

  /**
   * Move layer down one position
   */
  moveLayerDown: () => `
    ${getContextInfo}
    
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    
    // Find current layer index
    var currentIndex = -1;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i] === layer) {
        currentIndex = i;
        break;
      }
    }
    
    if (currentIndex === -1 || currentIndex >= doc.layers.length - 1) {
      return {
        moved: false,
        message: 'Layer is already at the bottom',
        context: getContextInfo()
      };
    }
    
    // Move after the layer below
    layer.move(doc.layers[currentIndex + 1], ElementPlacement.PLACEAFTER);
    
    var result = {
      moved: true,
      layerName: layer.name,
      direction: 'down',
      context: getContextInfo()
    };
    return result;
  `,
};

/**
 * Generate ExtendScript code with error handling
 */
export function generateExtendScript(code: string): string {
  return `
(function() {
  try {
    ${code}
  } catch (error) {
    return 'ERROR: ' + (error.message || String(error));
  }
})();
  `.trim();
}
