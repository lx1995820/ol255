export const statKeys = ['pts', 'reb', 'ast', 'stl', 'blk'];
export const statLabels = { pts: '得分', reb: '篮板', ast: '助攻', stl: '抢断', blk: '盖帽' };
export function chinaDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function cycleKey(date) {
  const [year, month, day] = date.split('-').map(Number);
  const cycle = day >= 11 ? new Date(Date.UTC(year, month - 1, 1)) : new Date(Date.UTC(year, month - 2, 1));
  return cycle.toISOString().slice(0, 7);
}
export function cycleStart(date) { return `${cycleKey(date)}-11`; }
export function cycleMinimum(records) { return Math.max(1, Math.ceil(records.length / 10 * 0.3)); }
export function aggregate(records) {
  const grouped = new Map();
  for (const g of records) {
    const p = grouped.get(g.nickname) ?? { nickname: g.nickname, games: 0, wins: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, records: Object.fromEntries(statKeys.map(k => [k, 0])) };
    p.games++; p.wins += g.result === 'W' ? 1 : 0;
    for (const k of statKeys) { p[k] += g[k]; p.records[k] = Math.max(p.records[k], g[k]); }
    grouped.set(g.nickname, p);
  }
  return [...grouped.values()].map(p => { for (const k of statKeys) p[k] /= p.games; return p; });
}
export const rate = p => p.games ? p.wins / p.games * 100 : 0;
export const overall = p => p.pts + p.reb + p.ast;
// 防守评分（DPOY / 最佳防守阵容）：篮板按 0.5 计
export const defenseScore = p => p.stl + p.blk + p.reb * 0.5;
// AI 评分维度：五项场均 + 胜率；口径 = MVP 策略（胜率 60% + 标准化数据 40%）
export const aiDimKeys = ['pts', 'reb', 'ast', 'stl', 'blk', 'winRate'];
export const aiDimValue = (p, key) => key === 'winRate' ? rate(p) : p[key];
// 边际价值权重（参考 NBA 边际价值理论与 Hollinger Game Score）：
// 得分=1.0（直接兑现）；助攻≈1.8（一次助攻约创造 2 分）；抢断≈1.8（球权翻转+攻防转换价值最高）；
// 盖帽≈1.2（终结出手+大概率转换球权）；篮板≈0.6（前场板 1.0 / 后场板 0.4 的混合估值）
export const aiWeights = { pts: 1.0, reb: 0.6, ast: 1.8, stl: 1.8, blk: 1.2 };
// 场均边际得分价值：每次回合事件按权重折算为得分贡献（五项全能均计入，抢断盖帽不再缺席总分）
export const marginalValue = p => p.pts * aiWeights.pts + p.reb * aiWeights.reb + p.ast * aiWeights.ast + p.stl * aiWeights.stl + p.blk * aiWeights.blk;
// AI 评分：基准取「上榜池」（满 minGames 场）中综合排名第 1、2 名选手的均值 = 100 分；
// 池外选手也按同一基准给分，但不参与定基准（避免小样本选手把基准顶飞）
export function aiRatings(players, minGames = 1) {
  const scores = new Map(), dims = new Map();
  if (!players.length) return { scores, dims, meta: null };
  const eligible = players.filter(p => p.games >= minGames);
  const pool = eligible.length >= 2 ? eligible : players;
  const maxMV = Math.max(...pool.map(marginalValue), 1);
  const mvp = p => rate(p) * 0.6 + marginalValue(p) / maxMV * 100 * 0.4;
  const topTwo = rank(pool, mvp).slice(0, 2);
  const runnerUp = topTwo[1] ?? topTwo[0];
  const scoreBase = (mvp(topTwo[0]) + mvp(runnerUp)) / 2 || 1;
  // 六维基准：上榜池中「该维度」第 1、2 名的均值——由各维度最强者锚定，
  // 避免综合前二恰好是后卫时篮板/盖帽基准过低、大批选手顶格 150 失去区分度
  const dimBase = Object.fromEntries(aiDimKeys.map(key => {
    const top2 = rank(pool, p => aiDimValue(p, key)).slice(0, 2);
    const second = top2[1] ?? top2[0];
    return [key, (aiDimValue(top2[0], key) + aiDimValue(second, key)) / 2 || 1];
  }));
  for (const p of players) {
    scores.set(p.nickname, mvp(p) / scoreBase * 100);
    // 各维度 150 分封顶，防止基准偏弱时出现几百分的爆表值
    dims.set(p.nickname, Object.fromEntries(aiDimKeys.map(key => [key, Math.min(aiDimValue(p, key) / dimBase[key] * 100, 150)])));
  }
  return { scores, dims, meta: { maxMV, scoreBase, poolLeaders: [topTwo[0].nickname, runnerUp.nickname] } };
}
export const rank = (players, score) => [...players].sort((a,b) => score(b)-score(a) || b.games-a.games || a.nickname.localeCompare(b.nickname,'zh-CN'));
export function playerRelationships(records, nickname) {
  const rounds = new Map(), teammates = new Map(), trios = new Map(), opponents = new Map();
  for (const game of records) if (game.roundNumber != null) {
    const key = JSON.stringify([game.date, game.roundNumber]);
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key).push(game);
  }
  const add = (map, names, won) => {
    const key = JSON.stringify(names);
    const item = map.get(key) ?? { names, games: 0, wins: 0 };
    item.games++;
    item.wins += won ? 1 : 0;
    map.set(key, item);
  };
  for (const rows of rounds.values()) {
    if (rows.length > 10 || rows.filter(game => game.result === 'W').length > 5 || rows.filter(game => game.result === 'L').length > 5 || new Set(rows.map(game => game.nickname)).size !== rows.length || rows.some(game => game.result !== 'W' && game.result !== 'L')) continue;
    const player = rows.find(game => game.nickname === nickname);
    if (!player) continue;
    const team = rows.filter(game => game.result === player.result && game.nickname !== nickname).sort((first, second) => first.nickname.localeCompare(second.nickname, 'zh-CN'));
    const won = player.result === 'W';
    for (let first = 0; first < team.length; first++) {
      add(teammates, [team[first].nickname], won);
      for (let second = first + 1; second < team.length; second++) add(trios, [team[first].nickname, team[second].nickname], won);
    }
    for (const opponent of rows.filter(game => game.result !== player.result)) add(opponents, [opponent.nickname], won);
  }
  const ordered = (map, direction) => [...map.values()].filter(item => item.games >= 10).sort((first, second) => direction * (rate(second) - rate(first)) || second.games - first.games || JSON.stringify(first.names).localeCompare(JSON.stringify(second.names), 'zh-CN')).slice(0, 3);
  return { bestTeammates: ordered(teammates, 1), worstTeammates: ordered(teammates, -1), bestTrios: ordered(trios, 1), bestOpponents: ordered(opponents, 1), worstOpponents: ordered(opponents, -1) };
}
export function awardsFor(records) {
  const players = aggregate(records).filter(p => p.games >= cycleMinimum(records));
  if (!players.length) return [];
  const maximum = Math.max(1, ...players.map(overall));
  const scores = [['月度 MVP', p => rate(p)*0.6 + overall(p)/maximum*40], ['DPOY', defenseScore], ...statKeys.map(k => [`${statLabels[k]}王`, p => p[k]])];
  const awards = scores.map(([title, score]) => { const p = rank(players,score)[0]; return { title, names: [p.nickname], value: score(p).toFixed(1), games: p.games }; });
  const offense = rank(players, overall), defense = rank(players, defenseScore);
  for (const [title,list] of [['最佳一阵',offense.slice(0,5)],['最佳二阵',offense.slice(5,10)],['最佳防守1阵',defense.slice(0,5)],['最佳防守2阵',defense.slice(5,10)]]) if (list.length) awards.push({title,names:list.map(p => p.nickname),value:'',games:0});
  return awards;
}
// 各梗标签的达成条件（用于界面悬停提示）
export const tagTips = {
  '大腿认证': '满 20 场且胜率 ≥ 60%',
  '得分机器': '场均得分前 3（满 8 场参与排名）',
  '篮板痴汉': '场均篮板前 3（满 8 场参与排名）',
  '控场大师': '场均助攻前 3（满 8 场参与排名）',
  '内线大闸': '（抢断+盖帽）总产出前 3（满 8 场参与排名）',
  '死亡缠绕': '抢断总产出前 3（满 8 场参与排名）',
  '三双猛男': '综合数据（得分+篮板+助攻）前 3（满 8 场参与排名）',
  '历史留名': '保持某项单场最高纪录（得分/篮板/助攻/抢断/盖帽）',
  '关键先生': '获胜局比失利局场均得分高 3 分以上',
  '大刷子': '场均得分前 5，但胜率不足 45%',
  '孤胆英雄': '场均助攻 ≤ 2 且场均得分 > 10',
};
export function tagsFor(records) {
  const players = aggregate(records), eligible = players.filter(p=>p.games>=8), tags = new Map(players.map(p=>[p.nickname,[]]));
  const top = (p,score,n=3) => rank(eligible,score).slice(0,n).some(x=>x.nickname===p.nickname);
  for (const p of players) {
    const own = records.filter(g=>g.nickname===p.nickname), wins=own.filter(g=>g.result==='W'), losses=own.filter(g=>g.result==='L');
    const avg = list => list.reduce((sum,g)=>sum+g.pts,0)/list.length;
    const conditions = [
      ['大腿认证',p.games>=20 && rate(p)>=60], ['得分机器',top(p,p=>p.pts)], ['篮板痴汉',top(p,p=>p.reb)], ['控场大师',top(p,p=>p.ast)],
      ['内线大闸',top(p,p=>(p.stl+p.blk)*p.games)], ['死亡缠绕',top(p,p=>p.stl*p.games)], ['三双猛男',top(p,overall)],
      ['历史留名',statKeys.some(k=>p.records[k]>0 && p.records[k]===Math.max(...players.map(x=>x.records[k])))],
      ['关键先生',wins.length>0 && losses.length>0 && avg(wins)-avg(losses)>3], ['大刷子',top(p,p=>p.pts,5) && rate(p)<45], ['孤胆英雄',p.ast<=2 && p.pts>10],
    ];
    tags.set(p.nickname,conditions.filter(([,yes])=>yes).map(([tag])=>tag).slice(0,5));
  }
  return tags;
}
export function relationships(records) {
  const rounds=new Map(), pairs=new Map(), triples=new Map(), rivals=new Map(), players=aggregate(records);
  for (const g of records) if(g.roundNumber!=null) { const key=`${g.date}/${g.roundNumber}`; if(!rounds.has(key)) rounds.set(key,[]); rounds.get(key).push(g); }
  const add=(map,group,win,score)=>{ const names=group.map(g=>g.nickname).sort((a,b)=>a.localeCompare(b,'zh-CN')), key=JSON.stringify(names); const item=map.get(key)??{names,games:0,wins:0,total:0}; item.games++; item.wins+=win?1:0; item.total+=score; map.set(key,item); };
  for(const rows of rounds.values()) {
    if(rows.length>10 || rows.filter(g=>g.result==='W').length>5 || rows.filter(g=>g.result==='L').length>5 || new Set(rows.map(g=>g.nickname)).size!==rows.length) continue;
    for(const result of ['W','L']) { const team=rows.filter(g=>g.result===result); if(team.length>5) continue;
      for(let a=0;a<team.length;a++) for(let b=a+1;b<team.length;b++) { const group=[team[a],team[b]]; add(pairs,group,result==='W',group.reduce((s,g)=>s+overall(g),0)/2);
        for(let c=b+1;c<team.length;c++) { const trio=[...group,team[c]]; add(triples,trio,result==='W',trio.reduce((s,g)=>s+overall(g),0)/3); }
      }
    }
    for(const a of rows) for(const b of rows) if(a.result!==b.result) { const key=JSON.stringify([a.nickname,b.nickname]); const r=rivals.get(key)??{names:[a.nickname,b.nickname],games:0,wins:0}; r.games++; r.wins+=a.result==='W'?1:0; rivals.set(key,r); }
  }
  // Ten matches plus a neutral ten-match prior reduce small-sample extremes.
  const adjusted=p=>(p.wins+5)/(p.games+10)*100;
  const nameOrder=(a,b)=>JSON.stringify(a.names).localeCompare(JSON.stringify(b.names),'zh-CN');
  const eligible=map=>[...map.values()].filter(p=>p.games>=10).map(p=>({...p,average:p.total/p.games,adjusted:adjusted(p)}));
  const best=(a,b)=>b.adjusted-a.adjusted||b.games-a.games||b.average-a.average||nameOrder(a,b);
  const enemies=[...rivals.values()].filter(p=>p.games>=10).map(p=>{
    const player=players.find(x=>x.nickname===p.names[0]);
    const outside={games:player.games-p.games,wins:player.wins-p.wins};
    return {...p,baselineGames:outside.games,adjusted:adjusted(p),drop:adjusted(outside)-adjusted(p)};
  }).filter(p=>p.baselineGames>=10 && p.drop>0).sort((a,b)=>b.drop-a.drop||b.games-a.games||nameOrder(a,b)).slice(0,5);
  const pairsEligible=eligible(pairs);
  const balanced=[...rivals.values()].filter(p=>p.games>=10 && p.names[0].localeCompare(p.names[1],'zh-CN')<0).map(p=>({...p,adjusted:adjusted(p)})).sort((a,b)=>Math.abs(rate(a)-50)-Math.abs(rate(b)-50)||b.games-a.games||nameOrder(a,b)).slice(0,5);
  return { best:pairsEligible.sort(best).slice(0,5), worst:[...pairsEligible].sort((a,b)=>a.adjusted-b.adjusted||b.games-a.games||a.average-b.average||nameOrder(a,b)).slice(0,5), triples:eligible(triples).sort(best).slice(0,5), enemies, veterans:[...pairsEligible].sort((a,b)=>b.games-a.games||best(a,b)).slice(0,5), balanced };
}
