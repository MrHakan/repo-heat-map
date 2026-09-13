const fmt = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});
const dateFmt = new Intl.DateTimeFormat('en',{month:'short',day:'numeric',year:'numeric'});
const monthFmt = new Intl.DateTimeFormat('en',{month:'short'});
let data={generatedAt:null,totals:{},repos:[]};
const $=(s)=>document.querySelector(s);
const esc=(s='')=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const num=(n)=>fmt.format(Number(n)||0);
const cnum=(n)=>compact.format(Number(n)||0);
const day=(v)=>v?dateFmt.format(new Date(v)):'—';

async function load(){
  try{
    const res=await fetch(`data/stats.json?v=${Date.now()}`,{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    data=await res.json();
    render();
  }catch(err){
    document.querySelectorAll('.loading').forEach(el=>el.textContent=`Stats unavailable: ${err.message}`);
  }
}

function render(){
  $('#generatedAt').textContent=data.generatedAt?`updated ${day(data.generatedAt)}`:'deep stats pending';
  $('#metricRepos').textContent=num(data.totals.repos);
  $('#metricCommits52').textContent=num(data.totals.commits52);
  $('#metricFiles').textContent=cnum(data.totals.fileTouches52);
  $('#metricLifetime').textContent=num(data.totals.lifetimeCommits);
  $('#metricChurn').textContent=cnum(data.totals.churn52);
  $('#metricNet').textContent=`${(data.totals.additions52||0)-(data.totals.deletions52||0)>=0?'+':''}${cnum((data.totals.additions52||0)-(data.totals.deletions52||0))}`;

  renderHeatmap();
  rank('#commitRanking','commits52',10,(v)=>num(v));
  rank('#fileRanking','fileTouches52',10,(v,r)=>`${cnum(v)}${r.fileTouchesCapped?' +':''}`);
  rank('#churnRanking','churn52',10,(v)=>cnum(v));
  renderWorkStyleMap();
  balance();
  rank('#consistencyChart','consistency',10,(v)=>`${v}%`);
  rank('#filesPerCommitChart','filesPerCommit52',10,(v)=>Number(v).toFixed(1));
  rank('#linesPerCommitChart','linesPerCommit52',10,(v)=>cnum(v));
  trend();
  rank('#velocityChart','commitsPer30DaysOfAge',10,(v)=>Number(v).toFixed(1));
  fingerprints();
  table();
  $('#repoSearch').addEventListener('input',table);
  $('#repoSort').addEventListener('change',table);
}

function tracked(){return data.repos.filter(r=>r.weeks?.length).sort((a,b)=>b.commits52-a.commits52).slice(0,16)}
function normalizeWeeks(weeks){const a=(weeks||[]).slice(-52);return [...Array.from({length:Math.max(0,52-a.length)},()=>({week:null,total:0})),...a]}
function heatLevel(v,max){if(!v||!max)return 0;const q=v/max;return q<=.25?1:q<=.5?2:q<=.75?3:4}
function renderHeatmap(){
  const root=$('#heatmap'),repos=tracked();root.classList.remove('loading');
  if(!repos.length){root.textContent='No deep commit statistics yet. Trigger the analytics workflow once.';return}
  const seed=normalizeWeeks(repos.find(r=>r.weeks.length)?.weeks||[]);
  const dates=seed.map((w,i)=>w.week?new Date(w.week*1000):new Date(Date.now()-(51-i)*604800000));
  let html='<div class="heatmap"><div></div>'+dates.map((d,i)=>`<div class="heat-month">${i===0||d.getMonth()!==dates[i-1].getMonth()?monthFmt.format(d):''}</div>`).join('');
  for(const r of repos){
    const weeks=normalizeWeeks(r.weeks),max=Math.max(0,...weeks.map(w=>w.total||0));
    html+=`<div class="heat-label"><a href="${esc(r.url)}">${esc(r.name)}</a></div>`;
    for(let i=0;i<52;i++){
      const w=weeks[i],title=`${r.name}: ${w.total||0} commits · week of ${day(dates[i])}`;
      html+=`<span class="heat-cell" data-level="${heatLevel(w.total||0,max)}" title="${esc(title)}"></span>`;
    }
  }
  root.innerHTML=html+'</div>';
}

function rank(sel,key,count,format){
  const root=$(sel);root.classList.remove('loading');
  const rows=[...data.repos].filter(r=>(Number(r[key])||0)>0).sort((a,b)=>(b[key]||0)-(a[key]||0)).slice(0,count);
  if(!rows.length){root.textContent='No data yet.';return}
  const max=rows[0][key]||1;
  root.innerHTML=rows.map(r=>`<div class="rank-row"><a class="rank-name" href="${esc(r.url)}">${esc(r.name)}</a><div class="bar"><i style="width:${Math.max(2,(r[key]/max)*100)}%"></i></div><span class="rank-value">${format(r[key],r)}</span></div>`).join('');
}

function renderWorkStyleMap(){
  const root=$('#workStyleMap');root.classList.remove('loading');
  const rows=data.repos.filter(r=>(r.commits52||0)>0&&(r.filesPerCommit52||0)>0);
  if(!rows.length){root.textContent='File-change telemetry is not available yet.';return}

  const w=980,h=360,p={t:22,r:28,b:44,l:58};
  const iw=w-p.l-p.r,ih=h-p.t-p.b;
  const maxX=Math.max(1,...rows.map(r=>r.commits52||0));
  const maxY=Math.max(1,...rows.map(r=>r.filesPerCommit52||0));
  const maxChurn=Math.max(1,...rows.map(r=>r.churn52||0));
  const x=v=>p.l+(v/maxX)*iw;
  const y=v=>p.t+ih-(v/maxY)*ih;
  const radius=v=>4+Math.sqrt((v||0)/maxChurn)*11;
  const grid=[.25,.5,.75,1].map(q=>`<line class="gridline" x1="${p.l}" x2="${w-p.r}" y1="${p.t+ih-q*ih}" y2="${p.t+ih-q*ih}"/><line class="gridline" y1="${p.t}" y2="${p.t+ih}" x1="${p.l+q*iw}" x2="${p.l+q*iw}"/>`).join('');
  const yLabels=[0,.25,.5,.75,1].map(q=>`<text class="axis-label" text-anchor="end" x="${p.l-8}" y="${p.t+ih-q*ih+3}">${(maxY*q).toFixed(maxY<10?1:0)}</text>`).join('');
  const xLabels=[0,.25,.5,.75,1].map(q=>`<text class="axis-label" text-anchor="middle" x="${p.l+q*iw}" y="${h-12}">${Math.round(maxX*q)}</text>`).join('');

  const points=rows.map(r=>{
    const title=`${r.name} · ${num(r.commits52)} commits · ${Number(r.filesPerCommit52).toFixed(1)} files/commit · ${cnum(r.churn52)} lines touched`;
    return `<a href="${esc(r.url)}"><circle class="scatter-dot" cx="${x(r.commits52)}" cy="${y(r.filesPerCommit52)}" r="${radius(r.churn52)}"><title>${esc(title)}</title></circle></a>`;
  }).join('');

  const labels=[...rows].sort((a,b)=>(b.commits52*b.filesPerCommit52)-(a.commits52*a.filesPerCommit52)).slice(0,6).map(r=>`<text class="scatter-label" x="${Math.min(w-p.r-70,x(r.commits52)+10)}" y="${Math.max(14,y(r.filesPerCommit52)-8)}">${esc(r.name)}</text>`).join('');

  root.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Repositories plotted by commit count and files touched per commit">${grid}${yLabels}${xLabels}<text class="axis-title" x="${p.l+iw/2}" y="${h-1}" text-anchor="middle">commits · 52 weeks</text><text class="axis-title" transform="translate(12 ${p.t+ih/2}) rotate(-90)" text-anchor="middle">files touched / commit</text>${points}${labels}</svg>`;
}

function balance(){
  const root=$('#balanceChart');root.classList.remove('loading');
  const rows=[...data.repos].filter(r=>r.churn52>0).sort((a,b)=>b.churn52-a.churn52).slice(0,8);
  if(!rows.length){root.textContent='No code-frequency data yet.';return}
  root.innerHTML=rows.map(r=>{
    const t=r.churn52||1,a=(r.additions52/t)*100,d=100-a;
    return `<div class="balance-row"><div class="balance-name">${esc(r.name)}</div><div><div class="balance-stack" title="+${num(r.additions52)} / -${num(r.deletions52)}"><i class="balance-add" style="width:${a}%"></i><i class="balance-del" style="width:${d}%"></i></div><div class="balance-meta"><span>+${cnum(r.additions52)}</span><span>−${cnum(r.deletions52)}</span></div></div></div>`;
  }).join('');
}

function weeklyTotals(){
  const totals=Array(52).fill(0);
  for(const r of data.repos) normalizeWeeks(r.weeks).forEach((w,i)=>totals[i]+=w.total||0);
  return totals;
}

function trend(){
  const root=$('#weeklyTrend');root.classList.remove('loading');const vals=weeklyTotals();
  if(!vals.some(Boolean)){root.textContent='No weekly data yet.';return}
  const w=640,h=230,p={t:10,r:8,b:28,l:34},iw=w-p.l-p.r,ih=h-p.t-p.b,max=Math.max(1,...vals),x=i=>p.l+(i/51)*iw,y=v=>p.t+ih-(v/max)*ih;
  const pts=vals.map((v,i)=>[x(i),y(v)]),line=pts.map(([a,b],i)=>`${i?'L':'M'}${a.toFixed(1)},${b.toFixed(1)}`).join(' '),area=`${line} L${x(51)},${p.t+ih} L${x(0)},${p.t+ih} Z`;
  const grid=[0,.5,1].map(q=>{const gy=p.t+ih-q*ih;return `<line class="gridline" x1="${p.l}" x2="${w-p.r}" y1="${gy}" y2="${gy}"/><text class="axis-label" x="0" y="${gy+3}">${Math.round(max*q)}</text>`}).join('');
  root.innerHTML=`<svg viewBox="0 0 ${w} ${h}">${grid}<path class="area" d="${area}"/><path class="trend" d="${line}"/></svg>`;
}

function fingerprints(){
  const root=$('#fingerprints');root.classList.remove('loading');const usable=data.repos.filter(r=>r.name);
  if(!usable.length){root.textContent='No data yet.';return}
  const best=(key,filter=()=>true)=>[...usable].filter(filter).sort((a,b)=>(b[key]||0)-(a[key]||0))[0];
  const oldest=[...usable].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt))[0],newest=[...usable].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0];
  const cards=[
    ['commit magnet',best('commits52'),r=>`${num(r.commits52)} commits / 52w`],
    ['file storm',best('fileTouches52'),r=>`${cnum(r.fileTouches52)} file touches`],
    ['churn monster',best('churn52'),r=>`${cnum(r.churn52)} lines touched`],
    ['widest commits',best('filesPerCommit52'),r=>`${Number(r.filesPerCommit52).toFixed(1)} files / commit`],
    ['heaviest commits',best('linesPerCommit52'),r=>`${cnum(r.linesPerCommit52)} lines / commit`],
    ['most consistent',best('consistency'),r=>`${r.consistency}% active weeks`],
    ['peak week',best('peakWeekCommits'),r=>`${num(r.peakWeekCommits)} commits in one week`],
    ['fastest velocity',best('commitsPer30DaysOfAge'),r=>`${Number(r.commitsPer30DaysOfAge).toFixed(1)} commits / 30d age`],
    ['oldest repo',oldest,r=>`created ${day(r.createdAt)}`],
    ['newest repo',newest,r=>`created ${day(r.createdAt)}`],
    ['largest net growth',best('netLines52'),r=>`${r.netLines52>=0?'+':''}${cnum(r.netLines52)} net lines`],
    ['most compact changes',best('commits52',r=>(r.filesPerCommit52||0)>0&&r.filesPerCommit52<=3),r=>`${Number(r.filesPerCommit52).toFixed(1)} files / commit`],
  ];
  root.innerHTML=cards.filter(([,r])=>r).map(([label,r,sub])=>`<article class="fingerprint"><span>${label}</span><strong title="${esc(r.name)}">${esc(r.name)}</strong><small>${sub(r)}</small></article>`).join('');
}

function table(){
  const body=$('#repoTableBody'),q=($('#repoSearch')?.value||'').trim().toLowerCase(),sort=$('#repoSort')?.value||'commits52';
  let rows=data.repos.filter(r=>!q||[r.name,r.description,r.language].filter(Boolean).some(v=>String(v).toLowerCase().includes(q)));
  rows.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='pushedAt'?new Date(b.pushedAt)-new Date(a.pushedAt):(b[sort]||0)-(a[sort]||0));
  body.innerHTML=rows.map(r=>`<tr><td><a class="repo-link" href="${esc(r.url)}">${esc(r.name)}</a></td><td>${num(r.commits52)}</td><td title="${r.fileTouchesCapped?'capped after 1,000 commits':''}">${cnum(r.fileTouches52)}${r.fileTouchesCapped?' +':''}</td><td>${cnum(r.churn52)}</td><td>${Number(r.filesPerCommit52||0).toFixed(1)}</td><td>${r.consistency||0}%</td><td>${num(r.peakWeekCommits)}</td><td>${day(r.pushedAt)}</td></tr>`).join('')||'<tr><td colspan="8">No matches.</td></tr>';
}

load();
