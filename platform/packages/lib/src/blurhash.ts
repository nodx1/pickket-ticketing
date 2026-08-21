/**
 * Convert a BlurHash string to a base64 data URL for use as
 * next/image placeholder="blur" blurDataURL.
 *
 * Renders to a tiny 32×32 canvas and exports as PNG data URL.
 * Works in both browser and SSR (falls back to empty string on server).
 */

// Inline minimal BlurHash decoder to avoid adding a runtime dependency.
// Based on https://github.com/woltapp/blurhash (MIT license).

const digitCharacters =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function decode83(str: string): number {
  let value = 0;
  for (const c of str) {
    const digit = digitCharacters.indexOf(c);
    if (digit === -1) throw new Error(`Invalid BlurHash character: ${c}`);
    value = value * 83 + digit;
  }
  return value;
}

function sRGBToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSRGB(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.round(v * 12.92 * 255 + 0.5)
    : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function decodeDC(value: number): [number, number, number] {
  return [
    sRGBToLinear((value >> 16) & 255),
    sRGBToLinear((value >> 8) & 255),
    sRGBToLinear(value & 255),
  ];
}

function decodeAC(
  value: number,
  maximumValue: number,
): [number, number, number] {
  const quantR = Math.floor(value / (19 * 19));
  const quantG = Math.floor(value / 19) % 19;
  const quantB = value % 19;
  return [
    signPow((quantR - 9) / 9, 2) * maximumValue,
    signPow((quantG - 9) / 9, 2) * maximumValue,
    signPow((quantB - 9) / 9, 2) * maximumValue,
  ];
}

function signPow(base: number, exp: number): number {
  return Math.sign(base) * Math.pow(Math.abs(base), exp);
}

function decodeBlurhash(
  blurhash: string,
  width: number,
  height: number,
): Uint8ClampedArray {
  const sizeFlag = decode83(blurhash[0]);
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;

  const quantisedMaximumValue = decode83(blurhash[1]);
  const maximumValue = (quantisedMaximumValue + 1) / 166;

  const colors: [number, number, number][] = new Array(numX * numY);
  colors[0] = decodeDC(decode83(blurhash.substring(2, 6)));
  for (let i = 1; i < numX * numY; i++) {
    colors[i] = decodeAC(
      decode83(blurhash.substring(4 + i * 2, 6 + i * 2)),
      maximumValue,
    );
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis =
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const color = colors[i + j * numX];
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const idx = 4 * (x + y * width);
      pixels[idx] = linearToSRGB(r);
      pixels[idx + 1] = linearToSRGB(g);
      pixels[idx + 2] = linearToSRGB(b);
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Convert a BlurHash to a base64 data URL.
 * Returns empty string if blurhash is null/undefined or if running on server without canvas.
 */
export function blurhashToDataURL(
  blurhash: string | null | undefined,
  width = 32,
  height = 32,
): string {
  if (!blurhash) return "";

  try {
    if (typeof document === "undefined") return "";

    const pixels = decodeBlurhash(blurhash, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  } catch {
    return "";
  }
}

/**
 * Check if a blurhash string is valid.
 */
export function isValidBlurhash(blurhash: string): boolean {
  if (!blurhash || blurhash.length < 6) return false;
  try {
    const sizeFlag = decode83(blurhash[0]);
    const numY = Math.floor(sizeFlag / 9) + 1;
    const numX = (sizeFlag % 9) + 1;
    return blurhash.length === 4 + 2 * numX * numY;
  } catch {
    return false;
  }
}
