/**
 * CSS colour → RGB components in 0..1, which is what PDF operators take.
 *
 * Only the forms this editor actually produces are parsed — hex and
 * rgb()/rgba() — plus a handful of names, with black as the fallback. A colour
 * that fails to parse should render as something rather than abort an export.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  grey: "#808080",
  gray: "#808080",
  transparent: "rgba(0,0,0,0)",
};

export function parseColor(input: string | undefined): Rgb {
  const fallback: Rgb = { r: 0, g: 0, b: 0, a: 1 };
  if (!input) return fallback;

  let value = input.trim().toLowerCase();
  if (NAMED[value]) value = NAMED[value]!;

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = [...hex].map((c) => parseInt(c + c, 16));
      return { r: r! / 255, g: g! / 255, b: b! / 255, a: a === undefined ? 1 : a / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const pair = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return {
        r: pair(0) / 255,
        g: pair(2) / 255,
        b: pair(4) / 255,
        a: hex.length === 8 ? pair(6) / 255 : 1,
      };
    }
    return fallback;
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/).filter(Boolean);
    const channel = (raw: string | undefined) => {
      if (!raw) return 0;
      const n = parseFloat(raw);
      return raw.endsWith("%") ? n / 100 : n / 255;
    };
    const alphaRaw = parts[3];
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw),
    };
  }
  return fallback;
}

/** PDF wants at most a few decimals; trailing zeros only bloat the file. */
export function num(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(decimals));
  return String(rounded === 0 ? 0 : rounded);
}
