import { DEFAULT_WAIT_PATTERN, parseProgram, serializeProgram, moveBlock, validateWaitPattern } from './parser.js';
import { alignChannels } from './alignment.js';
import { estimateCycle } from './timing.js';
import { DEMO } from './demo.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE_KEY = 'spindle-sync-workspace-v1';
const defaults = { hChannel:'1', vChannel:'2', waitPattern:DEFAULT_WAIT_PATTERN, waitParticipantMode:'exact', waitTemplate:'M{id}P{p}', cutFeed:600, rapidFeed:10000, toolChangeSeconds:8, rotationFeed:180, useProgramFeed:true, initialMacrosText:'', initialMacros:{} };
let state = { sources:{...DEMO}, filenames:{h:'horizontal.nc',v:'vertical.nc'}, settings:{...defaults}, overrides:{}, example:true, compact:false };
let blocks = {h:[],v:[]}, parsed = {}, alignment, timing, selected = null, view = 'aligned';
let history = [], future = [], drag = null, sourceDrafts = {}, toastTimer, uid = 0, renderPending = false;
let pointerHeld=false,queuedEditRender=false;
function flushEditRender(){if(queuedEditRender&&!pointerHeld&&!drag){queuedEditRender=false;render();}}
document.addEventListener('pointerdown',()=>{pointerHeld=true;},true);
for(const eventName of ['pointerup','pointercancel'])document.addEventListener(eventName,()=>{pointerHeld=false;setTimeout(flushEditRender,0);},true);
window.addEventListener('blur',()=>{pointerHeld=false;setTimeout(flushEditRender,0);});
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (saved && typeof saved.sources?.h === 'string' && typeof saved.sources?.v === 'string') state = validateProject(saved);
} catch { /* A corrupt or unavailable browser store must not stop the editor. */ }

function validateProject(input) {
  if (typeof input.sources?.h !== 'string' || typeof input.sources?.v !== 'string') throw new Error('This file does not contain both NC programs.');
  const settings = {...defaults,...input.settings};
  const validation = validateWaitPattern(settings.waitPattern);
  if (!validation.valid) throw new Error(validation.error);
  for (const key of ['cutFeed','rapidFeed','rotationFeed']) if (!Number.isFinite(Number(settings[key])) || !(Number(settings[key]) > 0)) throw new Error('Feed rates must be finite and greater than zero.');
  if (!Number.isFinite(Number(settings.toolChangeSeconds)) || !(Number(settings.toolChangeSeconds) >= 0)) throw new Error('Tool-change time must be finite and cannot be negative.');
  if (!['1','2','3','4'].includes(String(settings.hChannel)) || !['1','2','3','4'].includes(String(settings.vChannel)) || String(settings.hChannel) === String(settings.vChannel)) throw new Error('Choose two different channels from 1–4.');
  settings.hChannel=String(settings.hChannel);settings.vChannel=String(settings.vChannel);
  if(typeof settings.waitTemplate!=='string'||!settings.waitTemplate.includes('{id}'))throw new Error('The wait insertion template must contain {id}.');
  settings.waitParticipantMode=settings.waitParticipantMode==='ignore'?'ignore':'exact';
  const overrides = {};
  if (input.overrides && typeof input.overrides === 'object') for (const [key,value] of Object.entries(input.overrides)) if (Number.isFinite(value) && value >= 0) overrides[key] = value;
  const identities={h:[],v:[]},seen=new Set();
  for(const c of ['h','v'])if(Array.isArray(input.blockIdentities?.[c]))for(const item of input.blockIdentities[c]){
    if(item&&typeof item.id==='string'&&typeof item.text==='string'&&!seen.has(item.id)){identities[c].push({id:item.id,text:item.text});seen.add(item.id);}
  }
  return { sources:{h:input.sources.h,v:input.sources.v}, filenames:{h:String(input.filenames?.h || 'horizontal.nc'),v:String(input.filenames?.v || 'vertical.nc')},settings, overrides, example:!!input.example,compact:!!input.compact, blockIdentities:identities };
}
function snapshot() { return JSON.stringify(project()); }
function project() {
  return {...state, format:'spindle-sync',version:1, blockIdentities:{h:blocks.h.map(b=>({id:b.id,text:b.text})),v:blocks.v.map(b=>({id:b.id,text:b.text}))}};
}
function remember() { const current = snapshot(); if (history.at(-1) !== current) { history.push(current); if(history.length>80)history.shift(); } future=[]; updateHistory(); }
function save() {
  try { localStorage.setItem(STORAGE_KEY,snapshot()); $('#save-status').textContent='Saved locally'; }
  catch { $('#save-status').textContent='Export to save'; }
}
function toast(message,error=false) { const el=$('#toast');el.textContent=message;el.hidden=false;el.classList.toggle('error',error);clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,4200); }
function updateHistory() { $('#undo-btn').disabled=!history.length;$('#redo-btn').disabled=!future.length; }
function restore(data) { state=validateProject(data);sourceDrafts={};selected=null;blocks={h:[],v:[]};parseAll();render();save(); }
function undo() { if(!history.length)return;future.push(snapshot());restore(JSON.parse(history.pop()));toast('Change undone'); }
function redo() { if(!future.length)return;history.push(snapshot());restore(JSON.parse(future.pop()));toast('Change restored'); }

