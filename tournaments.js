import { aggregate, statKeys, statLabels, chinaDate } from './lib/statistics.js';
import { prepareImage, recognizeScreenshot } from './screenshot-upload.js';

export function renderTournamentSection(tournaments, escapeHtml, ratingButton) {
  const chooser = document.querySelector('#tournamentChoice');
  const previous = chooser.value;
  chooser.innerHTML = tournaments.map(t=>`<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.date)}</option>`).join('');
  if (tournaments.some(t=>String(t.id)===previous)) chooser.value=previous;
  chooser.disabled=!tournaments.length;
  const render=()=>{
    const tournament=tournaments.find(t=>String(t.id)===chooser.value);
    const content=document.querySelector('#tournamentContent');
    if (!tournament) {content.innerHTML='<p class="empty">暂无独立锦标赛，赛事启动后在这里展示赛事荣誉。</p>';return;}
    const players=aggregate(tournament.records);
    const bracket=(tournament.bracket?.rounds||[]).map(round=>`<div class="bracket-round"><h4>${escapeHtml(round.name)}</h4>${round.matches.map(match=>`<article class="bracket-match"><div class="${match.winner===match.a?'winner':''}"><span>${escapeHtml(match.a)}</span><b>${match.aScore}</b></div><div class="${match.winner===match.b?'winner':''}"><span>${escapeHtml(match.b)}</span><b>${match.bScore}</b></div></article>`).join('')}</div>`).join('');
    const best={}; statKeys.forEach(k=>best[k]=players.slice().sort((a,b)=>b.records[k]-a.records[k]||a.nickname.localeCompare(b.nickname,'zh-CN')).slice(0,5));
    const mvp=players.find(p=>p.nickname===tournament.mvp);
    content.innerHTML=`<div class="tournament-banner"><div><p class="eyebrow">${tournament.status==='completed'?'FINAL RESULTS':'LIVE TOURNAMENT'}</p><h3>${escapeHtml(tournament.name)}</h3><p>${escapeHtml(tournament.date)} · ${new Set(tournament.records.map(r=>r.roundNumber)).size} 场 · ${players.length} 位选手 · ${tournament.status==='completed'?'已结束':'进行中，统计持续更新'}</p></div><div class="tournament-mvp"><small>赛事 MVP</small><strong>${escapeHtml(tournament.mvp||'待公布')}</strong>${tournament.mvp ? ratingButton(tournament.mvp) : ''}${mvp?`<div class="mvp-stats">${statKeys.map(k=>`<span>${statLabels[k]} <b>${mvp[k].toFixed(1)}</b></span>`).join('')}</div>`:''}</div></div>
      <div class="tournament-podium">${['冠军','亚军','季军'].map((title,i)=>`<article class="honor-item ${i===0?'gold-winner':''}"><p class="eyebrow">0${i+1} / ${title}</p><h3>${title}阵容</h3>${tournament.podium[i].map(name=>`<div class="archived-player"><strong>${escapeHtml(name)}</strong>${ratingButton(name)}</div>`).join('')||'<p>待公布</p>'}</article>`).join('')}</div>
      <div class="tournament-bracket"><div class="section-kicker">BO3 ELIMINATION · 对战赛程</div><div class="bracket-scroll">${bracket||'<p class="empty">暂未录入淘汰赛树。</p>'}</div></div><div class="tournament-records"><p class="field-help">本届有几场就展示几场，不设 20 场门槛；场均榜展示前五。</p><div class="honor-grid">${statKeys.map(k=>`<article class="honor-item"><h3>场均${statLabels[k]} · TOP 5</h3><ol class="record-list">${players.sort((a,b)=>b[k]-a[k]||b.games-a.games||a.nickname.localeCompare(b.nickname,'zh-CN')).slice(0,5).map((p,i)=>`<li class="${i===0?'gold-winner':''}"><div><strong>${escapeHtml(p.nickname)}</strong><small>${p.games} 场</small>${ratingButton(p.nickname)}</div><b>${p[k].toFixed(1)}</b></li>`).join('')}</ol></article>`).join('')}</div><div class="single-records"><h3>单场最高记录</h3>${statKeys.map(k=>`<div><strong>${statLabels[k]}</strong>${best[k].slice(0,5).map(p=>`<span>${escapeHtml(p.nickname)} <b>${p.records[k]}</b></span>`).join('')}</div>`).join('')}</div></div>`;
  };
  chooser.onchange=render;render();
}

