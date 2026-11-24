// AI 自动分队（管理员）：粘贴名单 → 边际价值评分 → 均衡四队
// 算法与对话版一致：产出=分+1.8助+1.8断+1.2帽+0.6板；综合=产出归一×60%+胜率×40%；锦标赛×2；中位补无数据；小样本收缩；避开最近锦标赛同队
export function initializeTeamSplitter(api, escapeHtml) {
  const root = document.querySelector('#teamSplitter');
  if (!root) return;
  root.innerHTML = `
    <div class="card-title"><div><p class="eyebrow">TEAM SPLITTER</p><h2>AI 自动分队 <small>边际价值评分 · 均衡四队 · 输出卡片+文字版</small></h2></div></div>
    <label>今晚名单（顿号/逗号/空格/换行分隔，20 人最佳）<textarea id="tsNames" rows="3" placeholder="牛子、乔老板、底角、淡然、猪咪、老胡……"></textarea></label>
    <div class="form-grid four">
      <label class="inline-check"><input type="checkbox" id="tsBoost" checked>锦标赛数据 ×2 权重</label>
      <label class="inline-check"><input type="checkbox" id="tsAvoid" checked>避开与最近锦标赛同队</label>
      <label>指定评分（可选，每行：昵称=分数）<textarea id="tsManual" rows="2" placeholder="老胡=52.7"></textarea></label>
      <label class="rename-action"><span class="field-help">无数据自动取中位</span><button id="tsRun" class="primary" type="button">开始分队 →</button></label>
    </div>
    <div id="tsOut" hidden>
      <div id="tsCards" class="ts-cards"></div>
      <pre id="tsText" class="ts-text"></pre>
      <div class="ts-actions">
        <button id="tsAgain" class="ghost" type="button">换一版 ↻</button>
        <button id="tsCopy" class="ghost" type="button">复制文字版</button>
      </div>
      <p id="tsStatus" class="field-help" role="status"></p>
    </div>`;

  const $ = s => root.querySelector(s);
  let games = null, tournaments = null;
  let lastStats = null, lastNames = null;

  const prod = r => r.pts + 1.8 * r.ast + 1.8 * r.stl + 1.2 * r.blk + 0.6 * r.reb;
  const parseNames = raw => [...new Set(raw.split(/[、，,;；\s\n]+/).map(s => s.trim()).filter(Boolean))];
  const parseManual = raw => Object.fromEntries(raw.split('\n').map(l => l.split('=').map(x => x.trim())).filter(p => p[0] && Number.isFinite(Number(p[1]))).map(p => [p[0], Number(p[1])]));

  async function ensureData() {
    if (!games) { const d = await api('admin/games'); games = d.games; }
    if (!tournaments) { const d = await api('admin/tournaments'); tournaments = d.tournaments || []; }
  }

  // 名字容错：精确匹配 → 唯一包含匹配（如「凯」→「小凯」）
  function resolveNames(names) {
    const known = [...new Set(games.map(g => g.nickname))];
    return names.map(n => {
      if (known.includes(n)) return { input: n, name: n };
      const hit = known.filter(k => k.includes(n) || n.includes(k));
      return hit.length === 1 ? { input: n, name: hit[0], resolved: true } : { input: n, name: n, unknown: true };
    });
  }

  function compute(resolved, manual, boost) {
    const trecs = {};
    tournaments.forEach(t => (t.records || []).forEach(r => { (trecs[r.nickname] = trecs[r.nickname] || []).push(r); }));
    const stats = resolved.map(({ input, name, resolved, unknown }) => {
      const g = games.filter(x => x.nickname === name);
      const tr = trecs[name] || [];
      if (!g.length && !tr.length) return { input, n: name, eff: 0, unknown: unknown || false };
      let wsum = 0, psum = 0, wgt = 0;
      g.forEach(r => { psum += prod(r); wsum += r.result === 'W' ? 1 : 0; wgt += 1; });
      tr.forEach(r => { psum += boost * prod(r); wsum += boost * (r.result === 'W' ? 1 : 0); wgt += boost; });
      return { input, n: name, g: g.length, tg: tr.length, eff: wgt, w: wsum / wgt, prod: psum / wgt, resolved };
    });
    const withData = stats.filter(s => s.eff);
    let med = 40;
    if (withData.length) {
      const prods = withData.map(s => s.prod), lo = Math.min(...prods), hi = Math.max(...prods);
      withData.forEach(s => { s.comp = hi > lo ? (s.prod - lo) / (hi - lo) * 100 * 0.6 + s.w * 100 * 0.4 : 50; });
      const comps = withData.map(s => s.comp).sort((a, b) => a - b);
      med = (comps[Math.floor((comps.length - 1) / 2)] + comps[Math.ceil((comps.length - 1) / 2)]) / 2;
      stats.forEach(s => {
        if (!s.eff) { s.final = manual[s.n] ?? manual[s.input] ?? med; s.note = manual[s.n] != null || manual[s.input] != null ? '无数据·指定' : '无数据·中位'; }
        else if (manual[s.n] != null || manual[s.input] != null) { s.final = manual[s.n] ?? manual[s.input]; s.note = '指定分'; }
        else if (s.eff <= 10) { const k = s.eff / (s.eff + 8); s.final = s.comp * k + med * (1 - k); s.note = '小样本收缩'; }
        else s.final = s.comp;
      });
    } else stats.forEach(s => { s.final = manual[s.n] ?? manual[s.input] ?? med; s.note = '无数据·中位'; });
    return { stats, med };
  }

  function prevPairsFromLatest() {
    const done = tournaments.filter(t => t.status === 'completed' && Array.isArray(t.podium) && t.podium.length);
    if (!done.length) return new Set();
    const latest = done[0]; // admin/tournaments 按日期倒序
    const pairs = new Set();
    latest.podium.forEach(team => { for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) pairs.add([team[i], team[j]].sort().join('|')); });
    return pairs;
  }

  function optimize(stats, avoid) {
    const N = stats.length, T = 4;
    const sum = t => t.reduce((s, i) => s + stats[i].final, 0);
    const spread = t => Math.max(...t.map(sum)) - Math.min(...t.map(sum));
    const prevPairs = avoid ? prevPairsFromLatest() : new Set();
    const repeatPairs = t => { let c = 0; for (const team of t) { const ns = team.map(i => stats[i].n); for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (prevPairs.has([ns[i], ns[j]].sort().join('|'))) c++; } return c; };
    const unk = new Set(stats.map((s, i) => (!s.eff || s.note === '无数据·中位' || s.note === '无数据·指定') ? i : -1).filter(x => x >= 0));
    const maxUnk = Math.ceil(unk.size / T);
    const okU = t => t.every(team => team.filter(i => unk.has(i)).length <= maxUnk);
    const obj = t => spread(t) + 3 * repeatPairs(t) + (okU(t) ? 0 : 1000);
    const ranked = stats.map((_, i) => i).sort((a, b) => stats[b].final - stats[a].final);
    const teams = Array.from({ length: T }, () => []);
    ranked.forEach((x, i) => { const r = Math.floor(i / T), c = r % 2 === 0 ? i % T : (T - 1) - (i % T); teams[c].push(x); });
    let best = { teams: JSON.parse(JSON.stringify(teams)), val: obj(teams) };
    const iters = Math.min(400000, 60000 + N * 20000);
    for (let it = 0; it < iters; it++) {
      const a = Math.floor(Math.random() * T); let b = Math.floor(Math.random() * T);
      if (a === b || !teams[a].length || !teams[b].length) continue;
      const ta = teams[a], tb = teams[b];
      const i = Math.floor(Math.random() * ta.length), j = Math.floor(Math.random() * tb.length);
      [ta[i], tb[j]] = [tb[j], ta[i]];
      const v = obj(teams);
      if (v < best.val) best = { teams: JSON.parse(JSON.stringify(teams)), val: v };
      else [ta[i], tb[j]] = [tb[j], ta[i]];
    }
    return { teams: best.teams, spread: spread(best.teams), repeats: repeatPairs(best.teams) };
  }

  function render(stats, result, med) {
    const colors = [['#EEEDFE', '#3C3489', '#7F77DD'], ['#E1F5EE', '#085041', '#1D9E75'], ['#FAECE7', '#712B13', '#D85A30'], ['#E6F1FB', '#0C447C', '#378ADD']];
    const sums = result.teams.map(t => t.reduce((s, i) => s + stats[i].final, 0));
    const order = [...result.teams.keys()].sort((a, b) => sums[b] - sums[a]);
    const max = Math.max(...sums);
    $('#tsCards').innerHTML = order.map((ti, idx) => {
      const [bg, fg, bar] = colors[idx];
      const members = result.teams[ti].map(x => stats[x]).sort((a, b) => b.final - a.final);
      return `<div class="ts-card">
        <div class="ts-head"><span class="ts-letter" style="background:${bg};color:${fg}">${idx + 1}</span><strong>${sums[ti].toFixed(1)} 分</strong></div>
        <div class="ts-barwrap"><div class="ts-bar" style="width:${(sums[ti] / max * 100).toFixed(1)}%;background:${bar}"></div></div>
        ${members.map(s => `<div class="ts-player"><span>${escapeHtml(s.input)}${s.resolved ? `<small class="ts-note">→${escapeHtml(s.n)}</small>` : ''}<small class="ts-sub">${s.note || `${s.g}场${s.tg ? `+${s.tg}锦标赛` : ''} · ${(s.w * 100).toFixed(0)}%胜率`}</small></span><b>${s.final.toFixed(1)}</b></div>`).join('')}
      </div>`;
    }).join('');
    const text = order.map((ti, idx) => `${idx + 1}队（${sums[ti].toFixed(1)}分）：${result.teams[ti].map(x => stats[x]).sort((a, b) => b.final - a.final).map(s => s.input).join('、')}`).join('\n');
    $('#tsText').textContent = text + `\n\n算法：产出=得分+1.8助+1.8断+1.2帽+0.6板；综合=产出×60%+胜率×40%；中位数 ${med.toFixed(1)}；最大差距 ${result.spread.toFixed(1)} 分；与上届同队重复 ${result.repeats} 对`;
    $('#tsStatus').textContent = `均衡度：最大差距 ${result.spread.toFixed(1)} 分 · 无数据取中位 ${med.toFixed(1)} · 与上届同队重复 ${result.repeats} 对`;
    $('#tsOut').hidden = false;
    $('#tsOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function run() {
    const names = parseNames($('#tsNames').value);
    if (names.length < 8) { $('#tsStatus').textContent = '至少输入 8 个人名。'; $('#tsOut').hidden = false; return; }
    const button = $('#tsRun');
    button.disabled = true;
    $('#tsStatus').textContent = '正在计算评分与均衡方案…';
    try {
      await ensureData();
      const resolved = resolveNames(names);
      const manual = parseManual($('#tsManual').value);
      const boost = $('#tsBoost').checked ? 2 : 1;
      const { stats, med } = compute(resolved, manual, boost);
      lastStats = stats; lastNames = { med, avoid: $('#tsAvoid').checked };
      render(stats, optimize(stats, lastNames.avoid), med);
    } catch (e) { $('#tsStatus').textContent = '计算失败：' + (e.message || e); }
    finally { button.disabled = false; }
  }

  $('#tsRun').onclick = run;
  $('#tsAgain').onclick = () => { if (lastStats) render(lastStats, optimize(lastStats, lastNames.avoid), lastNames.med); };
  $('#tsCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#tsText').textContent); $('#tsStatus').textContent = '文字版已复制，可直接转发微信群。'; }
    catch { $('#tsStatus').textContent = '复制失败，请手动全选文字版复制。'; }
  };
}
