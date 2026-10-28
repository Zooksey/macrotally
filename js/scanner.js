/**
 * MacroTally — camera barcode scanning.
 * Native BarcodeDetector when it supports EAN-13, otherwise ZXing (UMD) loaded lazily from a CDN.
 */

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const CONSTRAINTS = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false
};

let zxingPromise = null;

/** Load the ZXing UMD bundle once (retryable after failure). */
function loadZXing() {
  if (globalThis.ZXing) return Promise.resolve(globalThis.ZXing);
  if (!zxingPromise) {
    zxingPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ZXING_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => (globalThis.ZXing ? resolve(globalThis.ZXing) : reject(new Error('Barcode scanner failed to load.')));
      s.onerror = () => {
        s.remove();
        reject(new Error('Could not load the barcode scanner. Check your connection, or type the barcode instead.'));
      };
      document.head.appendChild(s);
    }).catch((e) => {
      zxingPromise = null;
      throw e;
    });
  }
  return zxingPromise;
}

/** Map getUserMedia errors to friendly messages. */
function cameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return new Error('Camera permission was denied. Allow camera access for this site in your browser settings, or type the barcode instead.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new Error('No camera found on this device. Type the barcode instead.');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new Error('The camera is in use by another app or could not start. Close other camera apps and try again.');
  }
  return new Error('Could not start the camera. Type the barcode instead.');
}

/** Whether native BarcodeDetector can read EAN-13. */
async function nativeFormats() {
  try {
    const BD = globalThis.BarcodeDetector;
    if (!BD || typeof BD.getSupportedFormats !== 'function') return null;
    const supported = await BD.getSupportedFormats();
    if (!Array.isArray(supported) || !supported.includes('ean_13')) return null;
    return NATIVE_FORMATS.filter((f) => supported.includes(f));
  } catch {
    return null;
  }
}

/**
 * Whether camera scanning can work here (secure context + getUserMedia).
 * @returns {boolean}
 */
export function scannerSupported() {
  return !!(globalThis.isSecureContext && globalThis.navigator?.mediaDevices?.getUserMedia);
}

/**
 * Start the camera and decode barcodes into the given <video>.
 * onCode(code) is called at most once, after the scanner has stopped itself.
 * @param {HTMLVideoElement} video
 * @param {(code:string)=>void} onCode
 * @param {(status:string)=>void} [onStatus]
 * @returns {Promise<() => void>} idempotent stop() that releases the camera
 * @throws {Error} friendly message when the camera is unavailable, denied, or the context is insecure
 */
export async function startScanner(video, onCode, onStatus = () => {}) {
  const status = (s) => {
    try { onStatus && onStatus(s); } catch { /* ignore UI errors */ }
  };
  if (!globalThis.isSecureContext) {
    throw new Error('The camera only works over a secure (https) connection. Type the barcode instead.');
  }
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access the camera. Type the barcode instead.');
  }
  const wasConnected = video.isConnected;

  status('Starting camera…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  } catch (e) {
    throw cameraError(e);
  }

  let stopped = false;
  let fired = false;
  let timer = null;
  let reader = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try { reader && reader.reset(); } catch { /* ignore */ }
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
    try {
      video.pause();
      video.srcObject = null;
    } catch { /* ignore */ }
  };

  const emit = (code) => {
    if (stopped || fired || !code) return;
    fired = true;
    stop();
    try { onCode(String(code)); } catch (e) { console.error(e); }
  };

  // The scanner UI may have been closed while we waited for permission.
  if (wasConnected && !video.isConnected) {
    stop();
    throw new Error('Scanner was closed.');
  }

  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.playsInline = true;
  video.muted = true;

  const formats = await nativeFormats();
  if (formats) {
    video.srcObject = stream;
    try { await video.play(); } catch { /* autoplay may resolve later */ }
    const detector = new globalThis.BarcodeDetector({ formats });
    status('Point the camera at a barcode');
    const tick = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          if (codes && codes.length && codes[0].rawValue) {
            emit(codes[0].rawValue);
            return;
          }
        }
      } catch { /* transient detect errors are ignored */ }
      if (!stopped) timer = setTimeout(tick, 200);
    };
    timer = setTimeout(tick, 200);
    return stop;
  }

  status('Loading scanner…');
  let ZX;
  try {
    ZX = await loadZXing();
  } catch (e) {
    stop();
    throw e;
  }
  if (stopped || (wasConnected && !video.isConnected)) {
    stop();
    throw new Error('Scanner was closed.');
  }
  try {
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
      ZX.BarcodeFormat.EAN_13,
      ZX.BarcodeFormat.EAN_8,
      ZX.BarcodeFormat.UPC_A,
      ZX.BarcodeFormat.UPC_E,
      ZX.BarcodeFormat.CODE_128
    ]);
    reader = new ZX.BrowserMultiFormatReader(hints, 300);
    status('Point the camera at a barcode');
    const p = reader.decodeFromStream(stream, video, (result) => {
      if (result) emit(typeof result.getText === 'function' ? result.getText() : result.text);
    });
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        if (!stopped) {
          console.warn('ZXing decode error', e);
          status('Scanner error. Type the barcode instead.');
        }
      });
    }
  } catch (e) {
    stop();
    throw new Error('Could not start the barcode scanner. Type the barcode instead.');
  }
  return stop;
}