export function initializeTournamentAdmin(api, escapeHtml) {
  const root=document.querySelector('#tournamentAdmin');
  root.innerHTML=`<div class="card-title"><div><p class="eyebrow">TOURNAMENT DESK</p><h2>独立锦标赛管理</h2></div></div><p class="field-help">数据完全独立，不计入日常榜单、赛季、关系或月度荣誉。每届按一天录入；通常不超过 12 场，支持更多场次。保存中途进度可选“进行中”，核对完整后结束。新昵称可直接填写。</p>
    <label>赛事档案<select id="tournamentEditorChoice"><option value="">新建锦标赛</option></select></label><button type="button" class="ghost" id="reloadTournaments">重新加载已保存赛事</button>
    <form id="tournamentForm"><div class="form-grid two"><label>赛事名称<input name="name" maxlength="80" required></label><label>比赛日期<input name="date" type="date" min="2000-01-01" max="2100-12-31" required></label></div>
    <div class="form-grid two"><label>赛事状态<select name="status"><option value="ongoing">进行中</option><option value="completed">已结束</option></select></label><label>MVP 昵称<input name="mvp" maxlength="80" placeholder="手动指定本届参赛选手"></label></div>
    <div class="form-grid">${['冠军','亚军','季军'].map((title,i)=>`<label>${title}阵容<textarea name="podium${i}" rows="2" placeholder="每行一个昵称，共 5 人"></textarea></label>`).join('')}</div><label>BO3 淘汰赛树（JSON）<textarea name="bracket" rows="6" placeholder='{"rounds":[{"name":"半决赛","matches":[{"a":"队伍A","b":"队伍B","aScore":2,"bScore":1,"winner":"队伍A"}]}]}'></textarea></label>
    <p class="field-help">每行填写一名选手一场的数据。同场编号相同，胜负用于区分两队，每队最多 5 人。结束赛事前每场须满 10 人，前三名各填 5 名本届参赛选手，MVP 也须已参赛。删除行后需保存才生效。</p>
    <div class="tournament-ocr"><strong>截图识别锦标赛数据</strong><span>每张截图对应一场比赛，识别结果会加入下方草稿，仍需核对后保存。</span><input id="tournamentImages" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple><button type="button" class="ghost" id="recognizeTournamentImages">选择截图并识别</button><p id="tournamentOcrStatus" role="status"></p></div>
    <div class="table-wrap"><table class="batch-table"><thead><tr><th>场次</th><th>昵称</th>${statKeys.map(k=>`<th>${statLabels[k]}</th>`).join('')}<th>胜负</th><th>操作</th></tr></thead><tbody id="tournamentDraftRows"></tbody></table></div>
    <div class="tournament-actions"><button type="button" class="ghost" id="addTournamentRound">增加一场（10 行）</button><button type="button" class="ghost" id="addTournamentRow">增加选手行</button><button class="primary" type="submit">保存本届锦标赛 →</button></div></form><p id="tournamentAdminStatus" role="status"></p>`;
  const form=root.querySelector('form'), chooser=root.querySelector('#tournamentEditorChoice'), tbody=root.querySelector('tbody'), message=root.querySelector('[role="status"]');
  let tournaments=[], current=null, saving=false, loaded=false;
  const field=name=>form.elements.namedItem(name);
  const appendRow=(record={})=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><input data-key="roundNumber" aria-label="场次" type="number" min="1" max="10000" required value="${escapeHtml(record.roundNumber??1)}"></td><td><input data-key="nickname" aria-label="昵称" maxlength="80" required value="${escapeHtml(record.nickname??'')}"></td>${statKeys.map(k=>`<td><input data-key="${k}" aria-label="${statLabels[k]}" type="number" min="0" max="10000" required value="${escapeHtml(record[k]??'')}"></td>`).join('')}<td><select data-key="result" aria-label="胜负"><option value="W">胜</option><option value="L" ${record.result==='L'?'selected':''}>负</option></select></td><td><button type="button" class="ghost">删除行</button></td>`;
    tr.querySelector('button').onclick=()=>tr.remove();tbody.append(tr);
  };
  const edit=()=>{
    current=tournaments.find(t=>String(t.id)===chooser.value)||null;
    form.reset();field('date').value=current?.date||chinaDate();
    field('name').value=current?.name||'';field('status').value=current?.status||'ongoing';field('mvp').value=current?.mvp||'';
    for(let i=0;i<3;i++)field(`podium${i}`).value=(current?.podium[i]||[]).join('\n');
    field('bracket').value=current?.bracket?.rounds?.length?JSON.stringify(current.bracket,null,2):'';
    tbody.innerHTML='';(current?.records||[]).forEach(appendRow);
    message.textContent=current?'正在编辑已保存赛事；修改后请保存。':'填写名称和日期即可启动锦标赛，随后可持续补录比赛。';
  };
  const load=async(selected=chooser.value)=>{
    const response=await api('admin/tournaments');tournaments=response.tournaments;
    chooser.innerHTML='<option value="">新建锦标赛</option>'+tournaments.map(t=>`<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.date)}</option>`).join('');
    chooser.value=tournaments.some(t=>String(t.id)===String(selected))?String(selected):'';edit();loaded=true;
  };
  chooser.onchange=edit;
  root.querySelector('#reloadTournaments').onclick=()=>load().catch(error=>message.textContent=error.message);
  root.querySelector('#addTournamentRow').onclick=()=>appendRow({roundNumber:Math.max(1,...[...tbody.querySelectorAll('[data-key="roundNumber"]')].map(input=>Number(input.value)||1))});
  root.querySelector('#addTournamentRound').onclick=()=>{
    const roundNumber=Math.max(0,...[...tbody.querySelectorAll('[data-key="roundNumber"]')].map(input=>Number(input.value)||0))+1;
    for(let i=0;i<10;i++)appendRow({roundNumber,result:i<5?'W':'L'});
  };
  const imagePicker=root.querySelector('#tournamentImages'), ocrButton=root.querySelector('#recognizeTournamentImages'), ocrStatus=root.querySelector('#tournamentOcrStatus');
  ocrButton.onclick=()=>imagePicker.click();
  imagePicker.onchange=async()=>{
    const files=[...imagePicker.files]; if(!files.length)return;
    const date=field('date').value; let round=Math.max(0,...[...tbody.querySelectorAll('[data-key="roundNumber"]')].map(input=>Number(input.value)||0))+1;
    ocrButton.disabled=true; ocrStatus.textContent=`正在识别 ${files.length} 张截图…`;
    try { for(const file of files) { const image=await prepareImage(file); const data=await recognizeScreenshot(api,image,statKeys); data.rows.forEach(row=>appendRow({...row,roundNumber:round})); round++; } ocrStatus.textContent='识别完成，请核对下方数据及场次后保存。'; }
    catch(error) { ocrStatus.textContent=`识别失败：${error.message}`; } finally { imagePicker.value=''; ocrButton.disabled=false; }
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(saving)return;saving=true;
    const records=[...tbody.rows].map(tr=>Object.fromEntries([...tr.querySelectorAll('[data-key]')].map(input=>[input.dataset.key,input.value])));
    let bracket={rounds:[]}; try { if(field('bracket').value.trim()) bracket=JSON.parse(field('bracket').value); } catch { message.textContent='淘汰赛树 JSON 格式不正确'; saving=false; return; }
    const body={name:field('name').value,date:field('date').value,status:field('status').value,mvp:field('mvp').value,podium:[0,1,2].map(i=>field(`podium${i}`).value.split('\n').map(n=>n.trim()).filter(Boolean)),records,bracket,...(current?{revision:current.revision}:{})};
    const endpoint=current?`admin/tournaments/${current.id}`:'admin/tournaments';
    const method=current?'PUT':'POST';
    root.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);message.textContent='正在保存锦标赛…';
    try {
      const response=await api(endpoint,{method,body:JSON.stringify(body)});
      const saved=response.tournament;
      tournaments=[saved,...tournaments.filter(t=>t.id!==saved.id)];
      chooser.innerHTML='<option value="">新建锦标赛</option>'+tournaments.map(t=>`<option value="${t.id}">${escapeHtml(t.name)} · ${escapeHtml(t.date)}</option>`).join('');
      chooser.value=String(saved.id);edit();message.textContent='锦标赛已保存，公开分区自动刷新。';
    } catch(error){message.textContent=error.message;}
    finally{saving=false;root.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);}
  };
  // Loaded only after the existing administrator role check succeeds.
  return ()=>loaded ? Promise.resolve() : load().catch(error=>{message.textContent=error.message;});
}
