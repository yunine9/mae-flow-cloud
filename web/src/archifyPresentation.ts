/** 在宿主接入层连接演示状态与全屏，保留固定版本的上游文件不变。 */
export function withArchifyPresentation(html: string): string {
  const bridge = `<script>
(() => {
  const root = document.documentElement;
  const presentation = window.Archify && window.Archify.presentation;
  if (!presentation) return;
  const active = () => root.getAttribute('data-present') === 'true';
  const notify = value => parent.postMessage({ type: 'mfc:archify-presentation', active: value }, '*');
  let nativeEntered = false;
  const exit = () => {
    presentation.exit();
    notify(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  new MutationObserver(() => {
    if (!active()) { exit(); return; }
    // MutationObserver 仍在点击/F 键的用户激活期内；原生全屏由图所在文档申请。
    if (!root.requestFullscreen || !document.fullscreenEnabled) { notify(true); return; }
    root.requestFullscreen().then(() => {
      if (!active()) { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
    }).catch(() => { if (active()) notify(true); });
  }).observe(root, { attributes: true, attributeFilter: ['data-present'] });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) nativeEntered = true;
    else if (nativeEntered) { nativeEntered = false; exit(); }
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active()) {
      event.preventDefault(); event.stopImmediatePropagation(); exit();
    }
  }, true);
  window.addEventListener('message', event => {
    if (event.source === parent && event.data && event.data.type === 'mfc:archify-exit') exit();
  });
})();
</script>`;
  return html.replace(/<\/body>/i, bridge + '</body>');
}