function parseAll() {
  for (const channel of ['h','v']) {
    const previous = blocks[channel].length ? blocks[channel] : (state.blockIdentities?.[channel] || []);
    const queues = new Map();
    for(const block of previous){if(!queues.has(block.text))queues.set(block.text,[]);queues.get(block.text).push(block.id);}
    parsed[channel]=parseProgram(state.sources[channel], state.settings, channel);
    blocks[channel]=parsed[channel].blocks.map(block=>({...block,id:queues.get(block.text)?.shift() || `${channel}-${Date.now().toString(36)}-${++uid}`}));
  }
  delete state.blockIdentities;
  alignment=alignChannels(blocks.h,blocks.v);
  timing=estimateCycle(blocks.h,blocks.v,state.settings,state.overrides);
  if(selected&&!blocks[selected.channel].some(b=>b.id===selected.id))selected=null;
}
function recalculate() { parseAll();render();save(); }
function time(s,precise=false) {
  if(!Number.isFinite(Number(s)))return '—';
  s=Math.max(0,Number(s));
  if(precise&&s<60)return `${s.toFixed(s<10?1:0)}s`;
  const rounded=Math.round(s);return `${Math.floor(rounded/60)}:${String(rounded%60).padStart(2,'0')}`;
}
function blockDuration(id) { const item=timing?.blockTimes?.[id];return typeof item==='number'?item:item?.duration; }
function highlight(text) {
  const tokens=/\([^)]*\)|;[^\n\r]*|\b(?:WHILE|END\d*|DO\d*|NE)\b|#\d+|\bG\d+(?:\.\d+)?|\bM\d+|\bN\d+/gi;
  let result='',last=0;
  for(const m of text.matchAll(tokens)){
    result+=escape(text.slice(last,m.index));
    const cls=/^[;(]/.test(m[0])?'comment':/^G/i.test(m[0])?'gcode':/^M/i.test(m[0])?'mcode':/^N\d/i.test(m[0])?'ncode':'macro';
    result+=`<span class="${cls}">${escape(m[0])}</span>`;last=m.index+m[0].length;
  }
  return result+escape(text.slice(last));
}
function displayText(block) { return block.text.replace(/(?:\r\n|\n|\r)$/,'').replace(/\r\n|\r/g,'\n'); }
function pinned(block){return ['Program header','Program end'].includes(block.title);}
function channelBounds(channel){const list=blocks[channel];let start=0;while(start<list.length&&list[start].title==='Program header')start++;let end=list.findIndex(b=>b.title==='Program end');if(end<0)end=list.length;return {start,end};}
function blockHtml(block,channel) {
  const text=displayText(block), lines=text.split('\n').length;
  const index=blocks[channel].indexOf(block);
  const names={'wait':'PAIRED WAIT','macro-wait':'MACRO WAIT','signal':'SIGNAL','toolpath':'TOOLPATH','code':'CODE'};
  const isSelected=selected?.id===block.id;
  const isPinned=pinned(block),limits=channelBounds(channel);
  return `<article class="block ${block.kind} channel-${channel}${isPinned?' program-marker':''}${isSelected?' selected':''}" data-id="${escape(block.id)}" data-channel="${channel}" tabindex="0" aria-label="${channel==='h'?'Horizontal':'Vertical'} block ${index+1}: ${escape(block.title)}">
    <div class="block-head">${isPinned?'<span class="pin-marker" title="Program boundary">◇</span>':`<button class="drag-handle" draggable="true" title="Drag to move within this channel" aria-label="Drag ${escape(block.title)}">⠿</button>`}<span class="block-title">${escape(block.title)}</span>${block.flags?.rotation?'<span class="block-flag">B</span>':''}${block.flags?.toolChange?'<span class="block-flag">TC</span>':''}<span class="block-kind">${isPinned?'PINNED':names[block.kind]||'CODE'}</span>${isPinned?'':`<div class="block-moves"><button data-move="up" aria-label="Move block up" title="Move up · Alt+↑" ${index<=limits.start?'disabled':''}>↑</button><button data-move="down" aria-label="Move block down" title="Move down · Alt+↓" ${index>=limits.end-1?'disabled':''}>↓</button></div>`}<span class="block-time" title="Estimated block duration${state.overrides[block.id]!==undefined?' · manual override':''}">${state.overrides[block.id]!==undefined?'~ ':''}${time(blockDuration(block.id),true)}</span></div>
    <div class="code-wrap"><pre class="line-numbers" aria-hidden="true">${Array.from({length:lines},(_,i)=>String(block.startLine+i).padStart(2,' ')).join('\n')}</pre><div class="code-input-wrap"><pre class="highlight" aria-hidden="true">${highlight(text)}\n</pre><textarea class="code-input" rows="${lines}" spellcheck="false" wrap="off" aria-label="${channel==='h'?'Horizontal':'Vertical'} code block ${index+1}" data-original="${escape(text)}">${escape(text)}</textarea></div></div>
  </article>`;
}
function render() {
  queuedEditRender=false;
  renderPending=true;
  $('#workspace-label').textContent=state.example?'Example workspace':'NC workspace';
  $('#demo-banner').hidden=!state.example;
  for(const c of ['h','v']) { $(`#${c}-filename`).textContent=state.filenames[c];$(`#${c}-channel-badge`).textContent=`CH ${state.settings[c+'Channel']}`; }
  $('#profile-status').textContent=`4-channel machine · editing linked pair ${state.settings.hChannel} + ${state.settings.vChannel}`;
  $('#match-count').textContent=`${alignment.matchedCount} aligned links`;
  $('#block-count').textContent=`${blocks.h.length+blocks.v.length} blocks`;
  $('#collapse-btn').textContent=state.compact?'Expand':'Compact';
  $('#aligned-board').classList.toggle('compact',state.compact);
  $('#aligned-board').innerHTML=alignment.rows.map(row=>{
    const link=alignment.links.find(l=>l.aligned!==false&&l.hId===row.h?.id&&l.vId===row.v?.id);
    return `<div class="align-row">${row.h?blockHtml(row.h,'h'):'<div class="block-gap" data-channel="h">alignment spacer</div>'}<div class="sync-gutter${link?' linked':''}${link?.kind==='macro'?' macro':''}" ${link?`title="${escape(link.label)}"`:''}>${link?`<span class="sync-marker">${link.kind==='macro'?(link.producer==='v'?'←':'→'):'⇄'}</span><span class="sync-label">${escape(link.label||link.key)}</span>`:''}</div>${row.v?blockHtml(row.v,'v'):'<div class="block-gap" data-channel="v">alignment spacer</div>'}</div>`;
  }).join('')+'<div class="end-row"><button class="end-drop" data-channel="h">Drop at end of operations</button><span></span><button class="end-drop" data-channel="v">Drop at end of operations</button></div>';
  $$('.block').forEach(el=>{const block=blocks[el.dataset.channel].find(b=>b.id===el.dataset.id);$('.code-input',el).value=displayText(block);});
  if(view==='source')renderSource();
  renderInsights();updateHistory();renderPending=false;
}
function renderInsights() {
  $('#cycle-time').textContent=`~ ${time(timing.duration)}`;
  const stalled=timing.diagnostics.some(d=>d.code==='synchronization-stalled'||d.code==='schedule-limit');
  $('#cycle-note').textContent=stalled?'Schedule stalled · totals stop at the blockage':timing.complete?'Estimated schedule · selected pair only':'Partial estimate · review unresolved timing';
  $('#timeline-scale').textContent=`0 — ${time(timing.duration)}`;
  const scale=Math.max(1,timing.duration);
  $('#timeline').innerHTML=$('#focus-timeline').innerHTML=['h','v'].map(c=>`<div class="timeline-lane"><span>${c.toUpperCase()}</span><div class="timeline-bar" aria-label="${c==='h'?'Horizontal':'Vertical'} estimated timeline">${(timing.segments[c]||[]).map(s=>`<span class="timeline-segment ${escape(s.type)}" style="left:${100*s.start/scale}%;width:${100*(s.end-s.start)/scale}%" title="${escape(s.label||s.type)} · ${time(s.end-s.start,true)} (${time(s.start)}–${time(s.end)})"></span>`).join('')}</div></div>`).join('');
  const coverage=timing.coverage;
  // Focus-mode readout: the channel that waits least sets the cycle, so show both waits side by side.
  const waits={h:timing.channels.h.wait||0,v:timing.channels.v.wait||0},bottleneck=waits.h<=waits.v?'h':'v';
  $('#focus-stats').innerHTML=`<span class="${timing.complete?'':'partial'}">Cycle <b>~${time(timing.duration)}${timing.complete?'':'*'}</b></span>${['h','v'].map(c=>`<span class="${c===bottleneck?'bottleneck':''}" title="${c===bottleneck?'Waits least · sets the cycle':''}">${c.toUpperCase()} wait <b>${time(waits[c])}</b></span>`).join('')}${coverage?`<span>Cutting <b>${Math.round(100*coverage.utilization)}%</b></span>`:''}`;
  $('#cut-coverage').innerHTML=coverage?`<div class="section-label">AT LEAST ONE CUTTING <strong>${Math.round(100*coverage.utilization)}%${timing.complete?'':'*'}</strong></div><div class="coverage-bar"><span style="width:${100*coverage.utilization}%"></span></div><div class="coverage-detail"><span>Neither channel cutting</span><strong>${time(coverage.nonCutting)}</strong></div>${timing.complete?'':`<p class="partial-note">* ${stalled?'Until the blockage; remaining operations excluded.':'Partial modeled time; unresolved operations excluded.'}</p>`}`:'';
  $('#utilization').innerHTML=['h','v'].map(c=>{
    const stats=timing.channels[c],util=Math.min(100,Math.max(0,(stats.utilization||0)*100));
    return `<div class="util-card ${c}"><div class="util-title" title="Estimated cutting utilization = feed-motion time / linked cycle time"><i class="legend-dot ${c==='h'?'mint':'violet'}"></i>${c==='h'?'Horizontal':'Vertical'}<strong>${Math.round(util)}<small style="font-size:10px">%</small></strong></div><div class="util-bar" title="Estimated feed-motion utilization"><div class="util-fill" style="width:${util}%"></div></div><div class="util-grid">${[['Cut time',stats.cut],['Air time',stats.air],['Tool change',stats.toolChange],['Waiting',stats.wait]].map(([name,s])=>`<div class="util-stat"><span>${name}</span><strong>${time(s)}</strong></div>`).join('')}</div></div>`;
  }).join('');
  const notes=[...['h','v'].flatMap(c=>(parsed[c].diagnostics||[]).map(d=>({...d,message:`${c==='h'?'H':'V'}: ${d.message}`}))),...(alignment.diagnostics||[]),...(timing.diagnostics||[])];
  const unique=[...new Map(notes.map(d=>[d.code+'|'+d.message,d])).values()];
  $('#diagnostic-count').textContent=unique.length;
  $('#diagnostics').innerHTML=unique.length?unique.map(d=>`<div class="diagnostic-item ${escape(d.level||d.severity||'info')}">${escape(d.message)}${d.blockIds?.length?` <a href="#" data-find-block="${escape(d.blockIds[0])}">Locate</a>`:''}</div>`).join(''):'<div class="diagnostic-item">No synchronization conflicts found in the recognized code.</div>';
  renderSelection();
}
function select(channel,id) {
  selected={channel,id};
  $$('.block.selected').forEach(el=>el.classList.remove('selected'));
  $$('.block').find(el=>el.dataset.id===id)?.classList.add('selected');
  renderSelection();
}
function renderSelection() {
  const block=selected&&blocks[selected.channel].find(b=>b.id===selected.id);
  if(!block){$('#selection-details').innerHTML='<div class="section-label">BLOCK DETAILS</div><div class="empty-selection">Select a block to inspect its time or set a duration.</div>';return;}
  const dt=blockDuration(block.id),manual=state.overrides[block.id];
  $('#selection-details').innerHTML=`<div class="section-label">BLOCK DETAILS <span>${selected.channel==='h'?'HORIZONTAL':'VERTICAL'}</span></div><h3 class="selection-title">${escape(block.title)}</h3><div class="selection-meta">Lines ${block.startLine}–${block.endLine} · ${escape(block.kind)}<br>Estimated ${time(dt,true)}${block.sync?`<br>${escape(block.sync.key)} · ${escape(block.sync.role)}`:''}</div>${block.sync?'<p class="field-hint">Sync time is calculated from when each channel reaches this point.</p>':pinned(block)?'<p class="field-hint">Program boundary is pinned. Edit its code in place or in Source view.</p>':`<label class="override-label" for="duration-override">Duration override <input id="duration-override" type="number" min="0" step="0.1" placeholder="auto" value="${manual??''}" aria-label="Block duration override in seconds"> sec</label><button id="apply-duration" class="button small duration-apply">Apply duration</button>${manual!==undefined?'<button id="reset-duration" class="override-reset">Use calculated time</button>':''}<p class="field-hint" style="font-size:9px;margin-bottom:0">Enter seconds, then Apply or press Enter.</p><button id="delete-block" class="delete-block">Remove selected block</button>`}`;
}
function move(channel,from,to) {
  if(!blocks[channel][from]||pinned(blocks[channel][from]))return;
  const limits=channelBounds(channel);to=Math.min(limits.end,Math.max(limits.start,to));
  if(from===to||from+1===to)return;
  remember();const updated=moveBlock(blocks[channel],from,to);
  state.sources[channel]=serializeProgram(updated);blocks[channel]=updated;
  recalculate();toast('Block moved · alignment updated');
}
function renderSource() {
  $('#source-board').innerHTML=['h','v'].map(c=>`<div class="source-channel"><div class="source-top"><span>${c==='h'?'Horizontal':'Vertical'} · full source${sourceDrafts[c]!==undefined?' · unapplied':''}</span><button class="button small" data-apply-source="${c}">Apply ${c.toUpperCase()} edits</button></div><textarea id="source-${c}" aria-label="${c==='h'?'Horizontal':'Vertical'} full source" spellcheck="false" wrap="off"></textarea></div>`).join('');
  for(const c of ['h','v'])$(`#source-${c}`).value=sourceDrafts[c]??state.sources[c];
}
function applySourceDrafts(){
  const channels=['h','v'].filter(c=>sourceDrafts[c]!==undefined&&sourceDrafts[c]!==state.sources[c].replace(/\r\n|\r/g,'\n'));
  if(!channels.length){sourceDrafts={};return;}
  remember();for(const c of channels)state.sources[c]=rawFromInput(sourceDrafts[c],state.sources[c],c);sourceDrafts={};recalculate();
}
function setView(next) {
  if(view==='source'&&next!=='source')applySourceDrafts();
  view=next;$('#aligned-board').hidden=view!=='aligned';$('#source-board').hidden=view!=='source';
  for(const name of ['aligned','source']) { $(`#${name}-tab`).classList.toggle('active',view===name);$(`#${name}-tab`).setAttribute('aria-selected',String(view===name)); }
  if(view==='source')renderSource();
  $('#editor-hint').textContent=view==='aligned'?'Drag a handle to move a block · click code to edit':'Apply source edits to regroup and realign';
}
function rawFromInput(value,original,channel) {
  const eol=(original.match(/\r\n|\r|\n/)||[parsed[channel].eol||'\n'])[0];
  return value.replace(/\r\n|\r|\n/g,eol);
}
function commitBlock(textarea) {
  const article=textarea.closest('.block');if(!article)return;
  const block=blocks[article.dataset.channel].find(b=>b.id===article.dataset.id);if(!block)return;
  if(textarea.value===textarea.dataset.original)return;
  remember();
  const trailing=(block.text.match(/(?:\r\n|\n|\r)$/)||[''])[0];
  block.text=rawFromInput(textarea.value,block.text,article.dataset.channel)+trailing;
  state.sources[article.dataset.channel]=serializeProgram(blocks[article.dataset.channel]);
  delete sourceDrafts[article.dataset.channel];parseAll();save();queuedEditRender=true;setTimeout(flushEditRender,0);
}

