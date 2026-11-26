import { extractAvatars } from './avatar-detect.js';
const select = selector => document.querySelector(selector);
const maxImageLength = 4000000;
const fileType = file => file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : '');

export async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('无法读取图片，可能已损坏或格式不符，请重新截图并保存为 JPG / PNG。'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 60000000) {
      throw new Error('图片尺寸过大，请裁剪至比赛数据区域后重试。');
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理图片，请换用新版浏览器。');
    // Keep small text legible; only reduce dimensions further when the payload needs it.
    let scale = Math.min(1, 2800 / Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.94, 0.85, 0.75]) {
        const data = canvas.toDataURL('image/jpeg', quality);
        if (data.length < maxImageLength) return data;
      }
      scale *= 0.8;
    }
    throw new Error('压缩后图片仍过大，请裁剪掉无关区域后重试。');
  } finally { URL.revokeObjectURL(url); }
}

// 生成挂到比赛记录的当场截图（大图 1600w + 缩略图 400w，与迁移规格一致）
export async function prepareRoundImages(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('无法读取图片'));
      image.src = url;
    });
    const encode = (maxDim, quality) => {
      const scale = Math.min(1, maxDim / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    return { image: encode(1600, 0.8), thumb: encode(400, 0.7) };
  } finally { URL.revokeObjectURL(url); }
}

export async function recognizeScreenshot(api, image, metrics) {  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    data = await api('admin/recognize', { method: 'POST', body: JSON.stringify({ image, resolve: attempt > 0 }) });
    if (attempt === 0 && (data.warnings?.length || data.rows?.some(row => !row.nickname || !row.result || metrics.some(key => row[key] == null)))) continue;
    break;
  }
  if (!Array.isArray(data?.rows) || !data.rows.length) throw new Error('未提取到记录，请使用含红字昵称与完整数据的清晰截图。');
  return data;
}

