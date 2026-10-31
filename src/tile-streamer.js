// tile-streamer.js — 2段キャッシュ方式のストリーミング
//  L1: 圧縮生データ(Int32Array)をメモリに LRU 保持 (fetch済みタイル, 既定121タイル)
//      → 再訪時は fetch なしで即展開できる。重いのはジオメトリ展開であって生データは軽い。
//  L2: GPUジオメトリは近傍 (loadRadius) だけ展開し、外れたら dispose する。
// fetch はタイル境界を跨いだ時だけ判定し、進行方向の先行タイルを優先して先読みする。
import { TILE, generateTile } from './city-data.js';

export class TileStreamer {
  constructor({ loadRadius = 2, rawCacheMax = 121, fetchTile = null, onExpand = null, onDispose = null } = {}) {
    this.loadRadius = loadRadius;
    this.rawCacheMax = rawCacheMax;
    this.fetchTile = fetchTile || (async (tx, tz) => generateTile(tx, tz)); // 実データでは fetch+MVT decode
    this.onExpand = onExpand; this.onDispose = onDispose;
    this.raw = new Map();      // key -> tile data (LRU: 挿入順)
    this.expanded = new Map(); // key -> handle (onExpandの戻り)
    this.pending = new Map();  // key -> Promise
    this.center = null;
    this.stats = { fetches: 0, cacheHits: 0, expands: 0, disposes: 0 };
  }
  key(tx, tz) { return tx + ',' + tz; }
  tileOf(x, z) { return [Math.floor(x / TILE), Math.floor(z / TILE)]; }

  async ensureRaw(tx, tz) {
    const k = this.key(tx, tz);
    if (this.raw.has(k)) { const v = this.raw.get(k); this.raw.delete(k); this.raw.set(k, v); this.stats.cacheHits++; return v; }
    if (this.pending.has(k)) return this.pending.get(k);
    this.stats.fetches++;
    const p = (async () => {
      const tile = await this.fetchTile(tx, tz);
      this.pending.delete(k);
      this.raw.set(k, tile);
      while (this.raw.size > this.rawCacheMax) { const oldest = this.raw.keys().next().value; if (this.expanded.has(oldest)) break; this.raw.delete(oldest); }
      return tile;
    })();
    this.pending.set(k, p);
    return p;
  }

  // プレイヤー位置から呼ぶ。毎フレーム呼んでも中心タイルが変わらない限り何もしない。
  update(x, z, dirX = 0, dirZ = 0) {
    const [ctx, ctz] = this.tileOf(x, z);
    if (this.center && this.center[0] === ctx && this.center[1] === ctz) return;
    this.center = [ctx, ctz];
    const R = this.loadRadius, want = new Set();
    // 進行方向に近い順に処理すると先読みが効く
    const cells = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) cells.push([ctx + dx, ctz + dz, dx * dirX + dz * dirZ]);
    cells.sort((a, b) => b[2] - a[2]);
    for (const [tx, tz] of cells) {
      const k = this.key(tx, tz); want.add(k);
      if (!this.expanded.has(k)) {
        this.ensureRaw(tx, tz).then(tile => {
          // 待っている間に範囲外へ出ていたら展開しない
          if (this.center && Math.abs(tx - this.center[0]) <= R && Math.abs(tz - this.center[1]) <= R && !this.expanded.has(k)) {
            this.expanded.set(k, this.onExpand ? this.onExpand(tile) : tile);
            this.stats.expands++;
          }
        });
      }
    }
    for (const [k, handle] of [...this.expanded]) {
      if (!want.has(k)) { if (this.onDispose) this.onDispose(handle); this.expanded.delete(k); this.stats.disposes++; }
    }
  }

  // 展開中タイルの建物AABBをまとめて返す（当たり判定・アンカー探索用）
  loadedTiles() { return [...this.expanded.values()]; }

  // ステージ切替用: 展開を全て破棄しキャッシュも空にする
  clear() {
    for (const handle of this.expanded.values()) if (this.onDispose) this.onDispose(handle);
    this.expanded.clear(); this.raw.clear(); this.pending.clear(); this.center = null;
  }
}