$('#aligned-board').addEventListener('focusin',event=>{const a=event.target.closest('.block');if(a)select(a.dataset.channel,a.dataset.id);});
$('#aligned-board').addEventListener('click',event=>{
  const a=event.target.closest('.block');if(!a)return;select(a.dataset.channel,a.dataset.id);
  if(event.target.dataset.move){const index=blocks[a.dataset.channel].findIndex(b=>b.id===a.dataset.id);move(a.dataset.channel,index,event.target.dataset.move==='up'?index-1:index+2);}
});
$('#aligned-board').addEventListener('input',event=>{
  if(!event.target.matches('.code-input'))return;
  const el=event.target;el.rows=el.value.split('\n').length;el.previousElementSibling.innerHTML=highlight(el.value)+'\n';
  const article=el.closest('.block'),block=blocks[article.dataset.channel].find(b=>b.id===article.dataset.id);
  $('.line-numbers',article).textContent=Array.from({length:el.rows},(_,i)=>String(block.startLine+i).padStart(2,' ')).join('\n');
  $('#save-status').textContent='Editing…';
});
$('#aligned-board').addEventListener('focusout',event=>{if(!renderPending&&event.target.matches('.code-input'))commitBlock(event.target);});
$('#aligned-board').addEventListener('scroll',event=>{
  if(event.target.matches('.code-input'))event.target.previousElementSibling.style.transform=`translate(${-event.target.scrollLeft}px,${-event.target.scrollTop}px)`;
},true);
$('#aligned-board').addEventListener('dragstart',event=>{
  if(!event.target.closest('.drag-handle')){event.preventDefault();return;}
  const article=event.target.closest('.block');drag={channel:article.dataset.channel,id:article.dataset.id};
  event.dataTransfer.setData('text/plain',JSON.stringify(drag));event.dataTransfer.effectAllowed='move';article.classList.add('dragging');
});
function clearDrop(){ $$('.drop-before,.drop-after,.end-drop.over').forEach(el=>el.classList.remove('drop-before','drop-after','over')); }
$('#aligned-board').addEventListener('dragover',event=>{
  if(!drag)return;const target=event.target.closest('.block,.end-drop');if(!target||target.dataset.channel!==drag.channel)return;
  event.preventDefault();event.dataTransfer.dropEffect='move';clearDrop();
  if(target.classList.contains('end-drop'))target.classList.add('over');
  else target.classList.add(event.clientY<target.getBoundingClientRect().top+target.clientHeight/2?'drop-before':'drop-after');
});
$('#aligned-board').addEventListener('drop',event=>{
  if(!drag)return;event.preventDefault();const target=event.target.closest('.block,.end-drop');
  if(target&&target.dataset.channel===drag.channel){const from=blocks[drag.channel].findIndex(b=>b.id===drag.id);const to=target.classList.contains('end-drop')?blocks[drag.channel].length:blocks[drag.channel].findIndex(b=>b.id===target.dataset.id)+(target.classList.contains('drop-after')?1:0);move(drag.channel,from,to);}
  else toast('Move blocks within their original channel',true);drag=null;clearDrop();
});
$('#aligned-board').addEventListener('dragend',()=>{drag=null;pointerHeld=false;clearDrop();$$('.dragging').forEach(el=>el.classList.remove('dragging'));flushEditRender();});
$('#source-board').addEventListener('input',event=>{if(event.target.id.startsWith('source-')){sourceDrafts[event.target.id.slice(-1)]=event.target.value;$('#save-status').textContent='Source edits unapplied';$('.source-top>span',event.target.closest('.source-channel')).textContent=`${event.target.id.endsWith('h')?'Horizontal':'Vertical'} · full source · unapplied`;}});
$('#source-board').addEventListener('click',event=>{
  const c=event.target.dataset.applySource;if(!c)return;
  const input=$(`#source-${c}`);const normalized=state.sources[c].replace(/\r\n|\r/g,'\n');
  if(input.value!==normalized){remember();state.sources[c]=rawFromInput(input.value,state.sources[c],c);delete sourceDrafts[c];recalculate();toast(`${c==='h'?'Horizontal':'Vertical'} source applied`);}
});
function applyDuration(){
  const input=$('#duration-override');if(!input||!selected)return;
  const value=input.value;if(!input.checkValidity()||(value!==''&&(!Number.isFinite(Number(value))||Number(value)<0))){input.reportValidity();return;}
  remember();if(value==='')delete state.overrides[selected.id];else state.overrides[selected.id]=Number(value);recalculate();toast('Block duration updated');
}
$('#selection-details').addEventListener('keydown',event=>{if(event.target.id==='duration-override'&&event.key==='Enter'){event.preventDefault();applyDuration();}});
$('#selection-details').addEventListener('click',event=>{
  if(event.target.id==='apply-duration')applyDuration();
  if(event.target.id==='reset-duration'&&selected){remember();delete state.overrides[selected.id];recalculate();}
  if(event.target.id==='delete-block'&&selected){remember();state.sources[selected.channel]=serializeProgram(blocks[selected.channel].filter(b=>b.id!==selected.id));selected=null;recalculate();toast('Block removed · undo available');}
});
$('#diagnostics').addEventListener('click',event=>{
  const id=event.target.dataset.findBlock;if(!id)return;event.preventDefault();setView('aligned');
  const el=$$('.block').find(el=>el.dataset.id===id);if(el){select(el.dataset.channel,id);el.scrollIntoView({behavior:'smooth',block:'center'});el.focus({preventScroll:true});}
});
$('#diagnostics-toggle').onclick=()=>{const hidden=!$('#diagnostics').hidden;$('#diagnostics').hidden=hidden;$('#diagnostics-toggle').setAttribute('aria-expanded',String(!hidden));};
$('#aligned-tab').onclick=()=>setView('aligned');$('#source-tab').onclick=()=>setView('source');
$('#undo-btn').onclick=undo;$('#redo-btn').onclick=redo;
$('#collapse-btn').onclick=()=>{state.compact=!state.compact;render();save();};
function setFocus(on){
  document.body.classList.toggle('focus-mode',on);
  $('#focus-btn').textContent=on?'⤡ Exit focus':'⛶ Focus';
  if(on&&!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});
  if(!on&&document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});
}
$('#focus-btn').onclick=()=>setFocus(!document.body.classList.contains('focus-mode'));
// Leaving browser full screen (Esc / F11) also leaves focus mode.
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement&&document.body.classList.contains('focus-mode'))setFocus(false);});
$('#dismiss-demo').onclick=()=>{$('#demo-banner').hidden=true;};
$('#demo-btn').onclick=()=>{remember();state.sources={...DEMO};state.filenames={h:'horizontal.nc',v:'vertical.nc'};state.overrides={};state.example=true;blocks={h:[],v:[]};selected=null;sourceDrafts={};recalculate();toast('Example programs loaded');};
document.addEventListener('keydown',event=>{
  const inText=/^(TEXTAREA|INPUT)$/.test(event.target.tagName);
  if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='f'){event.preventDefault();setFocus(!document.body.classList.contains('focus-mode'));}
  if(event.key==='Escape'&&!inText&&!document.querySelector('dialog[open]')&&document.body.classList.contains('focus-mode'))setFocus(false);
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!inText){event.preventDefault();event.shiftKey?redo():undo();}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();document.activeElement.blur();applySourceDrafts();save();toast('Workspace saved in this browser');}
  if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&selected){event.preventDefault();if(event.target.matches('.code-input'))commitBlock(event.target);if(!selected)return;const index=blocks[selected.channel].findIndex(b=>b.id===selected.id);const to=event.key==='ArrowUp'?index-1:index+2;if(to>=0&&to<=blocks[selected.channel].length)move(selected.channel,index,to);}
});

