import { initializeScreenshotUpload } from './screenshot-upload.js';
import { renderTournamentSection, initializeTournamentAdmin } from './tournaments.js';
import {
  acceptInvite, getUser, handleAuthCallback, hydrateSession,
  login, logout, requestPasswordRecovery, updateUser,
} from '@netlify/identity';
import { aggregate, chinaDate, tagsFor, relationships, playerRelationships, rate, statKeys, statLabels, defenseScore, tagTips, aiRatings, aiDimKeys, aiWeights, marginalValue } from './lib/statistics.js';
import { initializePlayerComments, stars } from './player-comments.js';

const isAdmin = location.pathname.endsWith('admin.html');
const select = selector => document.querySelector(selector);
const metrics = statKeys;
const labels = statLabels;
function cycleKey(date) { const [year, month, day] = date.split('-').map(Number); const value = new Date(Date.UTC(year, month - (day >= 11 ? 1 : 2), 1)); return value.toISOString().slice(0, 7); }
function cycleMinimum(records) { return Math.max(1, Math.ceil(records.length / 10 * 0.3)); }
let allGames = [];
let allPlayers = [];
let historicGames = [];
let allTournaments = [];
let seasonRows = [];
let honorHistory = [];
let scopeInitialized = false;
let playerTags = new Map();
let aiData = { scores: new Map(), dims: new Map() };
let historyTags = new Map();
let activeMetric = 'pts';
let authMode = 'login';
let inviteToken = '';
let refreshing = false;
let savingGame = false;
let loadTournaments;
let ratingSummaries = [];
let cumulativeRatings = [];
let ratingsAvailable = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function today() {
  return chinaDate();
}

function roundLabel(game) {
  const [year, month, day] = game.date.split('-').map(Number);
  const dateLabel = `${year}年${month}月${day}日`;
  return game.roundNumber == null ? `${dateLabel} · 场次待分配` : `${dateLabel}第${game.roundNumber}场`;
}

function roundSummary() {
  const assigned = new Set(allGames.filter(game => game.roundNumber != null)
    .map(game => `${game.date}/${game.roundNumber}`)).size;
  const pending = allGames.filter(game => game.roundNumber == null).length;
  return { assigned, text: `· ${assigned} 场 · ${allGames.length} 条选手记录${pending ? ` · ${pending} 条场次待分配` : ''}` };
}

// 上榜门槛：超过当前范围已分配场次的 30%（如已分配 22 场 → 满 7 场上榜）
function leaderMinimum() {
  return Math.floor(roundSummary().assigned * 0.3) + 1;
}

// 比赛截图：每场（date+round）仅一张，确定性键覆盖写入，天然去重
let roundImages = new Set();
let pendingRoundImage = null; // null=无改动 | {image,thumb}=待上传 | {remove:true}=待移除
const roundImageKey = (date, round) => `${date}/${round}`;
const hasRoundImage = (date, round) => round != null && roundImages.has(roundImageKey(date, round));

function syncRoundImages(list) {
  roundImages = new Set((list || []).map(item => roundImageKey(item.date, item.roundNumber)));
}

async function makeRoundImages(file) {
  const bitmap = await createImageBitmap(file);
  const shrink = (maxSide, quality) => {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  };
  const result = { image: shrink(960, 0.85), thumb: shrink(320, 0.75) };
  bitmap.close();
  return result;
}

function currentFormRound() {
  const choice = select('#roundChoice')?.value;
  if (choice === 'pending') return null;
  return Number(choice === 'new' ? select('#roundNumber')?.value : choice) || null;
}

function updateRoundImageUI() {
  const pick = select('#roundImagePick'), view = select('#roundImageView');
  if (!pick || !view) return;
  const thumb = select('#roundImageThumb'), hint = select('#roundImageHint');
  const date = select('#date')?.value, round = currentFormRound();
  pick.hidden = false; view.hidden = true; thumb.removeAttribute('src');
  if (pendingRoundImage?.image) {
    pick.hidden = true; view.hidden = false;
    thumb.src = pendingRoundImage.thumb;
    hint.textContent = '新截图待保存，点「保存这局比赛」后生效。';
  } else if (pendingRoundImage?.remove) {
    hint.textContent = '';
    pick.textContent = '已标记移除（保存后生效），点此改为重新上传 →';
  } else if (date && round && hasRoundImage(date, round)) {
    pick.hidden = true; view.hidden = false;
    thumb.src = `/api/round-image?date=${date}&round=${round}&size=thumb`;
    hint.textContent = '本场已有截图，可更换或移除。';
  } else {
    pick.textContent = '上传截图 →';
    hint.textContent = round == null ? '待分配场次的记录保存后才可关联截图。' : '';
  }
}

function showImageOverlay(src, alt) {
  let overlay = select('#imageOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'imageOverlay';
    overlay.innerHTML = '<img alt="比赛原图预览"><p>点击任意处关闭</p>';
    overlay.onclick = () => { overlay.hidden = true; overlay.querySelector('img').removeAttribute('src'); };
    document.body.appendChild(overlay);
  }
  overlay.querySelector('img').src = src;
  overlay.querySelector('img').alt = alt || '比赛原图预览';
  overlay.hidden = false;
}

function sortedGames(records) {
  return [...records].sort((first, second) => second.date.localeCompare(first.date)
    || (second.roundNumber ?? 0) - (first.roundNumber ?? 0) || second.id - first.id);
}

function roundNumbers(date) {
  return [...new Set(allGames.filter(game => game.date === date && game.roundNumber != null)
    .map(game => game.roundNumber))].sort((first, second) => first - second);
}

function updateRoundPreview() {
  const choice = select('#roundChoice').value;
  const custom = choice === 'new';
  select('#roundNumberLabel').hidden = !custom;
  select('#roundNumber').disabled = !custom;
  select('#roundNumber').required = custom;
  const roundNumber = choice === 'pending' ? null : Number(custom ? select('#roundNumber').value : choice);
  select('#roundPreview').textContent = select('#date').value
    ? custom && (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 10000)
      ? '请输入 1–10000 的整数场次编号。'
      : roundLabel({ date: select('#date').value, roundNumber })
    : '请先选择比赛日期。';
}

function updateRoundChoices(roundNumber) {
  const choice = select('#roundChoice');
  const previous = choice.value;
  const numbers = roundNumbers(select('#date').value);
  const editing = allGames.find(game => String(game.id) === select('#gameId').value);
  choice.innerHTML = numbers.map(number => `<option value="${number}">第${number}场 · 已有记录</option>`).join('')
    + '<option value="new">新增场次 / 自定编号</option>'
    + (editing?.roundNumber === null ? '<option value="pending">场次待分配 · 旧记录</option>' : '');
  const desired = roundNumber === undefined ? previous : roundNumber === null ? 'pending' : String(roundNumber);
  choice.value = [...choice.options].some(option => option.value === desired) ? desired : 'new';
  if (choice.value === 'new' && (roundNumber !== undefined || previous !== 'new' || !select('#roundNumber').value)) {
    select('#roundNumber').value = roundNumber ?? (numbers.length ? numbers[numbers.length - 1] + 1 : 1);
  }
  updateRoundPreview();
}

