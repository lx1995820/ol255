export function stars(score) {
  const rounded = Math.round(score * 2) / 2;
  return `<span class="rating-stars" aria-label="${score.toFixed(1)} 星">${Array.from({ length: 5 }, (_, index) => `<span class="rating-star ${rounded >= index + 1 ? 'full' : rounded >= index + 0.5 ? 'half' : ''}">★</span>`).join('')}</span>`;
}

export function initializePlayerComments(api, escapeHtml, onSaved) {
  const panel = document.querySelector('#playerCommentsPanel');
  const form = document.querySelector('#playerCommentForm');
  const status = document.querySelector('#commentsStatus');
  const list = document.querySelector('#commentsList');
  const legacy = document.querySelector('#legacyComments');
  const more = document.querySelector('#moreLegacyComments');
  let nickname = '';
  let cursor = null;
  let returnFocus;
  let loading = 0;
  let saving = false;

  function deviceId() {
    let device = localStorage.getItem('court-pulse-rating-device');
    if (!/^[a-f0-9]{64}$/.test(device || '')) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      device = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('court-pulse-rating-device', device);
    }
    return device;
  }

  async function loadLegacy(player, before = null) {
    const data = await api(`comments?nickname=${encodeURIComponent(player)}${before === null ? '' : `&before=${before}`}`);
    if (nickname !== player) return;
    if (before === null) legacy.innerHTML = '';
    legacy.insertAdjacentHTML('beforeend', data.comments.map(comment => `<li><div><strong>${escapeHtml(comment.author)}</strong><time>${escapeHtml(new Date(comment.createdAt).toLocaleString('zh-CN'))}</time></div><p>${escapeHtml(comment.content)}</p></li>`).join(''));
    cursor = data.nextCursor;
    more.hidden = cursor === null;
    if (!legacy.children.length) legacy.innerHTML = '<li class="comments-empty">暂无历史留言</li>';
  }

  async function load() {
    const player = nickname;
    const request = ++loading;
    status.textContent = '正在读取评分…';
    try {
      const data = await api(`ratings?nickname=${encodeURIComponent(player)}`, { headers: { 'X-Rating-Device': deviceId() } });
      if (request !== loading || player !== nickname) return;
      form.elements.score.value = data.mine ? String(data.mine.score) : '';
      form.elements.content.value = data.mine?.content || '';
      document.querySelector('#commentCount').textContent = `评分记录 · 最近 ${data.records.length} 条`;
      list.innerHTML = data.records.map(record => `<li><div><strong>${stars(record.score / 2)} ${(record.score / 2).toFixed(1)} 分</strong><time>${escapeHtml(record.month)} · ${escapeHtml(new Date(record.updatedAt).toLocaleDateString('zh-CN'))}</time></div>${record.content ? `<p>${escapeHtml(record.content)}</p>` : ''}</li>`).join('') || '<li class="comments-empty">暂无评分，来给选手打第一分。</li>';
      status.textContent = data.mine ? '你已为该选手提交本月评分，可修改后保存。' : '选择星级，为这位选手评分。';
      await loadLegacy(player);
    } catch (error) { if (request === loading) status.textContent = error.message || '无法读取评分，请检查浏览器存储设置。'; }
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-comment-player]');
    if (!trigger) return;
    nickname = trigger.dataset.commentPlayer;
    returnFocus = trigger;
    panel.hidden = false;
    document.querySelector('#commentsPlayerName').textContent = nickname;
    form.reset();
    list.innerHTML = '';
    legacy.innerHTML = '';
    const bounds = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(bounds.bottom + 8, innerHeight - Math.min(panel.offsetHeight, innerHeight - 16) - 8))}px`;
    load();
  });
  function close() { if (!saving) { panel.hidden = true; nickname = ''; loading++; returnFocus?.focus(); } }
  document.querySelector('#closeComments').onclick = close;
  document.querySelector('#reloadComments').onclick = () => { if (!saving) load(); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(); });
  more.onclick = async () => { try { await loadLegacy(nickname, cursor); } catch (error) { status.textContent = error.message; } };
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving || !nickname || !form.reportValidity()) return;
    saving = true;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    status.textContent = '正在保存评分…';
    try {
      await api('ratings', { method: 'POST', body: JSON.stringify({ nickname, score: Number(form.elements.score.value), content: form.elements.content.value, device: deviceId() }) });
      await onSaved();
      await load();
      status.textContent = '评分已保存；本月再次提交将修改原评分。';
    } catch (error) { status.textContent = error.message || '保存失败，请检查浏览器存储设置。'; }
    finally { saving = false; button.disabled = false; }
  };
}