$$('.close-dialog').forEach(button=>button.onclick=()=>button.closest('dialog').close());
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
function openSettings(){const form=$('#settings-form');for(const [key,value]of Object.entries(state.settings)){const field=form.elements.namedItem(key);if(field){if(field.type==='checkbox')field.checked=value;else field.value=value;}}$('#settings-error').textContent='';$('#settings-dialog').showModal();}
$('#settings-btn').onclick=openSettings;$('#rates-btn').onclick=openSettings;$('#help-btn').onclick=()=>$('#help-dialog').showModal();
$('#settings-form').onsubmit=event=>{
  event.preventDefault();const form=event.target;const values=Object.fromEntries(new FormData(form));
  const valid=validateWaitPattern(values.waitPattern);if(!valid.valid){$('#settings-error').textContent=valid.error;return;}
  if(values.hChannel===values.vChannel){$('#settings-error').textContent='Select two different channels.';return;}
  if(!values.waitTemplate.includes('{id}')){$('#settings-error').textContent='The wait template must include {id}.';return;}
  const initialMacros={};const pieces=values.initialMacrosText.split(/[,;\n]/).map(s=>s.trim()).filter(Boolean);
  for(const piece of pieces){const m=/^#?(\d+)\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(piece);if(!m){$('#settings-error').textContent=`Invalid initial macro: ${piece}`;return;}initialMacros[m[1]]=Number(m[2]);}
  remember();state.settings={...values,initialMacros,useProgramFeed:form.elements.useProgramFeed.checked};
  for(const key of ['cutFeed','rapidFeed','rotationFeed','toolChangeSeconds'])state.settings[key]=Number(values[key]);
  $('#settings-dialog').close();recalculate();toast('Machine profile and time estimates updated');
};

let importedFiles={};
$('#import-btn').onclick=()=>{for(const c of ['h','v']){$(`#import-${c}`).value='';$(`#file-${c}`).value='';}importedFiles={};$('#import-error').textContent='';$('#import-dialog').showModal();};
for(const c of ['h','v'])$(`#file-${c}`).onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  try{const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());$(`#import-${c}`).value=source;importedFiles[c]={source,normalized:source.replace(/\r\n|\r/g,'\n'),filename:file.name};}
  catch{$('#import-error').textContent='Use ASCII or UTF-8 NC text. This file could not be decoded.';}
};
$('#import-form').onsubmit=event=>{
  event.preventDefault();if(!$('#import-h').value.trim()&&!$('#import-v').value.trim()){$('#import-error').textContent='Choose or paste at least one channel program.';return;}
  remember();for(const c of ['h','v']){const text=$(`#import-${c}`).value;state.sources[c]=importedFiles[c]?.normalized===text?importedFiles[c].source:text;state.filenames[c]=importedFiles[c]?.filename||`${c==='h'?'horizontal':'vertical'}.nc`;}
  state.overrides={};state.example=false;sourceDrafts={};selected=null;blocks={h:[],v:[]};$('#import-dialog').close();recalculate();toast('Programs imported');
};

