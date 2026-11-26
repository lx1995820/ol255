// 球员卡面头像库维护（管理员）：图库列表 / 搜索 / 改名修正 / 删除 / 待标注认领
// 识别到的头像指纹未命中图库时进入待标注队列，管理员在此点名入库（如"06姚明"），后续自动识别
export function initializeAvatarsAdmin(api, escapeHtml) {
  const root = document.querySelector('#avatarsAdmin');
  if (!root) return;
  const $ = s => root.querySelector(s);
  root.innerHTML = `
    <div class="card-title"><div><p class="eyebrow">AVATAR LIBRARY</p><h2>卡面头像库 <small>识别到的头像 → 卡面名映射（如 06姚明）</small></h2></div><span class="public-note">识别自动匹配 · 未识别的待你点名</span></div>
    <p class="field-help">AI 识别入库时会自动提取每场的 10 个头像并与图库比对：命中即在比赛记录挂上卡面名；未命中的进入下方「待标注」，填写卡面名后入库，下次自动识别。同一卡面在不同设备截图可能各成一条，均指向同一名字即可。</p>
    <div class="avatar-toolbar"><input id="avatarSearch" class="search" placeholder="搜索卡面名或指纹…" autocomplete="off"><button type="button" class="ghost" id="avatarReload">刷新</button></div>
    <h3 class="avatar-sub">待标注（<span id="pendingCount">0</span>）</h3>
    <div id="avatarPending" class="avatar-grid"></div>
    <h3 class="avatar-sub">图库（<span id="libraryCount">0</span>）</h3>
    <div id="avatarLibrary" class="avatar-grid"></div>
    <p id="avatarStatus" class="field-help" role="status"></p>`;

  let library = [], pending = [];
  const status = $('#avatarStatus');

  const render = () => {
    const q = $('#avatarSearch').value.trim().toLowerCase();
    const lib = library.filter(a => !q || a.cardName.toLowerCase().includes(q) || a.phash.includes(q));
    const pen = pending.filter(p => !q || p.phash.includes(q));
    $('#libraryCount').textContent = library.length;
    $('#pendingCount').textContent = pending.length;
    $('#avatarLibrary').innerHTML = lib.map(a => `
      <figure class="avatar-item" data-id="${a.id}">
        ${a.image ? `<img src="${a.image}" alt="${escapeHtml(a.cardName)}" loading="lazy">` : '<div class="avatar-noimg">无图</div>'}
        <figcaption>
          <input class="avatar-name" value="${escapeHtml(a.cardName)}" maxlength="60" aria-label="卡面名">
          <div class="avatar-ops"><button type="button" class="row-btn" data-save="${a.id}">保存</button><button type="button" class="row-btn" data-del="${a.id}">删除</button></div>
        </figcaption>
      </figure>`).join('') || '<p class="empty">图库为空，待标注区点名后自动出现在这里。</p>';
    $('#avatarPending').innerHTML = pen.map(p => `
      <figure class="avatar-item pending" data-key="${escapeHtml(p.key)}">
        ${p.image ? `<img src="${p.image}" alt="待标注头像" loading="lazy">` : '<div class="avatar-noimg">无图</div>'}
        <figcaption>
          <input class="avatar-name" placeholder="如：06姚明" maxlength="60" aria-label="卡面名">
          <div class="avatar-ops"><button type="button" class="row-btn" data-label="${escapeHtml(p.key)}">入库</button><button type="button" class="row-btn" data-dismiss="${escapeHtml(p.key)}">忽略</button></div>
        </figcaption>
      </figure>`).join('') || '<p class="empty">没有待标注的头像。</p>';

    root.querySelectorAll('[data-save]').forEach(btn => btn.onclick = async () => {
      const id = Number(btn.dataset.save);
      const input = root.querySelector(`[data-id="${id}"] .avatar-name`);
      const cardName = input.value.trim();
      if (!cardName) { status.textContent = '卡面名不能为空。'; return; }
      btn.disabled = true;
      try {
        await api('admin/avatars', { method: 'PUT', body: JSON.stringify({ id, cardName }) });
        const item = library.find(a => a.id === id);
        if (item) item.cardName = cardName;
        status.textContent = `已保存：指纹 …${library.find(a => a.id === id)?.phash.slice(-8) || ''} → 「${cardName}」，相关比赛记录展示已同步使用新名字。`;
        status.style.color = '';
      } catch (e) { status.textContent = e.message || '保存失败，请重试。'; status.style.color = '#D92B2B'; }
      finally { btn.disabled = false; }
    });
    root.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
      const id = Number(btn.dataset.del);
      const item = library.find(a => a.id === id);
      if (!confirm(`确定删除「${item?.cardName || ''}」这条头像映射吗？已挂到比赛记录上的卡面名不受影响。`)) return;
      btn.disabled = true;
      try {
        await api(`admin/avatars?id=${id}`, { method: 'DELETE' });
        library = library.filter(a => a.id !== id);
        render();
        status.textContent = '已删除。'; status.style.color = '';
      } catch (e) { status.textContent = e.message || '删除失败。'; status.style.color = '#D92B2B'; }
    });
    root.querySelectorAll('[data-label]').forEach(btn => btn.onclick = async () => {
      const key = btn.dataset.label;
      const fig = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
      const cardName = fig.querySelector('.avatar-name').value.trim();
      if (!cardName) { status.textContent = '请先填写卡面名（如：06姚明）。'; status.style.color = '#D92B2B'; return; }
      const item = pending.find(p => p.key === key);
      btn.disabled = true;
      try {
        await api('admin/avatar-label', { method: 'POST', body: JSON.stringify({ key, cardName, phash: item?.phash, image: item?.image }) });
        pending = pending.filter(p => p.key !== key);
        status.textContent = `已入库：「${cardName}」，之后识别到该头像自动挂名。`; status.style.color = '';
        await load(false);
      } catch (e) { status.textContent = e.message || '入库失败。'; status.style.color = '#D92B2B'; }
    });
    root.querySelectorAll('[data-dismiss]').forEach(btn => btn.onclick = () => {
      // 仅从视图忽略（保留在队列，刷新仍在）；真正清理可用删除图库方式或直接忽略不管
      pending = pending.filter(p => p.key !== btn.dataset.dismiss);
      render();
      status.textContent = '已从列表隐藏（未删除，刷新后仍在队列中）。';
    });
  };

  const load = async (showMsg = true) => {
    if (showMsg) status.textContent = '正在加载头像库…';
    const data = await api('admin/avatars');
    library = data.library || [];
    pending = data.pending || [];
    render();
    if (showMsg) status.textContent = '';
  };

  $('#avatarSearch').oninput = render;
  $('#avatarReload').onclick = () => load().catch(e => { status.textContent = e.message; });
  load().catch(e => { status.textContent = e.message || '头像库加载失败。'; });
}