function populateFilter(element, options, label) {
  const previous = element.value;
  element.innerHTML = `<option value="">${label}</option>` + options.map(([value, text]) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join('');
  element.value = options.some(([value]) => String(value) === previous) ? previous : '';
}

function filteredGames(prefix, query) {
  const dateFilter = select(`#${prefix}DateFilter`);
  const roundFilter = select(`#${prefix}RoundFilter`);
  const dates = [...new Set(allGames.map(game => game.date))].sort().reverse();
  populateFilter(dateFilter, dates.map(date => [date, date]), '全部日期');
  const dated = allGames.filter(game => !dateFilter.value || game.date === dateFilter.value);
  const numbers = [...new Set(dated.filter(game => game.roundNumber != null).map(game => game.roundNumber))]
    .sort((first, second) => first - second);
  const options = numbers.map(number => [number, `第${number}场`]);
  if (dated.some(game => game.roundNumber == null)) options.push(['pending', '场次待分配']);
  populateFilter(roundFilter, options, '全部场次');
  return sortedGames(dated.filter(game => (!query || game.nickname.includes(query))
    && (!roundFilter.value || (roundFilter.value === 'pending' ? game.roundNumber == null : game.roundNumber === Number(roundFilter.value)))));
}

function gameCells(game) {
  return `<td>${escapeHtml(roundLabel(game))}</td><td><strong>${escapeHtml(game.nickname)}</strong>${tagMarkup(game.nickname)}${isAdmin ? '' : commentButton(game.nickname)}</td>
    ${metrics.map(key => `<td>${game[key]}</td>`).join('')}
    <td class="${game.result === 'W' ? 'win' : 'loss'}">${game.result === 'W' ? '<span aria-hidden="true">✓</span> 胜' : '负'}</td>`;
}

function renderPublicGames() {
  select('#publicRecordCount').textContent = roundSummary().text;
  const records = filteredGames('public', select('#publicSearch').value.trim());
  const thumbCell = game => hasRoundImage(game.date, game.roundNumber)
    ? `<td><img class="round-thumb" loading="lazy" src="/api/round-image?date=${game.date}&round=${game.roundNumber}&size=thumb" data-full="/api/round-image?date=${game.date}&round=${game.roundNumber}&size=image" alt="查看当场截图"></td>`
    : '<td class="no-thumb"></td>';
  select('#publicGameRows').innerHTML = records.map(game => `<tr>${gameCells(game)}${thumbCell(game)}</tr>`).join('')
    || '<tr><td colspan="9" class="empty">暂无匹配比赛记录</td></tr>';
}

function updateMonth() {
  document.querySelectorAll('[data-current-month]').forEach(element => {
    element.textContent = today().slice(0, 7).replace('-', '.');
  });
}

async function api(path, options = {}) {
  if (isAdmin) await getUser();
  const response = await fetch(`/api/${path}`, {
    ...options, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({ error:
    response.status === 413 ? '图片请求过大，请裁剪后重试' :
    response.status === 429 ? '服务繁忙，请稍后重试' :
    [502, 504].includes(response.status) ? '服务响应超时，请稍后重试，当前草稿已保留' :
    '数据服务响应异常，请稍后重试',
  }));
  if (!response.ok) {
    const error = new Error(data.error || (response.status === 413 ? '图片请求过大，请压缩后重试' : response.status === 429 ? '服务繁忙，请稍后重试' : [502, 504].includes(response.status) ? '服务响应超时，请稍后重试，当前草稿已保留' : '请求失败，请稍后重试'));
    error.status = response.status;
    throw error;
  }
  return data;
}

let nicknameChoices = [];

function renderNicknameChoices() {
  nicknameChoices = [...new Set(allPlayers.map(player => player.nickname).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  // 空输入框不展示下拉，仅在输入后按内容匹配（见 bindNicknameAutocomplete）
  select('#nicknameList').innerHTML = '';
}

function bindNicknameAutocomplete(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const query = input.value.trim();
    const list = select('#nicknameList');
    if (!query) { list.innerHTML = ''; return; }
    list.innerHTML = nicknameChoices.filter(name => name.includes(query)).slice(0, 30)
      .map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  });
  input.addEventListener('blur', () => { setTimeout(() => { select('#nicknameList').innerHTML = ''; }, 150); });
}

// 一键修改ID：预览 → 确认两段式，仅作用于所选日期
function resetRenamePreview() {
  select('#renamePreviewBox').hidden = true;
  select('#renameStatus').textContent = '';
}

// ===== 一键修改ID：平时比赛 / 锦标赛 双范围统一入口 =====
function resetTRenamePreview() { resetRenamePreview(); }

function renameScope() { return select('#renameScope').value === 'tournament' ? 'tournament' : 'games'; }

async function loadRenameTournaments() {
  const selectEl = select('#renameTournament');
  try {
    const data = await api('admin/tournaments');
    const list = data.tournaments || [];
    selectEl.innerHTML = list.length
      ? list.map(t => `<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.date)}</option>`).join('')
      : '<option value="">暂无锦标赛</option>';
  } catch { selectEl.innerHTML = '<option value="">加载失败，请刷新</option>'; }
}

function onRenameScopeChange() {
  const isT = renameScope() === 'tournament';
  select('#renameDateWrap').hidden = isT;
  select('#renameTournamentWrap').hidden = !isT;
  if (isT) loadRenameTournaments();
  resetRenamePreview();
}



async function previewRename() {
  const scope = renameScope();
  const date = select('#renameDate').value;
  const tournamentId = Number(select('#renameTournament').value);
  const from = select('#renameFrom').value.trim();
  const to = select('#renameTo').value.trim();
  if (scope === 'games' && !date) { select('#renameStatus').textContent = '请选择比赛日期。'; return; }
  if (scope === 'tournament' && !tournamentId) { select('#renameStatus').textContent = '请选择锦标赛。'; return; }
  if (!from || !to) { select('#renameStatus').textContent = '请填完整：原ID、目标ID。'; return; }
  if (from === to) { select('#renameStatus').textContent = '原ID与目标ID相同，无需修改。'; return; }
  const button = select('#renamePreview');
  button.disabled = true;
  select('#renameStatus').textContent = '正在匹配…';
  try {
    const payload = scope === 'tournament' ? { scope, tournamentId, from, to } : { date, from, to };
    const data = await api('admin/rename', { method: 'POST', body: JSON.stringify(payload) });
    if (!data.count) {
      resetRenamePreview();
      select('#renameStatus').textContent = data.message || '没有匹配的记录。';
      return;
    }
    if (scope === 'tournament') {
      const parts = [`<strong>${data.count}</strong> 条比赛记录（第 ${data.rounds.join('、')} 场）`];
      if (data.inPodium) parts.push('领奖台阵容');
      if (data.isMvp) parts.push('赛事 MVP');
      select('#renameSummary').innerHTML = `匹配到 ${data.nicknames.map(n => `「${escapeHtml(n)}」`).join('、')}，将影响：${parts.join(' + ')}，全部改为「<strong>${escapeHtml(to)}</strong>」；只改这一届锦标赛，其他赛事不受影响：`;
      select('#renameRows').innerHTML = '';
      select('#renameRowsWrap').hidden = true;
    } else {
      select('#renameSummary').innerHTML = `匹配到 <strong>${data.count}</strong> 条记录（${data.nicknames.map(n => `「${escapeHtml(n)}」`).join('、')}），将全部改为「<strong>${escapeHtml(to)}</strong>」；只改 ${escapeHtml(date)} 这一天，其他日期不受影响：`;
      select('#renameRows').innerHTML = data.rows.map(r => `<tr><td>${escapeHtml(r.date)}${r.roundNumber != null ? ' · 第' + r.roundNumber + '场' : ''}</td><td><strong>${escapeHtml(r.nickname)}</strong></td>${metrics.map(key => `<td>${r[key] ?? ''}</td>`).join('')}<td>${escapeHtml(r.result || '')}</td></tr>`).join('');
      select('#renameRowsWrap').hidden = false;
    }
    select('#renamePreviewBox').hidden = false;
    select('#renameStatus').textContent = '';
    select('#renamePreviewBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    select('#renameStatus').textContent = error.message || '匹配失败，请稍后重试。';
  } finally { button.disabled = false; }
}

async function confirmRename() {
  const scope = renameScope();
  const date = select('#renameDate').value;
  const tournamentId = Number(select('#renameTournament').value);
  const from = select('#renameFrom').value.trim();
  const to = select('#renameTo').value.trim();
  const button = select('#renameConfirm');
  button.disabled = true;
  select('#renameStatus').textContent = '正在修改…';
  try {
    const payload = scope === 'tournament' ? { scope, tournamentId, from, to, confirm: true } : { date, from, to, confirm: true };
    const data = await api('admin/rename', { method: 'POST', body: JSON.stringify(payload) });
    select('#renamePreviewBox').hidden = true;
    const scopeText = scope === 'tournament'
      ? [`${data.updated} 条比赛记录`, ...(data.inPodium ? ['领奖台'] : []), ...(data.isMvp ? ['MVP'] : [])].join(' + ')
      : `${data.updated} 条记录（仅限 ${date} 当天）`;
    select('#renameStatus').textContent = `完成：已把 ${data.nicknames.map(n => `「${n}」`).join('、')} 改为「${data.to}」（${scopeText}）。${data.alias ? '已自动写入昵称映射表，下次识别自动归位。' : ''}`;
    select('#renameFrom').value = '';
    await loadAdmin();
  } catch (error) {
    select('#renameStatus').textContent = error.message || '修改失败，请稍后重试。';
  } finally { button.disabled = false; }
}

async function loadAdmin() {
  const data = await api('admin/games');
  allGames = data.games;
  allPlayers = data.players;
  seasonRows = data.seasons;
  syncRoundImages(data.roundImages);
  renderSeasonStatus();
  renderAdmin();
  renderNicknameChoices();
  if (loadTournaments) await loadTournaments();
}

function showLogin() {
  select('#login').hidden = false;
  select('#adminApp').hidden = true;
}

async function bootAdmin() {
  const user = await getUser();
  select('#loginLogout').hidden = !user;
  if (!user) {
    showLogin();
    return;
  }
  if (!user.roles?.includes('admin')) {
    showLogin();
    select('#loginStatus').textContent = '此账户尚未获授 admin 角色，请由网站所有者在 Netlify Identity 中配置后重新登录。';
    return;
  }
  select('#date').value = today();
  await loadAdmin();
  select('#login').hidden = true;
  select('#adminApp').hidden = false;
}

function renderAdmin() {
  select('#gameCount').textContent = roundSummary().assigned;
  select('#recordCount').textContent = roundSummary().text;
  updateRoundChoices();
  const query = select('#filter').value.trim();
  const records = filteredGames('admin', query);
  select('#gameRows').innerHTML = records.map(game => `<tr>${gameCells(game)}
    <td><button class="row-btn" data-edit="${game.id}">编辑</button><button class="row-btn" data-delete="${game.id}">删除</button></td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">暂无匹配记录</td></tr>';
  document.querySelectorAll('[data-edit]').forEach(button => {
    button.onclick = () => editGame(button.dataset.edit);
  });
  document.querySelectorAll('[data-delete]').forEach(button => {
    button.onclick = () => deleteGame(button.dataset.delete, button);
  });
}

function editGame(id) {
  const game = allGames.find(record => String(record.id) === id);
  if (!game) return;
  ['date', 'nickname', ...metrics, 'result'].forEach(key => { select(`#${key}`).value = game[key]; });
  select('#gameId').value = game.id;
  updateRoundChoices(game.roundNumber);
  select('#formTitle').textContent = '修改这局比赛';
  select('#saveBtn').textContent = '保存修改 →';
  select('#cancelEdit').hidden = false;
  pendingRoundImage = null;
  updateRoundImageUI();
  select('#formTitle').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetForm(date = today(), roundNumber) {
  select('#gameForm').reset();
  select('#date').value = date;
  select('#gameId').value = '';
  select('#formTitle').textContent = '录入一局比赛';
  select('#saveBtn').textContent = '保存这局比赛 →';
  select('#cancelEdit').hidden = true;
  select('#formStatus').textContent = '';
  pendingRoundImage = null;
  updateRoundChoices(roundNumber ?? undefined);
  updateRoundImageUI();
}

async function handleAdminError(error) {
  if (error.status === 401 || error.status === 403) {
    showLogin();
    select('#loginStatus').textContent = error.message;
  } else {
    select('#formStatus').textContent = error.message;
  }
}

async function deleteGame(id, button) {
  if (!confirm('确定删除这局比赛吗？此操作无法撤销。')) return;
  button.disabled = true;
  try {
    await api(`admin/games/${id}`, { method: 'DELETE' });
    allGames = allGames.filter(game => String(game.id) !== id);
    if (select('#gameId').value === id) resetForm();
    renderAdmin();
    try { await loadAdmin(); } catch {
      select('#formStatus').textContent = '删除已保存，完整列表暂未刷新，请稍后刷新页面。';
    }
  } catch (error) {
    await handleAdminError(error);
    button.disabled = false;
  }
}

function configurePasswordFlow(mode) {
  authMode = mode;
  showLogin();
  select('#emailLabel').hidden = true;
  select('#email').required = false;
  select('#password').autocomplete = 'new-password';
  select('#password').minLength = 8;
  select('#password').placeholder = '设置新密码（至少 8 位）';
  select('#loginSubmit').textContent = mode === 'invite' ? '接受邀请并设置密码 →' : '保存新密码 →';
  select('#forgotPassword').hidden = true;
  select('#loginHelp').textContent = '设置你自己的账户密码，之后使用邮箱和密码登录后台。';
}

function resetLoginFlow() {
  authMode = 'login';
  inviteToken = '';
  select('#loginForm').reset();
  select('#emailLabel').hidden = false;
  select('#email').required = true;
  select('#password').autocomplete = 'current-password';
  select('#password').minLength = 0;
  select('#password').placeholder = '输入账户密码';
  select('#loginSubmit').textContent = '进入后台 →';
  select('#forgotPassword').hidden = false;
}

async function initializeAdmin() {
  initializeBatch();
  loadTournaments = initializeTournamentAdmin(api, escapeHtml);
  select('#loginForm').onsubmit = async event => {
    event.preventDefault();
    const button = select('#loginSubmit');
    button.disabled = true;
    select('#loginStatus').textContent = '正在验证账户…';
    try {
      if (authMode === 'invite') await acceptInvite(inviteToken, select('#password').value);
      else if (authMode === 'recovery') await updateUser({ password: select('#password').value });
      else await login(select('#email').value.trim(), select('#password').value);
      resetLoginFlow();
      select('#loginStatus').textContent = '';
      await bootAdmin();
    } catch (error) {
      select('#loginStatus').textContent = error.status === 401 ? '邮箱或密码无效，请检查后重试。' : '操作失败，请确认账户信息、网络连接或邀请链接是否有效。';
    } finally { button.disabled = false; }
  };
  const signOut = async () => {
    try {
      await logout();
      allGames = [];
      allPlayers = [];
      resetForm();
      resetLoginFlow();
      select('#loginStatus').textContent = '';
      await bootAdmin();
    } catch { select('#loginStatus').textContent = '退出失败，请刷新页面后重试。'; }
  };
  select('#logout').onclick = signOut;
  select('#loginLogout').onclick = signOut;
  select('#forgotPassword').onclick = async () => {
    const email = select('#email');
    if (!email.reportValidity()) return;
    const button = select('#forgotPassword');
    button.disabled = true;
    try {
      await requestPasswordRecovery(email.value.trim());
      select('#loginStatus').textContent = '如该邮箱已注册，密码重置邮件已发送，请检查收件箱。';
    } catch { select('#loginStatus').textContent = '暂时无法发送重置邮件，请稍后重试。'; }
    finally { button.disabled = false; }
  };
  select('#filter').oninput = renderAdmin;
  select('#adminDateFilter').onchange = () => {
    select('#adminRoundFilter').value = '';
    renderAdmin();
  };
  select('#adminRoundFilter').onchange = renderAdmin;
  select('#renameDate').value = today();
  select('#renamePreview').onclick = previewRename;
  select('#renameConfirm').onclick = confirmRename;
  ['#renameDate', '#renameFrom', '#renameTo', '#renameTournament'].forEach(id => { select(id).oninput = resetRenamePreview; });
  select('#renameScope').onchange = onRenameScopeChange;
  ['#nickname', '#renameFrom', '#renameTo'].forEach(id => bindNicknameAutocomplete(select(id)));
  select('#cancelEdit').onclick = () => resetForm();
  select('#date').onchange = () => {
    select('#roundChoice').value = '';
    select('#roundNumber').value = '';
    updateRoundChoices();
    pendingRoundImage = null;
    updateRoundImageUI();
  };
  select('#roundChoice').onchange = () => { updateRoundPreview(); pendingRoundImage = null; updateRoundImageUI(); };
  select('#roundNumber').oninput = () => { updateRoundPreview(); pendingRoundImage = null; updateRoundImageUI(); };
  const roundImageInput = select('#roundImageInput');
  select('#roundImagePick').onclick = () => roundImageInput.click();
  select('#roundImageReplace').onclick = () => roundImageInput.click();
  roundImageInput.onchange = async () => {
    const file = roundImageInput.files[0];
    roundImageInput.value = '';
    if (!file) return;
    try {
      pendingRoundImage = await makeRoundImages(file);
    } catch {
      select('#formStatus').textContent = '无法读取该图片，请换 PNG/JPEG/WebP 截图重试。';
      return;
    }
    updateRoundImageUI();
  };
  select('#roundImageRemove').onclick = () => { pendingRoundImage = { remove: true }; updateRoundImageUI(); };
  select('#nextRound').onclick = () => {
    if (savingGame || !select('#date').reportValidity()) return;
    const date = select('#date').value;
    const numbers = roundNumbers(date);
    const choice = select('#roundChoice').value;
    const current = Number(choice === 'new' ? select('#roundNumber').value : choice) || 0;
    const next = Math.max(current, numbers.length ? numbers[numbers.length - 1] : 0) + 1;
    if (next > 10000) {
      select('#formStatus').textContent = '当天场次编号最多为 10000，请选择其他日期。';
      return;
    }
    resetForm(date, next);
    select('#nickname').focus();
  };
  select('#gameForm').onsubmit = async event => {
    event.preventDefault();
    if (savingGame) return;
    savingGame = true;
    const button = select('#saveBtn');
    button.disabled = true;
    const body = {};
    ['date', 'nickname', ...metrics, 'result'].forEach(key => { body[key] = select(`#${key}`).value; });
    const roundChoice = select('#roundChoice').value;
    body.roundNumber = roundChoice === 'pending' ? null : Number(roundChoice === 'new' ? select('#roundNumber').value : roundChoice);
    select('#formStatus').textContent = '正在保存…';
    try {
      const id = select('#gameId').value;
      const data = await api(id ? `admin/games/${id}` : 'admin/games', {
        method: id ? 'PUT' : 'POST', body: JSON.stringify(body),
      });
      allGames = id ? allGames.map(game => String(game.id) === id ? data.game : game) : [data.game, ...allGames];
      // 有挂接的截图改动时随记录一起保存（覆盖写，不会重复）
      if (pendingRoundImage && data.game.roundNumber != null) {
        try {
          await api('admin/round-image', {
            method: 'POST',
            body: JSON.stringify(pendingRoundImage.remove
              ? { date: data.game.date, roundNumber: data.game.roundNumber, remove: true }
              : { date: data.game.date, roundNumber: data.game.roundNumber, image: pendingRoundImage.image, thumb: pendingRoundImage.thumb }),
          });
          if (pendingRoundImage.remove) roundImages.delete(roundImageKey(data.game.date, data.game.roundNumber));
          else roundImages.add(roundImageKey(data.game.date, data.game.roundNumber));
        } catch {
          select('#formStatus').textContent = '比赛已保存，但截图上传失败；可重新编辑该场单独上传截图。';
        }
      }
      pendingRoundImage = null;
      resetForm(data.game.date, data.game.roundNumber);
      renderAdmin();
      select('#formStatus').textContent = `已保存：${roundLabel(data.game)}，前台将在 30 秒内同步。`;
      try { await loadAdmin(); } catch {
        select('#formStatus').textContent = '比赛已保存，完整列表暂未刷新，请勿重复提交。';
      }
    } catch (error) { await handleAdminError(error); }
    finally {
      savingGame = false;
      button.disabled = false;
    }
  };
  try {
    await hydrateSession();
    const callback = await handleAuthCallback();
    if (callback?.type === 'invite') {
      inviteToken = callback.token;
      configurePasswordFlow('invite');
      return;
    }
    if (callback?.type === 'recovery') {
      configurePasswordFlow('recovery');
      return;
    }
    await bootAdmin();
  } catch {
    showLogin();
    select('#loginStatus').textContent = '账户或数据服务暂不可用。请重试登录；邀请链接失效时请联系网站所有者。';
  }
}

function metricValue(player, key) {
  if (key === 'winRate') return player.wins / player.games * 100;
  return player[key];
}

function commentButton(nickname, month = '') {
  if (!ratingsAvailable) return `<button type="button" class="comment-trigger rating-trigger" data-comment-player="${escapeHtml(nickname)}" aria-label="查看并评分 ${escapeHtml(nickname)}" aria-controls="playerCommentsPanel">评分暂不可用</button>`;
  const rating = month ? ratingSummaries.find(item => item.nickname === nickname && item.month === month) : cumulativeRatings.find(item => item.nickname === nickname);
  const average = rating ? rating.total / rating.count / 2 : 0;
  return `<button type="button" class="comment-trigger rating-trigger" data-comment-player="${escapeHtml(nickname)}" aria-label="查看并评分 ${escapeHtml(nickname)}" aria-controls="playerCommentsPanel">${stars(average)} <span>${rating ? average.toFixed(1) : '暂无评分'}</span> <small>${rating?.participants || 0} 人评分</small></button>`;
}

function renderPublic() {
  const list = allPlayers.filter(player => player.games >= leaderMinimum())
    .sort((first, second) => metricValue(second, activeMetric) - metricValue(first, activeMetric)
      || second.games - first.games || first.nickname.localeCompare(second.nickname, 'zh-CN')).slice(0, 7);
  select('#leaderTitle').textContent = '场均榜单';
  select('#leaderNote').textContent = `前 7 名 · 超已分配场次 30%（满 ${leaderMinimum()} 场）上榜`;
  const max = Math.max(...list.map(player => metricValue(player, activeMetric)), 1);
  select('#leaderRows').innerHTML = list.map((player, position) => {
    const value = metricValue(player, activeMetric);
    return `<div class="leader-row-public ${position===0?'gold-winner':''} rank-tier-${Math.min(position + 1, 4)}" data-player="${escapeHtml(player.nickname)}"><span class="rank ${position < 3 ? 'top' : ''}" aria-label="第 ${position + 1} 名">${String(position + 1).padStart(2, '0')}</span>
      <div><strong>${escapeHtml(player.nickname)}</strong>${tagMarkup(player.nickname)}<small>${player.games} 场 · ${player.wins} 胜 ${player.games - player.wins} 负</small>
      <div class="bar"><i style="width:${value / max * 100}%"></i></div></div>
      <div class="leader-value-col"><strong class="leader-value">${activeMetric === 'winRate' ? value.toFixed(1) + '%' : value.toFixed(2)}</strong><span class="ai-score" title="AI 评分：胜率 60% + 边际价值 40%（分×1.0 板×0.6 助×1.8 断×1.8 帽×1.2），以上榜选手中综合第 1、2 名均值为 100 分基准">AI ${(aiData.scores.get(player.nickname) || 0).toFixed(1)}</span></div>${commentButton(player.nickname)}</div>`;
  }).join('') || `<p class="empty">暂无参赛满 ${leaderMinimum()} 场的选手；未满 ${leaderMinimum()} 场不参与排名。</p>`;
  select('#publicGames').textContent = roundSummary().assigned;
}

function monthlyPlayers() {
  const month = cycleKey(today());
  const grouped = new Map();
  const cycleGames = allGames.filter(game => cycleKey(game.date) === month);
  cycleGames.forEach(game => {
    const player = grouped.get(game.nickname) ?? { nickname: game.nickname, games: 0, wins: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 };
    player.games += 1;
    player.wins += game.result === 'W' ? 1 : 0;
    ['pts', 'reb', 'ast', 'stl', 'blk'].forEach(key => { player[key] += game[key]; });
    grouped.set(game.nickname, player);
  });
  return [...grouped.values()].filter(player => player.games >= cycleMinimum(cycleGames)).map(player => {
    ['pts', 'reb', 'ast', 'stl', 'blk'].forEach(key => { player[key] /= player.games; });
    return player;
  });
}

function renderHonors() {
  const players = monthlyPlayers();
  if (!players.length) {
    select('#honorRows').innerHTML = '<p class="empty">本周期暂无达到总场数 30% 的选手，所有奖项与最佳阵容暂不评选。</p>';
    return;
  }
  const rankPlayers = score => [...players].sort((first, second) => score(second) - score(first)
    || second.games - first.games || first.nickname.localeCompare(second.nickname, 'zh-CN'));
  const overallScore = player => player.pts + player.ast + player.reb;
  const maxOverall = Math.max(...players.map(overallScore), 1);
  const mvpScore = player => metricValue(player, 'winRate') * 0.6 + overallScore(player) / maxOverall * 100 * 0.4;
  const overall = rankPlayers(overallScore);
  const defense = rankPlayers(defenseScore);
  const awards = [
    ['月度 MVP', rankPlayers(mvpScore), mvpScore, '胜率 60% + 标准化综合数据 40% · 满分 100'],
    ['DPOY', defense, defenseScore, '场均抢断 + 盖帽 + 篮板 × 0.5'],
    ...['pts', 'reb', 'ast', 'stl', 'blk'].map(key => [
      `${labels[key]}王`, rankPlayers(player => player[key]), player => player[key], `场均${labels[key]}`,
    ]),
  ];
  const candidates = awards.map(([title, ranked, score, description], position) => `<div class="honor-item ${position === 0 ? 'featured' : ''}">
    <h4>${escapeHtml(title)} <span class="honor-count">前 ${Math.min(ranked.length, 5)} 位候选</span></h4>
    <p class="honor-description">${escapeHtml(description)}</p>
    <ol class="honor-candidates">${ranked.slice(0, 5).map((player, rank) => `<li class="rank-tier-${Math.min(rank + 1, 4)} ${rank===0?'gold-winner':''}" data-player="${escapeHtml(player.nickname)}">
      <span class="honor-rank">${String(rank + 1).padStart(2, '0')}</span>
      <div class="honor-player"><strong>${escapeHtml(player.nickname)}</strong>${tagMarkup(player.nickname, historyTags)}<small>本月 ${player.games} 场${position === 0 ? ` · 胜率 ${metricValue(player, 'winRate').toFixed(1)}%` : ''}</small></div>
      <span class="honor-value">${score(player).toFixed(1)}</span>
      ${commentButton(player.nickname, cycleKey(today()))}
    </li>`).join('')}</ol></div>`).join('');
  const items = [
    ['最佳一阵', overall.slice(0, 5), '综合数据前五'],
    ['最佳二阵', overall.slice(5, 10), '综合数据第六至十'],
    ['最佳防守1阵', defense.slice(0, 5), '防守数据前五'],
    ['最佳防守2阵', defense.slice(5, 10), '防守数据第六至十'],
  ];
  select('#honorRows').innerHTML = candidates + items.map(item => `<div class="honor-item">
<h4>${escapeHtml(item[0])}</h4><p>${escapeHtml(item[2])}</p><ul class="team-candidates">${item[1].map(player => `<li data-player="${escapeHtml(player.nickname)}"><strong>${escapeHtml(player.nickname)}</strong>${tagMarkup(player.nickname, historyTags)}${commentButton(player.nickname, cycleKey(today()))}</li>`).join('') || '<li>暂无符合条件的选手</li>'}</ul></div>`).join('');
}

function playerRadar(player) {
  const dimLabels = { ...labels, winRate: '胜率' };
  const playerDims = aiData.dims.get(player.nickname) || {};
  const center = 120, radius = 76, axes = aiDimKeys;
  const point = (index, scale) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length;
    return `${(center + Math.cos(angle) * radius * scale).toFixed(1)},${(center + Math.sin(angle) * radius * scale).toFixed(1)}`;
  };
  const polygon = axes.map((key, index) => point(index, Math.min((playerDims[key] || 0) / 100, 1.15))).join(' ');
  return `<div class="player-radar"><svg viewBox="0 0 240 240" role="img" aria-label="六维能力雷达图，各维度以当前范围第 1、2 名均值为 100 分">
    ${[0.25, 0.5, 0.75, 1].map(scale => `<polygon class="radar-grid" points="${axes.map((key, index) => point(index, scale)).join(' ')}"/>`).join('')}
    ${axes.map((key, index) => `<line class="radar-grid" x1="120" y1="120" x2="${point(index, 1).replace(',', '" y2="')}"/>`).join('')}
    <polygon class="radar-shape" points="${polygon}"/>
    ${axes.map((key, index) => { const [x, y] = point(index, 1.36).split(','); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${dimLabels[key]} ${(playerDims[key] || 0).toFixed(0)}</text>`; }).join('')}
    </svg><p>六维评分：各维度以当前范围第 1、2 名均值为 100 分，与榜单及个人明细同一口径；最外圈为 100 分基准线，超出即领先基准。</p></div>`;
}

function playerRelationshipCard(title, subtitle, items) {
  return `<article class="player-relation-card"><div class="player-relation-title"><h4>${title}</h4><span>${subtitle}</span></div><ol>${items.map((item, index) => `<li><span class="player-relation-rank">0${index + 1}</span><div><strong>${item.names.map(escapeHtml).join(' ＋ ')}</strong><small>${item.games} 场 · ${item.wins} 胜</small></div><b>${rate(item).toFixed(1)}%</b></li>`).join('') || '<li class="player-relation-empty">暂无满 10 场的记录</li>'}</ol></article>`;
}

// ===== 锦标赛个人档案（选手卡翻面）=====
const PLACE_MEDALS = ['🏆', '🥈', '🥉', '🏅'];
const PLACE_NAMES = ['冠军', '亚军', '季军', '殿军'];
function placeName(index) { return PLACE_NAMES[index] ?? `第${index + 1}名`; }

function playerTournamentHistory(nickname) {
  const out = [];
  for (const t of allTournaments) {
    const podium = Array.isArray(t.podium) ? t.podium : [];
    const placement = podium.findIndex(team => Array.isArray(team) && team.includes(nickname));
    const recs = (Array.isArray(t.records) ? t.records : []).filter(r => r.nickname === nickname);
    if (placement < 0 && !recs.length) continue; // 既不在领奖台也没打过该届比赛 → 无关
    const games = recs.length;
    const wins = recs.filter(r => r.result === 'W').length;
    const avg = key => games ? recs.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / games : 0;
    out.push({ tournament: t, placement: placement < 0 ? null : placement, teammates: placement >= 0 ? podium[placement].filter(n => n !== nickname) : [], isMvp: t.mvp === nickname, games, wins, avg });
  }
  return out;
}

function badgeStrip(nickname) {
  const hist = playerTournamentHistory(nickname);
  if (!hist.length) return '';
  const counts = new Map();
  let mvps = 0;
  hist.forEach(h => { if (h.placement === null) return; counts.set(h.placement, (counts.get(h.placement) || 0) + 1); if (h.isMvp) mvps++; });
  const parts = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([p, n]) => `${PLACE_MEDALS[p] ?? '🏅'}×${n}`);
  if (mvps) parts.push(`⭐MVP×${mvps}`);
  return parts.length ? `<span class="badge-strip" title="锦标赛徽章">${parts.join(' ')}</span>` : '';
}

function tournamentBackHTML(nickname) {
  const hist = playerTournamentHistory(nickname);
  const head = `<div class="lookup-heading"><h3>${escapeHtml(nickname)}</h3>${badgeStrip(nickname)}<button type="button" class="flip-btn" data-flip>← 返回数据卡</button></div>`;
  if (!hist.length) return `${head}<p class="field-help">还没有锦标赛记录。</p>`;
  const chipOf = h => h.placement === null
    ? '<span class="place-chip place-chip-part">参赛</span>'
    : `<span class="place-chip place-chip-${h.placement}">${PLACE_MEDALS[h.placement] ?? '🏅'} ${placeName(h.placement)}</span>`;
  return `${head}<p class="eyebrow">TOURNAMENT BOOK</p><h3 class="tournament-back-title">锦标赛荣誉簿</h3><div class="tournament-history">${hist.map(h => `
    <article class="tournament-entry place-${h.placement ?? 'part'}">
      <div class="tournament-entry-head">${chipOf(h)}<strong>${escapeHtml(h.tournament.name)}</strong><small>${escapeHtml(h.tournament.date)}</small>${h.isMvp ? '<span class="mvp-chip">⭐ 赛事MVP</span>' : ''}</div>
      ${h.teammates.length ? `<p class="tournament-team">队友：${h.teammates.map(escapeHtml).join('、')}</p>` : ''}
      <p class="tournament-stats">${h.games ? `出场 ${h.games} · ${h.wins} 胜 · 场均 ${h.avg('pts').toFixed(1)} 分 / ${h.avg('reb').toFixed(1)} 板 / ${h.avg('ast').toFixed(1)} 助 / ${h.avg('stl').toFixed(1)} 断 / ${h.avg('blk').toFixed(1)} 帽` : '个人数据未录入'}</p>
    </article>`).join('')}</div>`;
}

function bindFlip(box) {
  const inner = box.querySelector('.flip-inner');
  const front = box.querySelector('.flip-front');
  if (!inner || !front) return;
  requestAnimationFrame(() => { inner.style.minHeight = front.scrollHeight + 'px'; });
  box.querySelectorAll('[data-flip]').forEach(btn => { btn.onclick = () => inner.classList.toggle('flipped'); });
}

function lookup(query) {
  const box = select('#playerResult');
  if (!query.trim()) { box.hidden = true; return; }
  const player = allPlayers.find(candidate => candidate.nickname === query.trim());
  box.hidden = false;
  if (!player) {
    // 常规赛无数据但锦标赛有记录的选手（如老胡/小铭/阿sir）：给一张以荣誉簿为主的卡
    if (playerTournamentHistory(query.trim()).length) {
      box.innerHTML = `<div class="flip-card"><div class="flip-inner"><div class="flip-face flip-front"><div class="lookup-card"><div class="lookup-heading"><h3>${escapeHtml(query.trim())}</h3>${badgeStrip(query.trim())}</div>
        <p class="field-help">常规赛暂无数据，锦标赛已有记录。</p><button type="button" class="flip-btn flip-cta" data-flip>翻到锦标赛荣誉簿 →</button></div></div>
        <div class="flip-face flip-back"><div class="lookup-card tournament-back">${tournamentBackHTML(query.trim())}</div></div></div></div>`;
      bindFlip(box);
      return;
    }
    box.innerHTML = '<div class="lookup-card">暂无此选手的记录，请输入完整绰号。</div>';
    return;
  }
  if (!aiData.scores.size && allPlayers.length) aiData = aiRatings(allPlayers, leaderMinimum());
  const aiScore = aiData.scores.get(player.nickname) || 0;
  const aiDims = aiData.dims.get(player.nickname) || {};
  const dimLabels = { ...labels, winRate: '胜率' };
  const relation = playerRelationships(historicGames, player.nickname);
  const recent = allGames.filter(game => game.nickname === player.nickname).sort((first, second) => second.date.localeCompare(first.date) || (second.roundNumber ?? 0) - (first.roundNumber ?? 0) || second.id - first.id).slice(0, 10);
  box.innerHTML = `<div class="flip-card"><div class="flip-inner"><div class="flip-face flip-front"><div class="lookup-card" data-player="${escapeHtml(player.nickname)}"><div class="lookup-heading"><h3>${escapeHtml(player.nickname)}</h3>${tagMarkup(player.nickname)}${badgeStrip(player.nickname)}${commentButton(player.nickname)}<button type="button" class="flip-btn flip-cta" data-flip>锦标赛荣誉簿 →</button></div>
    <p class="field-help">${player.games >= leaderMinimum() ? `${player.games} 场 · 已达到参赛门槛；月度评选须当月满 20 场。` : `${player.games} 场 · 距离排名资格还差 ${leaderMinimum() - player.games} 场；单场纪录仍可上榜。`} 无需登录即可评分。</p>
    <div class="ai-panel"><div class="ai-total"><span>AI 评分</span><strong>${aiScore.toFixed(1)}</strong></div><div class="ai-dims">
    ${aiDimKeys.map(key => `<div><strong>${(aiDims[key] || 0).toFixed(1)}</strong><span>${dimLabels[key]} · ${key === 'winRate' ? rate(player).toFixed(1) + '%' : player[key].toFixed(1)}</span></div>`).join('')}
    </div><p class="ai-breakdown">胜率 ${rate(player).toFixed(1)}% × 60% = <b>${(rate(player) * 0.6).toFixed(1)}</b> ＋ 边际价值 ${marginalValue(player).toFixed(1)} ÷ 池内最高 ${(aiData.meta?.maxMV || 1).toFixed(1)} × 40% = <b>${(marginalValue(player) / (aiData.meta?.maxMV || 1) * 40).toFixed(1)}</b> → 原始 ${(rate(player) * 0.6 + marginalValue(player) / (aiData.meta?.maxMV || 1) * 40).toFixed(1)} ÷ 基准 ${(aiData.meta?.scoreBase || 1).toFixed(1)} × 100</p>
    <p class="field-help">MVP 口径：胜率 60% + 边际价值 40%（边际价值 = 得分×1.0 + 篮板×0.6 + 助攻×1.8 + 抢断×1.8 + 盖帽×1.2，参考 NBA 边际价值理论）；总分以上榜选手中综合第 1、2 名（${(aiData.meta?.poolLeaders || []).map(escapeHtml).join('、')}）均值为 100 分基准，六维各以该维度上榜选手前 2 名均值为 100 分基准，150 分封顶；与榜单展示一致，数据按当前所选范围统计。</p></div><div class="lookup-kpis">
    ${metrics.map(key => `<div><strong>${player[key].toFixed(1)}</strong><span>${labels[key]} / 场</span></div>`).join('')}
    <div><strong>${metricValue(player, 'winRate').toFixed(1)}%</strong><span>胜率</span></div></div>
    <p class="personal-records">单场纪录 · ${['pts', 'reb', 'ast', 'stl', 'blk'].map(key => `${labels[key]} ${player.records[key]}`).join(' / ')}</p>
    <div class="player-profile"><section class="player-radar-panel"><p class="eyebrow">SCOUTING REPORT</p><h3>球员能力雷达</h3>${playerRadar(player)}<div class="player-form"><span>最近 ${recent.length} 场</span>${recent.map(game => `<i class="${game.result === 'W' ? 'form-win' : 'form-loss'}" title="${escapeHtml(game.date)} · ${game.result === 'W' ? '胜' : '负'}">${game.result === 'W' ? '胜' : '负'}</i>`).join('')}</div></section>
    <section class="player-relations"><div class="player-relations-heading"><div><p class="eyebrow">ON-COURT CHEMISTRY</p><h3>球场关系档案</h3></div><span>TOP 3 / 实际胜率</span></div>
    <p class="player-relations-note">共同参赛或交手至少 10 场才纳入统计；按实际胜率排序，同胜率优先场次更多。同日期、同场次且胜负相同为队友，胜负相反为对手；未分配场次及异常阵容不计入。</p><div class="player-relations-grid">
    ${playerRelationshipCard('最佳搭档', '双人同队', relation.bestTeammates)}
    ${playerRelationshipCard('三人组合', '本人 + 两位队友', relation.bestTrios)}
    ${playerRelationshipCard('对位胜率最高', '交手对手', relation.bestOpponents)}
    ${playerRelationshipCard('对位胜率最低', '交手对手', relation.worstOpponents)}
    ${playerRelationshipCard('搭档劣势', '双人同队', relation.worstTeammates)}
    </div></section></div></div></div><div class="flip-face flip-back"><div class="lookup-card tournament-back">${tournamentBackHTML(player.nickname)}</div></div></div></div>`;
  bindFlip(box);
}

async function refreshPublic() {
  if (refreshing) return;
  refreshing = true;
  select('#refreshPublic').disabled = true;
  select('#publicStatus').textContent = '正在同步比赛数据…';
  try {
    const [data, ratings] = await Promise.all([api('public'), api('ratings').catch(() => null)]);
    ratingsAvailable = ratings !== null;
    ratingSummaries = ratings?.summaries ?? [];
    cumulativeRatings = ratings?.cumulative ?? [];
    historicGames = data.games;
    historyTags = tagsFor(historicGames);
    seasonRows = data.seasons;
  syncRoundImages(data.roundImages);
    honorHistory = data.honors;
    allTournaments = data.tournaments || [];
    renderTournamentSection(allTournaments, escapeHtml, commentButton);
    populateSeasonScope();
    applyScope();
    updateMonth();
    renderPublic();
    renderPublicGames();
    renderHonors();
    renderExtras();
    lookup(select('#publicSearch').value);
    select('#publicStatus').textContent = ratingsAvailable
      ? `已同步 · ${new Date().toLocaleTimeString('zh-CN')} · 每 30 秒自动更新`
      : '比赛数据已同步，评分暂不可用，将自动重试。';
  } catch (error) {
    select('#publicStatus').textContent = `${error.message}，可点击刷新重试。`;
    if (!allGames.length) {
      select('#leaderRows').innerHTML = '<p class="empty">暂时无法加载榜单，请点击刷新数据。</p>';
      select('#publicGameRows').innerHTML = '<tr><td colspan="9" class="empty">暂时无法加载场次，请点击刷新数据。</td></tr>';
    }
  } finally {
    refreshing = false;
    select('#refreshPublic').disabled = false;
  }
}

function initializePublic() {
  select('#seasonScope').onchange = () => { applyScope(); renderPublic(); renderPublicGames(); renderHonors(); renderExtras(); lookup(select('#publicSearch').value); };
  select('#publicGameRows').addEventListener('click', event => {
    const img = event.target.closest('.round-thumb');
    if (img?.dataset.full) showImageOverlay(img.dataset.full, '当场比赛截图');
  });
  if (/^#(?:access_token|confirmation_token|recovery_token|invite_token|email_change_token|error)=/.test(location.hash)) {
    location.replace(`/admin.html${location.hash}`);
    return;
  }
  const tabs = select('#metricTabs');
  tabs.onclick = event => {
    const button = event.target.closest('button[data-key]');
    if (!button) return;
    tabs.querySelectorAll('button').forEach(tab => tab.classList.toggle('active', tab === button));
    activeMetric = button.dataset.key;
    renderPublic();
  };
  select('#publicSearch').oninput = event => {
    lookup(event.target.value);
    renderPublicGames();
  };
  select('#publicDateFilter').onchange = () => {
    select('#publicRoundFilter').value = '';
    renderPublicGames();
  };
  select('#publicRoundFilter').onchange = renderPublicGames;
  select('#refreshPublic').onclick = refreshPublic;
  initializePlayerComments(api, escapeHtml, refreshPublic);
  refreshPublic();
  setInterval(() => { if (!document.hidden) refreshPublic(); }, 120000); // 2 分钟轮询（原 30 秒），配合边缘缓存让数据库可休眠
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPublic(); });
}

function tagMarkup(nickname, tags = playerTags) {
  const colors = ['大腿认证','得分机器','篮板痴汉','控场大师','内线大闸','死亡缠绕','三双猛男','历史留名','关键先生','大刷子','孤胆英雄'];
  return `<span class="player-tags">${(tags.get(nickname) || []).map(tag=>`<span class="player-tag tag-${colors.indexOf(tag)%6}" title="${escapeHtml(tagTips[tag] || '')}" data-tip="${escapeHtml(tagTips[tag] || '')}">${escapeHtml(tag)}</span>`).join('')}</span>`;
}
function populateSeasonScope() {
  const element=select('#seasonScope'), previous=element.value;
  element.innerHTML='<option value="all">历史总榜</option>'+(seasonRows.length?'<option value="initial">初始赛季</option>':'')+seasonRows.map(s=>`<option value="${s.id}">${escapeHtml(s.name)} · ${escapeHtml(s.startsOn)} 起</option>`).join('');
  element.value=scopeInitialized && [...element.options].some(o=>o.value===previous)?previous:seasonRows.find(s=>s.startsOn<=today())?.id ?? 'all';
  scopeInitialized=true;
}
function applyScope() {
  const index=seasonRows.findIndex(s=>String(s.id)===select('#seasonScope').value), season=seasonRows[index], end=index>0?seasonRows[index-1].startsOn:null;
  const initial=select('#seasonScope').value==='initial';
  allGames=initial?historicGames.filter(g=>g.date<seasonRows[seasonRows.length-1].startsOn):season?historicGames.filter(g=>g.date>=season.startsOn && (!end || g.date<end)):historicGames;
  allPlayers=aggregate(allGames); playerTags=tagsFor(allGames);
  // 榜单与 AI 评分按所选范围统计；评分基准池 = 上榜池（超过已分配场次 30% 的选手）
  aiData=aiRatings(allPlayers, leaderMinimum());
  select('#scopeNote').textContent=initial?`首个新赛季前的比赛 · 场均榜按历史累计，月度评奖按自然月`:season?`${season.startsOn} 起${end?`，至 ${end} 前`:''} · 场均榜按历史累计，月度评奖按自然月`:'历史累计 · 月度评奖按全站自然月';
}
function renderExtras() {
  select('#singleLeaders').innerHTML=metrics.map(key=>{
    const personal=new Map();
    for(const g of [...allGames].sort((a,b)=>a.date.localeCompare(b.date)||(a.roundNumber??0)-(b.roundNumber??0)||a.id-b.id)) { const previous=personal.get(g.nickname); if(!previous || g[key]>previous[key]) personal.set(g.nickname,g); }
    const leaders=[...personal.values()].sort((a,b)=>b[key]-a[key]||a.date.localeCompare(b.date)||(a.roundNumber??0)-(b.roundNumber??0)||a.id-b.id).slice(0,5);
    return `<article class="honor-item"><h3>单场${labels[key]}</h3><ol class="record-list">${leaders.map((g,i)=>`<li class="${i===0?'gold-winner':''}" data-player="${escapeHtml(g.nickname)}"><div><strong>${escapeHtml(g.nickname)}</strong>${tagMarkup(g.nickname)}<small>${escapeHtml(roundLabel(g))}</small>${commentButton(g.nickname)}</div><b>${g[key]}</b></li>`).join('')||'<li>暂无比赛记录</li>'}</ol></article>`;
  }).join('');
  const relation=relationships(historicGames);
  select('#relationshipRows').innerHTML=[['最强搭子',relation.best],['一生之敌',relation.enemies],['三巨头',relation.triples],['卧龙凤雏',relation.worst],['默契老搭档',relation.veterans],['势均力敌',relation.balanced]].map(([title,items])=>`<article class="honor-item"><h3>${title}</h3><ol class="record-list">${items.map((item,i)=>`<li class="${i===0?'gold-winner':''}"><div><strong>${item.names.map(escapeHtml).join(['一生之敌','势均力敌'].includes(title)?' 遇上 ':' ＋ ')}</strong><small>${item.games} 场 · ${item.wins} 胜 · 胜率 ${rate(item).toFixed(1)}%${title==='一生之敌'?` · 平滑胜率下降 ${item.drop.toFixed(1)} 个百分点 · 其他对局 ${item.baselineGames} 场`:title==='势均力敌'?` · 交手 ${item.wins} : ${item.games-item.wins}`:` · 排序胜率 ${item.adjusted.toFixed(1)}% · 人均综合 ${item.average.toFixed(1)}`}</small></div></li>`).join('')||'<li>暂无符合样本门槛的组合（共同参赛至少 10 场）</li>'}</ol></article>`).join('');
  const club=allPlayers.filter(p=>p.records.pts>=25).sort((a,b)=>b.records.pts-a.records.pts||a.nickname.localeCompare(b.nickname,'zh-CN'));
  select('#relationshipRows').innerHTML+=`<article class="honor-item club-card"><h3>25 分俱乐部成员</h3><div class="club-members">${club.map(p=>`<span><strong>${escapeHtml(p.nickname)}</strong>${tagMarkup(p.nickname)}<small>最高 ${p.records.pts} 分</small>${commentButton(p.nickname)}</span>`).join('')||'<p class="empty">等待首位单场 25 分选手</p>'}</div></article>`;
  select('#honorWall').innerHTML=honorHistory.map(entry=>{
  const entryGames = historicGames.filter(game => cycleKey(game.date) === entry.month);
  const eligible = new Set(aggregate(entryGames).filter(player => player.games >= cycleMinimum(entryGames)).map(player => player.nickname));
    const awards = entry.awards.map(award => ({ ...award, names: award.names.filter(name => eligible.has(name)) })).filter(award => award.names.length);
    return `<details class="archive-month"><summary>${escapeHtml(entry.month)} · 月度荣誉</summary><div class="honor-grid">${awards.map(a=>`<article class="honor-item gold-winner"><p class="eyebrow">${escapeHtml(a.title)}</p>${a.names.map(name=>`<div class="archived-player"><strong>${escapeHtml(name)}</strong>${commentButton(name, entry.month)}</div>`).join('')}${a.value?`<p>${escapeHtml(a.value)} · ${a.games} 场</p>`:''}</article>`).join('')||'<p class="empty">本月无满 20 场选手，暂无获奖者。</p>'}</div></details>`;
  }).join('')||'<p class="empty">完整自然月结束后，这里记录每月获奖者。</p>';
  const facts=[];
  const players=aggregate(historicGames), most=[...players].sort((a,b)=>b.games-a.games||a.nickname.localeCompare(b.nickname,'zh-CN'))[0];
  if(most) { const target=(Math.floor(most.games/10)+1)*10; facts.push(`${most.nickname} 已累计出场 ${most.games} 场，距离 ${target} 场里程碑还差 ${target-most.games} 场！`); }
  for(const k of metrics) { const record=[...historicGames].sort((a,b)=>b[k]-a[k]||a.date.localeCompare(b.date)||a.id-b.id)[0]; if(record && record[k]>0) facts.push(`${record.nickname} 在 ${record.date} 创下单场${labels[k]} ${record[k]} 的纪录，谁来挑战？`); }
  const winning=players.filter(p=>p.games>=20 && rate(p)>=60).sort((a,b)=>rate(b)-rate(a))[0];
  if(winning) facts.push(`${winning.nickname} 已打满 ${winning.games} 场，胜率 ${rate(winning).toFixed(1)}%，大腿认证实至名归！`);
  select('#milestoneTicker').textContent=facts.join('　／　')||'等待第一场比赛，社区纪录从这里开始。';
}
function renderSeasonStatus() {
  const current=seasonRows.find(s=>s.startsOn<=today());
  select('#seasonStatus').textContent=`当前赛季：${current?`${current.name}（${current.startsOn} 起）`:'初始赛季（历史累计）'}。每月 11 日按北京时间自动切换，周期为当月 11 日至次月 10 日。`;
}
function initializeBatch() {
  initializeScreenshotUpload({ api, metrics, labels, escapeHtml, loadAdmin, today });
  select('#seasonForm').onsubmit=async event=>{
    event.preventDefault(); const button=event.submitter;button.disabled=true;
    try {
      await api('admin/seasons',{method:'POST',body:JSON.stringify({name:select('#seasonName').value,confirm:select('#seasonConfirm').checked})});
      select('#seasonMessage').textContent='新赛季已开启，历史记录和自然月荣誉已保留。';select('#seasonForm').reset();
      try {await loadAdmin();} catch {select('#seasonMessage').textContent+='列表刷新失败，请刷新页面查看。';}
    } catch(error) {select('#seasonMessage').textContent=error.message;} finally {button.disabled=false;}
  };
}

updateMonth();
if (isAdmin) initializeAdmin();
else initializePublic();