function syncText() {
  const data=Object.fromEntries(new FormData($('#sync-form')));
  if(data.type==='barrier'){const code=state.settings.waitTemplate.replaceAll('{id}',data.value).replaceAll('{p}',data.participants);return {h:code,v:code};}
  const signal=`#${data.variable}=${data.value}`,wait=`WHILE[#${data.variable}NE${data.value}]DO1\nEND1`;
  return data.producer==='h'?{h:signal,v:wait}:{h:wait,v:signal};
}
function updateSyncPreview(){const macro=$('#sync-type').value==='macro';$('#p-field').hidden=macro;$('#variable-field').hidden=!macro;$('#producer-field').hidden=!macro;const texts=syncText();$('#sync-preview').textContent=`HORIZONTAL\n${texts.h}\n\nVERTICAL\n${texts.v}`;}
$('#sync-form').addEventListener('input',updateSyncPreview);
$('#add-sync-btn').onclick=()=>{
  $('#sync-error').textContent='';$('#sync-form').elements.participants.value=state.settings.hChannel+state.settings.vChannel;
  const block=selected&&blocks[selected.channel].find(b=>b.id===selected.id);$('#insert-location').textContent=block&&!pinned(block)?`After “${block.title}” in the selected channel; before program end in the other. Drag either inserted block to adjust.`:'Insert before each program end. Drag the new blocks to their desired positions.';
  updateSyncPreview();$('#sync-dialog').showModal();
};
$('#sync-form').onsubmit=event=>{
  event.preventDefault();const texts=syncText(),kind=$('#sync-type').value;
  if(kind==='barrier'){const test=parseProgram(texts.h+'\n',state.settings,'test');if(!test.blocks.some(b=>b.kind==='wait')){$('#sync-error').textContent='This template does not match your wait pattern. Update Settings first.';return;}}
  remember();for(const c of ['h','v']){
    const list=blocks[c],limits=channelBounds(c);let index=selected?.channel===c?list.findIndex(b=>b.id===selected.id)+1:limits.end;index=Math.min(limits.end,Math.max(limits.start,index));
    const eol=parsed[c].eol||'\n';const text=texts[c].replace(/\n/g,eol)+eol;
    const before=serializeProgram(list.slice(0,index));state.sources[c]=before+(before&&!/[\r\n]$/.test(before)?eol:'')+text+serializeProgram(list.slice(index));
  }
  $('#sync-dialog').close();recalculate();toast(kind==='barrier'?'Paired wait inserted':'Shared macro signal and wait inserted');
};

