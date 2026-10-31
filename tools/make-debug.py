# 起動診断版: 通常の単体版に「画面にエラーを出す診断パネル」を付けた HTML を作る。
# - クラシックスクリプト（モジュールが死んでも動く）が WebGL 可否と起動チェックポイントを表示
# - モジュール側には末尾到達マーカーを差し込む
import re
src = open('/home/hatch/workspace/tokyo-swing/dist-single/tokyo-swing-standalone.html').read()

panel = """
<script>
window.__logs = [];
window.__bootlog = function (m) {
  window.__logs.push(m);
  var el = document.getElementById('bootlog');
  if (el) el.textContent = window.__logs.join('\\n');
};
window.addEventListener('error', function (e) { window.__bootlog('ERROR: ' + (e.message || e.type) + (e.filename ? ' @' + e.filename + ':' + e.lineno : '')); });
window.addEventListener('unhandledrejection', function (e) { window.__bootlog('REJECT: ' + (e.reason && e.reason.message || e.reason)); });
document.addEventListener('DOMContentLoaded', function () {
  var d = document.createElement('div');
  d.id = 'bootlog';
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff;color:#111;font:12px monospace;padding:6px;white-space:pre-wrap;max-height:45vh;overflow:auto;border-bottom:3px solid #c00';
  d.textContent = 'bootlog 初期化...';
  document.body.appendChild(d);
  window.__bootlog('panel ok / UA: ' + navigator.userAgent.slice(0, 90));
  try {
    var c = document.createElement('canvas');
    var g2 = c.getContext('webgl2');
    window.__bootlog('WebGL2: ' + (g2 ? 'OK (' + g2.getParameter(g2.RENDERER) + ')' : 'NG'));
    if (!g2) { var g1 = c.getContext('webgl'); window.__bootlog('WebGL1: ' + (g1 ? 'OK' : 'NG')); }
  } catch (err) { window.__bootlog('WebGL check error: ' + err.message); }
  setTimeout(function () {
    window.__bootlog('file complete: ' + (window.__fileComplete ? 'YES' : 'NO（ファイルが途中で切れています）'));
    if (!window.__gameBooted) window.__bootlog('TIMEOUT: ゲーム本体が起動していません');
  }, 12000);
});
</script>
"""
assert '<script type="module">' in src
src = src.replace('<script type="module">', panel + '<script type="module">', 1)
# モジュール末尾到達マーカー（main の最後の frame(); 呼び出し）
marker = "window.__gameBooted = true; if (window.__bootlog) window.__bootlog('game module booted');\nframe();"
assert '\nframe();' in src
src = src.replace('\nframe();', '\n' + marker, 1)
# ファイル末尾の完全性センチネル（ダウンロードが途中で切れていないか判定）
sentinel = '<script>window.__fileComplete = true;</script>\n</body>'
assert '</body>' in src
src = src.replace('</body>', sentinel, 1)
open('/home/hatch/workspace/tokyo-swing/dist-single/tokyo-swing-debug.html', 'w').write(src)
print('written debug html', len(src))
