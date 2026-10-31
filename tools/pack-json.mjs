// データファイルを「数値リテラル」から「JSON.parse(テンプレート文字列)」形式に詰め替える。
// 数値配列リテラルは JS パーサが要素ごとに処理してスマホで起動が極端に遅くなるため。
// JSON は C 実装で高速に読める。元の値は tools/packed-backup/ に退避する。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const FILES = {
  'src/footprints.js': ['FOOTPRINTS'],
  'src/proads.js': ['PROADS', 'PROADS_AUX'],
  'src/roads.js': ['ROADS'],
  'src/rooftops.js': ['ROOFTOPS'],
};
mkdirSync('tools/packed-backup', { recursive: true });
for (const [file, names] of Object.entries(FILES)) {
  copyFileSync(file, 'tools/packed-backup/' + file.split('/').pop());
  const mod = await import(new URL('../' + file, import.meta.url));
  const lines = [`// ${file.split('/').pop()} — 実データ（起動高速化のため JSON.parse 形式で格納）`];
  for (const name of names) {
    const json = JSON.stringify(mod[name]);
    if (/[`\\]/.test(json) || json.includes('${')) throw new Error('unsafe chars in ' + name);
    lines.push(`export const ${name} = JSON.parse(\`${json}\`);`);
  }
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(file, 'packed');
}