function download(content,name,type='text/plain;charset=utf-8') {const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.hidden=true;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('#export-btn').onclick=()=>{applySourceDrafts();const count=[...(alignment.diagnostics||[]),...(timing.diagnostics||[])].filter(d=>(d.level||d.severity)==='error').length;$('#export-review').textContent=`${count?`${count} unresolved issue(s). `:''}Review programs in your machine simulator before use. Workspace JSON preserves programs, configuration and time overrides.`;$('#export-dialog').showModal();};
for(const c of ['h','v'])$(`#export-${c}`).onclick=()=>{download(state.sources[c],state.filenames[c].replace(/\.[^.]+$/,'')+'.nc');toast(`${c==='h'?'Horizontal':'Vertical'} program downloaded`);};
$('#export-project').onclick=()=>{download(JSON.stringify(project(),null,2),'spindle-sync-workspace.json','application/json');toast('Workspace backup downloaded');};
$('#restore-project').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{const restored=validateProject(JSON.parse(await file.text()));remember();restore(restored);sourceDrafts={};$('#export-dialog').close();toast('Workspace restored');}catch(error){toast(error.message||'Could not restore workspace',true);}event.target.value='';};
window.addEventListener('beforeunload',()=>{const input=document.activeElement;if(input?.matches('.code-input'))commitBlock(input);applySourceDrafts();});
parseAll();render();save();
