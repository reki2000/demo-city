// terrain-h.js — 標高グリッドのデコードと双線形サンプリング（terrain.js のデータを使う）
import { TERRAIN_DATA, TERRAIN_N, TERRAIN_STEP, TERRAIN_E } from './terrain.js';

const cache = {};
function grid(stage) {
  if (cache[stage]) return cache[stage];
  const b64 = TERRAIN_DATA[stage];
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const g = new Int16Array(bytes.buffer);
  cache[stage] = g;
  return g;
}

// ゲーム座標 (x,z) の標高。グリッド外は端の値を返す。データが無いステージは 0。
export function terrainH(stage, x, z) {
  const g = grid(stage);
  if (!g) return 0;
  const fx = Math.max(0, Math.min(TERRAIN_N - 1.001, (x + TERRAIN_E) / TERRAIN_STEP));
  const fz = Math.max(0, Math.min(TERRAIN_N - 1.001, (z + TERRAIN_E) / TERRAIN_STEP));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const i = iz * TERRAIN_N + ix;
  const a = g[i] / 2, b = g[i + 1] / 2, c = g[i + TERRAIN_N] / 2, d = g[i + TERRAIN_N + 1] / 2;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