export function initializeScreenshotUpload({ api, metrics, labels, escapeHtml, loadAdmin, today }) {
  const status = select('#batchStatus'), review = select('#batchReview'), queue = select('#batchQueue');
  const picker = select('#batchFiles'), drop = select('#batchDrop');
  const start = select('#recognizeImages'), retry = select('#retryImages'), stop = select('#stopImages');
  const clear = select('#clearImages'), progress = select('#batchProgress');
  let items = [], busy = false, saving = false, paused = false, reviewConfirmed = false;
  select('#batchDate').value = today();
  const stateLabels = { waiting: '等待识别', preparing: '正在压缩', recognizing: '正在上传并识别', saved: '已入库', success: '待自动处理', failed: '处理失败' };
  const updateQueue = () => {
    queue.innerHTML = items.map((item, index) => `<article class="upload-item" data-state="${item.state}"><a href="${item.url}" target="_blank" rel="noopener" title="打开原图核对"><img src="${item.url}" alt="第 ${index + 1} 张比赛截图"></a><div><strong>${index + 1}. ${escapeHtml(item.file.name)}</strong><small>${(item.file.size / 1024 / 1024).toFixed(2)} MB · ${item.roundNumber ? `第 ${item.roundNumber} 场 · ` : ''}${stateLabels[item.state]}</small>${item.message ? `<p>${escapeHtml(item.message)}</p>` : ''}${item.uploadKey ? `<small>截图留存编号：${escapeHtml(item.uploadKey)}</small><button type="button" class="ghost" data-report="${index}">下载留存识别报告</button>` : ''}${item.warnings.map(w => `<p class="upload-warning">核对提醒：${escapeHtml(w)}</p>`).join('')}</div>${item.state !== 'success' ? `<button type="button" class="ghost" data-remove="${index}" ${busy || saving ? 'disabled' : ''} aria-label="移除第 ${index + 1} 张图片">移除</button>` : ''}</article>`).join('');
    start.disabled = busy || saving || !items.some(item => item.state === 'waiting');
    start.textContent = items.some(item => item.state === 'success') ? '继续识别待处理图片 →' : '开始识别 →';
    retry.hidden = !items.some(item => item.state === 'failed'); retry.disabled = busy || saving;
    stop.hidden = !busy; stop.disabled = paused;
    clear.hidden = !items.length; clear.disabled = busy || saving;
    picker.disabled = busy || saving;
    select('#batchDate').disabled = busy || saving; select('#batchRound').disabled = busy || saving;
    drop.setAttribute('aria-disabled', String(busy || saving));
    progress.hidden = !items.length;
    progress.max = Math.max(1, items.length);
    progress.value = items.filter(item => ['success', 'saved', 'failed'].includes(item.state)).length;
    review.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = busy || saving; });
    review.setAttribute('aria-busy', String(busy || saving));
  };
  const captureReview = () => {
    reviewConfirmed = review.querySelector('[name="reviewConfirmed"]')?.checked ?? false;
    review.querySelectorAll('[data-item]').forEach(tr => {
      const row = items[Number(tr.dataset.item)]?.rows[Number(tr.dataset.row)];
      if (!row) return;
      row.include = tr.querySelector('[name="include"]').checked;
      for (const key of ['date', 'roundNumber', 'nickname', ...metrics, 'result']) row[key] = tr.querySelector(`[name="${key}"]`).value;
    });
  };
  const renderReview = () => {
    const rows = items.flatMap((item, index) => item.rows.map((row, rowIndex) => ({ row, index, rowIndex })));
    if (!rows.length) { review.innerHTML = ''; return; }
    review.innerHTML = `<h3>核对记录 <span class="public-note">${rows.length} 条 · 点击上方缩略图查看原图</span></h3><p class="field-help">此处保留未确认入库的记录，可选编辑；也可直接点击“仅重试失败图片”，由系统自动重识别、补全并入库。</p><form id="batchConfirmForm" novalidate><div class="table-wrap"><table class="batch-table"><thead><tr><th>保留</th><th>图片</th><th>日期</th><th>场次</th><th>昵称</th>${metrics.map(k => `<th>${labels[k]}</th>`).join('')}<th>胜负</th></tr></thead><tbody>${rows.map(({ row: r, index, rowIndex }) => `<tr data-item="${index}" data-row="${rowIndex}" class="${!r.known || !r.nickname || !r.result || metrics.some(k => r[k] == null) ? 'needs-review' : ''}"><td><input name="include" type="checkbox" ${r.include ? 'checked' : ''} aria-label="保留图片 ${index + 1} 第 ${rowIndex + 1} 行"></td><td>${index + 1}</td><td><input name="date" type="date" required value="${escapeHtml(r.date)}"></td><td><input name="roundNumber" type="number" min="1" max="10000" required value="${escapeHtml(r.roundNumber)}"></td><td><input name="nickname" maxlength="80" required value="${escapeHtml(r.nickname)}" aria-label="选手昵称">${r.known ? '' : '<small>请核对昵称，新选手可直接录入</small>'}</td>${metrics.map(k => `<td><input name="${k}" type="number" min="0" max="10000" step="1" required value="${escapeHtml(r[k] ?? '')}" aria-label="${labels[k]}"></td>`).join('')}<td><select name="result" required><option value="">待确认</option><option value="W" ${r.result === 'W' ? 'selected' : ''}>胜</option><option value="L" ${r.result === 'L' ? 'selected' : ''}>负</option></select></td></tr>`).join('')}</tbody></table></div><label class="inline-check"><input name="reviewConfirmed" type="checkbox" ${reviewConfirmed ? 'checked' : ''}>可选：我已核对数据（无需勾选也能上传）</label><button class="primary" type="submit">自动处理并录入已勾选记录 →</button></form>`;
    review.querySelectorAll('[name="include"]').forEach(input => {
      const toggle = () => input.closest('tr').querySelectorAll('input:not([name="include"]),select').forEach(field => { field.disabled = !input.checked; });
      input.onchange = toggle; toggle();
    });
    select('#batchConfirmForm').onsubmit = async event => {
      event.preventDefault(); if (busy || saving) return;
      captureReview();
      const rows = items.flatMap(item => item.rows.filter(row => row.include).map(row => Object.fromEntries(['date', 'roundNumber', 'nickname', ...metrics, 'result'].map(key => [key, row[key]]))));
      if (!rows.length) { status.textContent = '请至少勾选一条记录。'; return; }
      saving = true; updateQueue(); status.textContent = `正在保存 ${rows.length} 条记录，请勿关闭页面或重复提交…`;
      try {
        const response = await api('admin/import', { method: 'POST', body: JSON.stringify({ rows, confirm: true }) });
        // Remove every reviewed row, including deliberately excluded rows. Failed/pending files remain retryable.
        items.filter(item => item.state === 'success').forEach(item => URL.revokeObjectURL(item.url));
        items = items.filter(item => item.state !== 'success');
        reviewConfirmed = false; renderReview();
        status.textContent = `已成功录入 ${response.count} 条记录。${items.length ? '剩余图片仍在队列中，可继续识别。' : '可继续添加下一批截图。'}`;
        try { await loadAdmin(); } catch { status.textContent += ' 列表刷新失败，数据已保存，请勿重复导入。'; }
      } catch (error) {
        status.textContent = error.status ? `未保存：${error.message}。核对内容已保留。` : '未能确认保存结果，核对内容已保留。请先在比赛列表核实是否入库，再决定是否重试，避免重复录入。';
      } finally { saving = false; updateQueue(); }
    };
    updateQueue();
  };
  const addFiles = files => {
    if (busy || saving) return;
    captureReview();
    const notices = [];
    for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(fileType(file))) { notices.push(`${file.name}：不支持此格式，请使用 PNG / JPG / WebP。`); continue; }
      if (!file.size || file.size > 25 * 1024 * 1024) { notices.push(`${file.name}：文件为空或超过 25MB，请裁剪后添加。`); continue; }
      if (items.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) { notices.push(`${file.name}：已在队列中，已跳过。`); continue; }
      if (items.length >= 20) { notices.push('每批最多 20 张，请先处理当前队列。'); break; }
      items.push({ file, url: URL.createObjectURL(file), state: 'waiting', rows: [], warnings: [], message: '' });
    }
    picker.value = ''; updateQueue();
    status.textContent = notices.join(' ') || `已选择 ${items.length} 张截图，可继续追加或开始识别。`;
  };
  picker.onchange = () => addFiles([...picker.files]);
  drop.onclick = () => { if (!busy && !saving) picker.click(); };
  drop.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); drop.click(); } };
  drop.ondragover = event => { event.preventDefault(); if (!busy && !saving) drop.classList.add('is-dragging'); };
  drop.ondragleave = () => drop.classList.remove('is-dragging');
  drop.ondrop = event => { event.preventDefault(); drop.classList.remove('is-dragging'); addFiles([...event.dataTransfer.files]); };
  drop.onpaste = event => {
    const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); addFiles(files); }
  };
  queue.onclick = async event => {
    const reportButton = event.target.closest('[data-report]');
    if (reportButton) {
      reportButton.disabled = true;
      try {
        const item = items[Number(reportButton.dataset.report)];
        const data = await api('admin/upload?key=' + item.uploadKey);
        const url = URL.createObjectURL(new Blob([data.report || '截图已保存，暂无识别结果。'], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `识别报告-${item.uploadKey.slice(0, 10)}.txt`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (error) { status.textContent = `报告暂不可下载：${error.message}`; }
      finally { reportButton.disabled = false; }
      return;
    }
    const button = event.target.closest('[data-remove]');
    if (!button || busy || saving) return;
    captureReview();
    const [removed] = items.splice(Number(button.dataset.remove), 1); URL.revokeObjectURL(removed.url);
    renderReview(); updateQueue();
  };
  clear.onclick = () => {
    if (busy || saving) return;
    items.forEach(item => URL.revokeObjectURL(item.url)); items = []; reviewConfirmed = false;
    review.innerHTML = ''; updateQueue(); status.textContent = '队列和未入库草稿已清空，可以重新选择截图。';
  };
  stop.onclick = () => { paused = true; stop.disabled = true; status.textContent = '当前图片处理完成后暂停，已有结果会保留。'; };
  const run = async failedOnly => {
    if (busy || saving) return;
    const date = select('#batchDate').value, first = Number(select('#batchRound').value);
    if (!select('#batchDate').checkValidity() || !date || !Number.isInteger(first) || first < 1 || first + items.length - 1 > 10000) {
      status.textContent = '请填写有效比赛日期和起始场次，最后一场不能超过 10000。'; return;
    }
    if (!navigator.onLine) { status.textContent = '当前网络已断开，请恢复网络后继续，草稿已保留。'; return; }
    let nextRound = Math.max(first, ...items.map(item => (item.roundNumber ?? first - 1) + 1));
    if (nextRound + items.filter(item => !item.roundNumber).length - 1 > 10000) {
      status.textContent = '待处理图片的场次将超过 10000，请减少图片数量或调整起始场次。'; return;
    }
    captureReview(); busy = true; paused = false;
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (paused) break;
        if (item.state !== (failedOnly ? 'failed' : 'waiting')) continue;
        // Lock a file's match number on its first attempt, so retrying cannot shift a match.
        item.date ??= date; item.roundNumber ??= nextRound++;
        item.state = 'preparing'; item.message = ''; updateQueue();
        status.textContent = `正在处理第 ${index + 1} / ${items.length} 张：${item.file.name}`;
        try {
          const image = item.image ?? await prepareImage(item.file);
          item.image = image;
          if (!item.uploadKey) {
            const uploaded = await api('admin/upload', { method: 'POST', body: JSON.stringify({ image }) });
            item.uploadKey = uploaded.key;
          }
          item.state = 'recognizing'; item.message = '图片已压缩，每张约需 10–30 秒；请保留当前页面。'; updateQueue();
          let data;
          for (let attempt = 0; attempt < 2; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 55000);
            try {
              data = await api('admin/recognize', { method: 'POST', signal: controller.signal, body: JSON.stringify({ image, resolve: attempt > 0 || failedOnly }) });
              if (attempt === 0 && !failedOnly && (data.warnings?.length || data.rows?.some(row => !row.nickname || !row.result || metrics.some(key => row[key] == null)))) {
                item.message = '发现不确定内容，提醒一次：正在自动重识别、匹配历史并补全，无需手动修改。'; updateQueue();
                continue;
              }
              break;
            } catch (error) {
              if (attempt === 0 && ![401, 403].includes(error.status)) {
                item.message = '首次处理未完成，提醒一次：正在自动重试并匹配数据库，无需修改…'; updateQueue();
              } else { throw error; }
            } finally { clearTimeout(timeout); }
          }
          if (!Array.isArray(data?.rows) || !data.rows.length) throw new Error('未提取到记录，请使用含红字昵称与完整数据的清晰截图。');
          captureReview();
          item.rows = data.rows.map(row => ({ ...row, include: true, date: item.date, roundNumber: item.roundNumber }));
          item.warnings = Array.isArray(data.warnings) ? data.warnings.filter(w => typeof w === 'string') : [];
          item.state = 'success'; item.message = `提取 ${item.rows.length} 条记录，正在自动入库。`;
          // Save each screenshot independently so one failure cannot block the batch.
          const rows = item.rows.map(row => Object.fromEntries(['date', 'roundNumber', 'nickname', ...metrics, 'result'].map(key => [key, row[key]])));
          // 头像卡面候选：10 行记录时按行序配对（左队 5 + 右队 5），提取失败静默跳过不影响入库
          let cards = [];
          if (rows.length === 10) {
            try {
              const faces = await extractAvatars(item.file);
              if (faces.length === 10) cards = faces.map((f, i) => ({ nickname: rows[i].nickname, phash: f.phash, crop: f.crop }));
            } catch { /* 头像提取失败不影响入库 */ }
          }
          const response = await api('admin/import', { method: 'POST', body: JSON.stringify({ rows, confirm: true, cards }) });
          // 入库成功后自动把当场截图挂到比赛记录（前台可预览）；挂图失败不阻塞入库结果，仅提示
          try {
            const pair = await prepareRoundImages(item.file);
            await api('admin/round-image', { method: 'POST', body: JSON.stringify({ date: item.date, roundNumber: item.roundNumber, image: pair.image, thumb: pair.thumb }) });
          } catch { item.warnings = [...(item.warnings || []), '当场截图未保存成功，可在比赛记录的编辑里补传。']; }
          item.state = 'saved';
          item.message = `已入库 ${response.count} 条，跳过已有记录 ${response.skipped ?? 0} 条，当场截图已保存。${response.cardMatched ? `识别出 ${response.cardMatched} 个卡面。` : ''}${item.warnings.length ? '自动补全与匹配说明见下方，可在比赛列表修改。' : ''}`;
          item.rows = [];
          reviewConfirmed = false;
        } catch (error) {
          captureReview();
          item.state = 'failed';
          item.message = (item.uploadKey ? '截图已留存，数据尚未确认入库；可重试，无需重新选图。' : '截图尚未保存。') + (error.name === 'AbortError' ? '等待识别超时，请稍后点击“仅重试失败图片”。' : error instanceof TypeError ? '网络连接失败，请检查网络后重试。' : error.message);
          if ([401, 403, 429].includes(error.status)) paused = true;
        }
        renderReview(); updateQueue();
      }
      const successes = items.filter(item => item.state === 'saved').length, failures = items.filter(item => item.state === 'failed').length;
      status.textContent = `${paused ? '已暂停。' : '本轮处理完成。'}成功 ${successes} 张，失败 ${failures} 张，待处理 ${items.filter(item => item.state === 'waiting').length} 张。${successes ? '已自动入库，可在比赛列表修改。' : ''}${failures ? '每张失败图片下方有具体原因，可单独重试。' : ''}`;
    } finally { busy = false; updateQueue(); try { await loadAdmin(); } catch { status.textContent += ' 列表刷新暂未完成，已保存数据不受影响。'; } }
  };
  start.onclick = () => run(false); retry.onclick = () => run(true);
  window.addEventListener('beforeunload', event => {
    if (items.some(item => item.state !== 'saved')) { event.preventDefault(); event.returnValue = ''; }
  });
  updateQueue();
}
