// tools/build-single.mjs — src/*.js を1枚のHTMLに畳む（配布・確認用）
//  tokyo-swing.html            : three は CDN importmap 版
//  tokyo-swing-standalone.html : three 本体まで内蔵し importmap も外部参照も無い版。
//                                file:// で直接開いても動く（Androidのファイル単体確認用）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const strip = p => readFileSync(p, 'utf8')
  .split('\n').filter(l => !l.startsWith('import ')).join('\n')
  .replace(/^export (const|class|function|let) /gm, '$1 ')
  .replace(/^export \{[^}]*\};?$/gm, '');
let main = strip('src/main.js');
if (main.includes('import(')) throw new Error('unexpected dynamic import in main.js');
const gameJs = ['src/footprints.js', 'src/roads.js', 'src/rooftops.js', 'src/proads.js', 'src/terrain.js', 'src/terrain-h.js', 'src/city-data.js', 'src/labels.js', 'src/building-geometry.js', 'src/tile-streamer.js', 'src/swing.js'].map(strip).join('\n') + '\n' + main;
const js = "import * as THREE from 'three';\n" + gameJs;
const base = readFileSync('index.html', 'utf8');
mkdirSync('dist-single', { recursive: true });

const html = base
  .replace('./src/vendor/three.module.js', 'https://unpkg.com/three@0.160.0/build/three.module.min.js') // 単体版だけCDNに戻す
  .replace('<script type="module" src="src/main.js"></script>', '<script type="module">\n' + js + '\n</script>');
writeFileSync('dist-single/tokyo-swing.html', html);
console.log('dist-single/tokyo-swing.html', html.length, 'bytes');

// --- standalone: three の export を名前空間オブジェクトに変換して同梱 ---
const threeSrc = readFileSync('src/vendor/three.module.js', 'utf8');
const exp = threeSrc.match(/export\{([^}]*)\};?\s*$/);
if (!exp) throw new Error('three export block not found');
const pairs = exp[1].split(',').map(s => s.trim()).filter(Boolean).map(item => {
  const parts = item.split(/\s+as\s+/);
  return parts.length === 2 ? [parts[1], parts[0]] : [parts[0], parts[0]];
});
const threeBody = threeSrc.slice(0, exp.index);
const ns = 'const THREE = {' + pairs.map(([pub, internal]) => JSON.stringify(pub) + ':' + internal).join(',') + '};';
// ゲーム側はブロックで包み、three 内部の短い識別子と名前が衝突しないようにする
const standaloneJs = threeBody + '\n' + ns + '\n{\n' + gameJs + '\n}\n';
const standalone = base
  .replace(/<script type="importmap">.*?<\/script>/, '')
  .replace('<script type="module" src="src/main.js"></script>', '<script type="module">\n' + standaloneJs + '</script>');
writeFileSync('dist-single/tokyo-swing-standalone.html', standalone);
console.log('dist-single/tokyo-swing-standalone.html', standalone.length, 'bytes, THREE exports:', pairs.length);
