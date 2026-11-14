'use strict';

const $ = id => document.getElementById(id);
// 静态托管（如 GitHub Pages）时，可用 window.PIANYU_API_BASE 指向单独部署的后端。
// 默认空字符串，本机 uvicorn 与 /ui 同源时行为不变。
const API_BASE = String(globalThis.PIANYU_API_BASE || '').replace(/\/+$/, '');
const api = path => (typeof path === 'string' && path.startsWith('/api/') ? API_BASE + path : path);
const LOOKS = {editorial:'杂志剪辑',documentary:'纪实电影',diagram:'图解动画'};
const defaults = {background:'#142924',text:'#EEFAED',accent:'#A4E68D',music:'ambient',music_volume:.14,
  pace:'normal',tone:'自然、清楚，多用生活例子',audience:'普通观众',look:'editorial',visual_notes:''};
let draft = {...defaults}, history = [], savedName = '', project, selected = 0, prompts, config = {};
let chatBusy = false;
let messages = [];
let styleHistory=[];
let revision = 0, sceneVersion = 0, frameVersion = 0, frameURL, syncTimer, noticeTimer, activeRender = false;
const candidates = new Map();
const pendingShots = new Set();
const shotJobs = new WeakMap();
const attemptedShots = new WeakSet();
const thumbnails = new Map();
const statuses = {approved:'已确认', pending:'待审核', failed:'待重试', running:'生成中', missing:'待生成', diagram:'程序图解'};
const sampleMedia = api('/api/examples/media/');
const approaches = [
  ['因果解释','先并列观察，再呈现原因和反例。','先展示金属与木头的对比，再解释热量传递，最后用冷热反例收束。'],
  ['步骤教学','沿着一条路径，逐步交代发生了什么。','以流程图串联发出、转发与接收，每镜只讲一步。'],
  ['概念拆解','先用一个具体例子，再看两个概念的差异。','先给具体数值，再用并排图解比较平均数和中位数。'],
  ['历史线索','用时间和条件串起变化。','用时间线串联手抄与印刷，用对比图解释成本和传播条件。']
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, data) {
  const options = data instanceof FormData ? {method:'POST',body:data} :
    data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
  const response = await fetch(api(path), options);
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch {}
    throw new Error(typeof detail === 'string' ? detail : '请检查输入后重试。');
  }
  return response;
}
async function json(path, data) {return (await request(path,data)).json();}
function notice(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => {$('notice').hidden = true;},5200);
}
function action(id, fn) {
  const button = $(id);
  button.addEventListener('click',async () => {
    button.disabled = true;
    try {await fn();} catch(err) {notice(err.message);}
    finally {
      if(id==='generate-shot'||id==='retry-shot')button.disabled=!config.video_connected||pendingShots.has(current());
      else button.disabled = false;
    }
  });
}
function bubble(role, text) {
  messages.push({role,text});
  const el = document.createElement('div');
  el.className = 'bubble' + (role==='user' ? ' user' : '');
  el.textContent = text;
  $('chat-thread').append(el);
  const pane = $('chat-thread').parentElement;
  pane.scrollTop = pane.scrollHeight;
  $('chat-intro').hidden=true;
}
function tab() {
  const labels = {chat:'首页',video:'项目',setup:'控制台'};
  const hash = location.hash.slice(1);
  const page = Object.hasOwn(labels,hash) ? hash : 'chat';
  const pageChanged=document.body.dataset.page !== page;
  if (pageChanged) window.scrollTo(0, 0);
  document.body.dataset.page = page;
  for (const key of Object.keys(labels)) {
    $(key+'-page').hidden = key!==page;
    $('nav-'+key).classList.toggle('selected',key===page);
    $('nav-'+key).setAttribute('aria-current',key===page?'page':'false');
  }
  $('breadcrumb').textContent = labels[page];
  if(pageChanged && page==='video' && $('editor').hidden && $('workspace').dataset.view==='chat'){
    $('chat-message').focus({preventScroll:true});
  }
}
function topSkill() {
  $('top-skill').hidden = !savedName;
  $('top-skill').textContent = savedName ? '风格 · '+savedName : '';
}

function enterEditor() {
  $('project-hub').hidden=true;
  $('editor').hidden=false;
  $('resume-project').hidden=false;
  $('apply-project-style').hidden=false;
  $('project-pane').scrollTop=0;
  updateChatContext();
  workspaceView('project');
}

function workspaceView(view) {
  $('workspace').dataset.view=view;
  document.querySelectorAll('[data-workspace-view]').forEach(button=>
    button.setAttribute('aria-pressed',String(button.dataset.workspaceView===view)));
}
document.querySelectorAll('[data-workspace-view]').forEach(button=>
  button.addEventListener('click',()=>workspaceView(button.dataset.workspaceView)));

function updateChatContext() {
  const scene=project && !$('editor').hidden ? project.scenes[selected] : null;
  $('chat-context').textContent=scene ? project.topic : '新项目';
  $('chat-target').textContent=scene ? '修改第 '+(selected+1)+' 镜 · '+scene.title : '生成第一版分镜';
  $('chat-message').placeholder=scene ? '例如：把这幕旁白改得更短' : '例如：给初中生讲棱镜怎么把白光分成彩色';
}

function resetConversation() {
  history=[];
  messages=[];
  $('chat-thread').replaceChildren();
  $('chat-intro').hidden=false;
  $('chat-message').value='';
}

function cutMode(mode) {
  $('editor').dataset.mode=mode;
  document.querySelectorAll('[data-cut-mode]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.cutMode===mode)));
  $('next-review').hidden=mode!=='review';
  if(mode!=='export')$('full-player').pause();
  if(mode==='export')$('player').pause();
  if(mode==='export'){
    $('compare-player').pause();
    $('editor').classList.remove('comparing');
    $('compare-version').textContent='对比已确认版';
  }
}

document.querySelectorAll('[data-cut-mode]').forEach(button=>button.addEventListener('click',()=>cutMode(button.dataset.cutMode)));
function openProjects() {
  $('editor').hidden=true;
  $('project-hub').hidden=false;
  $('player').pause();
  $('full-player').pause();
  activateTab('brief-topic-tab');
  updateChatContext();
}
$('back-projects').addEventListener('click',openProjects);
$('resume-project').addEventListener('click',enterEditor);

function activateTab(id, focus=false) {
  const selected = $(id);
  for (const button of selected.parentElement.querySelectorAll('[role=tab]')) {
    const active = button===selected;
    button.setAttribute('aria-selected',String(active));
    button.tabIndex = active ? 0 : -1;
    $(button.getAttribute('aria-controls')).hidden = !active;
  }
  if(focus)selected.focus();
}

for (const group of document.querySelectorAll('[data-tabs]')) {
  const buttons = [...group.querySelectorAll('[role=tab]')];
  buttons.forEach((button,index)=>{
    button.addEventListener('click',()=>activateTab(button.id));
    button.addEventListener('keydown',event=>{
      const target = {ArrowLeft:(index+buttons.length-1)%buttons.length,ArrowRight:(index+1)%buttons.length,
        Home:0,End:buttons.length-1}[event.key];
      if(target===undefined)return;
      event.preventDefault();activateTab(buttons[target].id,true);
    });
  });
}

const recentKey = 'pianyu.recent-projects.v1';
let recentId = '';
let recentProjects = [];
try {
  const saved = JSON.parse(localStorage.getItem(recentKey) || '[]');
  if(Array.isArray(saved)) recentProjects = saved.filter(item=>item?.id && typeof item.project?.topic==='string').slice(0,6);
} catch {}

function showRecentProjects(animateItems=false) {
  const list = $('recent-projects');
  list.replaceChildren();
  $('recent-empty').hidden = recentProjects.length > 0;
  for (const entry of recentProjects) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    const title = document.createElement('strong');
    const meta = document.createElement('span');
    title.textContent = entry.project.topic;
    const date = new Date(entry.updatedAt);
    meta.textContent = (entry.project.scenes?.length || 0)+' 幕'+(Number.isNaN(date.getTime())?'':' · '+date.toLocaleDateString('zh-CN'));
    button.type = 'button';
    button.append(title,meta);
    button.addEventListener('click',async ()=>{
      if(chatBusy)return;
      try {
        const value = await json('/api/project',entry.project);
        value.source ||= typeof entry.source==='string' ? entry.source : '';
        setProject(value,entry.id);
        resetConversation();
        for(const item of (entry.messages || []))bubble(item.role,item.text);
        enterEditor();
      } catch(err){notice(err.message);}
    });
    li.append(button);list.append(li);
  }
  if(animateItems && list.childElementCount)list.dispatchEvent(new Event('pianyu:reveal',{bubbles:true}));
}

function rememberProject() {
  recentId ||= crypto.randomUUID();
  const entry = {id:recentId,project:structuredClone(project),source:project.source || '',
    messages:messages.slice(-30),updatedAt:Date.now()};
  const previous = recentProjects.findIndex(item=>item.id===recentId);
  recentProjects = [entry,...recentProjects.filter(item=>item.id!==recentId)].slice(0,6);
  try {localStorage.setItem(recentKey,JSON.stringify(recentProjects));}
  catch {notice('浏览器无法保存最近工程，可使用导出的工程文件。');}
  showRecentProjects(previous!==0);
}
function setDraft(style, name='') {
  const oldMusic = draft.music;
  draft = {...defaults,...style};
  savedName = name;
  topSkill();
  $('draft-state').textContent = name ? '已保存' : '待确认';
  $('download-style').hidden = !name;
  if (name) $('download-style').href = api('/api/profiles/'+encodeURIComponent(name)+'/download');
  for (const key of ['background','text','accent','music','pace','look','visual_notes','tone','audience']) $(key).value=draft[key];
  $('volume').value = draft.music_volume;
  $('volume-value').textContent = Math.round(draft.music_volume*100)+'%';
  const tile = $('style-preview');
  tile.style.background = draft.background;
  tile.style.color = draft.text;
  tile.firstElementChild.style.color = draft.accent;
  $('sample-look').textContent = LOOKS[draft.look];
  const audio = $('music-player');
  audio.hidden = draft.music==='none';
  if (audio.hidden) {audio.pause();audio.removeAttribute('src');}
  else if (!audio.getAttribute('src') || oldMusic!==draft.music) audio.src=api('/api/music/'+draft.music);
  audio.volume = Math.min(1,.22+2*draft.music_volume);
}
async function refreshProfiles(active='') {
  const list = await json('/api/profiles');
  $('video-profile').replaceChildren(new Option('默认风格',''), ...list.map(n=>new Option(n,n)));
  $('edit-profile').replaceChildren(new Option('选择风格',''), ...list.map(n=>new Option(n,n)));
  $('load-profile-label').hidden=!list.length;
  $('video-profile').value = list.includes(active) ? active : '';
  $('selected-style').textContent = active && list.includes(active) ? '将使用 '+active : '';
}
async function saveDraft() {
  const name = $('profile-name').value.trim();
  if (!name) throw new Error('请先给个人风格起一个英文名称。');
  const saved = await json('/api/profiles',{name,style:draft});
  setDraft(saved.style,saved.name);
  await refreshProfiles(saved.name);
  notice('个人风格已保存。');
  return saved.name;
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click',()=>{location.hash=b.dataset.tab;});
addEventListener('hashchange',tab);
$('open-style').addEventListener('click',()=>$('style-dialog').showModal());
$('style-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const input=$('style-message');
  const message=input.value.trim();
  if(!message)return;
  const button=event.submitter;
  button.disabled=true;
  $('style-reply').textContent='正在调整风格…';
  try{
    const result=await json('/api/interview',{message,style:draft,history:styleHistory.slice(-8)});
    const patch=Object.fromEntries(result.changed.map(key=>[key,result.style[key]]));
    setDraft({...draft,...patch},result.changed.length?'':savedName);
    styleHistory.push({role:'user',content:message},{role:'assistant',content:result.reply});
    $('style-reply').textContent=result.reply;
    input.value='';
  }catch(err){$('style-reply').textContent=err.message;}
  finally{button.disabled=false;}
});
$('new-conversation').addEventListener('click',()=>{
  if(chatBusy)return;
  if(project){
    rememberProject();
    project=undefined;
    recentId='';
    $('resume-project').hidden=true;
    $('apply-project-style').hidden=true;
  }
  $('topic').value='';
  $('source').value='';
  $('direction').value='';
  openProjects();
  resetConversation();
  workspaceView('chat');
  $('chat-message').focus();
});
for (const key of ['background','text','accent','music','pace','look','visual_notes','tone','audience','volume']) {
  const field = key==='volume' ? 'music_volume' : key;
  $(key).addEventListener(['tone','audience','visual_notes'].includes(key)?'change':'input',event=>{
    const value=key==='volume'?Number(event.target.value):event.target.value;
    if (value==='' && key!=='visual_notes') {event.target.value=draft[field];return;}
    setDraft({...draft,[field]:value});
  });
}
$('chat-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=$('chat-form').querySelector('.arrow'), input=$('chat-message'), message=input.value.trim();
  if (!message || chatBusy) return;
  const owner=$('editor').hidden ? undefined : project;
  const shot=owner && current();
  const prior=history.slice(-5);
  chatBusy=button.disabled=$('new-conversation').disabled=true;
  input.value='';
  bubble('user',shot ? '第 '+(selected+1)+' 镜 · '+message : message);
  const pending=document.createElement('p');
  pending.className='chat-wait';
  pending.setAttribute('role','status');
  pending.textContent=shot ? '正在修改这幕…' : '正在整理创作需求…';
  $('chat-thread').append(pending);
  const pane=$('chat-thread').parentElement;
  pane.scrollTop=pane.scrollHeight;
  try {
    if(shot){
      const number=owner.scenes.indexOf(shot)+1;
      await reviseShot(owner,shot,message);
      pending.remove();
      bubble('assistant','已更新第 '+number+' 镜。可以在左侧查看修改后的镜头。');
      rememberProject();
    }else{
      const result=await json('/api/project/first-draft',{message,history:prior,topic:$('topic').value,
        source:$('source').value,direction:$('direction').value,style_skill:$('video-profile').value,style:draft});
      pending.remove();
      if(result.project){
        setProject(result.project);
        enterEditor();
        bubble('assistant','第一版分镜已完成，共 '+result.project.scenes.length+' 幕。点左侧任意一幕，再告诉我想改什么。');
        rememberProject();
      }else{
        bubble('assistant',result.reply);
        history.push(message);
      }
    }
  } catch(err) {
    pending.remove();
    bubble('assistant',err.message);
    input.value ||= message;
  }finally{
    chatBusy=button.disabled=$('new-conversation').disabled=false;
    if(document.body.dataset.page==='video' && document.activeElement===document.body)input.focus({preventScroll:true});
  }
});
$('chat-message').addEventListener('keydown',event=>{
  if(event.key==='Enter' && !event.shiftKey && !event.isComposing){
    event.preventDefault();$('chat-form').requestSubmit($('chat-form').querySelector('.arrow'));
  }
});
action('save-style',saveDraft);
$('edit-profile').addEventListener('change',async event=>{
  const select=event.target, name=select.value;
  if(!name)return;
  select.disabled=true;
  try{
    const result=await json('/api/profiles/'+encodeURIComponent(name));
    styleHistory=[];
    $('style-reply').textContent='';
    setDraft(result.style,result.name);
    $('profile-name').value=result.name;
    notice('已加载个人风格。');
  }catch(err){notice(err.message);}
  finally{select.value='';select.disabled=false;}
});
action('to-video',async()=>{
  const name=savedName||await saveDraft();
  $('video-profile').value=name;
  $('video-profile').dispatchEvent(new Event('change'));
  $('style-dialog').close();
  if(project && !$('editor').hidden){
    const owner=project;
    const result=await json('/api/project/style',{project:owner,name});
    if(project!==owner)return;
    owner.style_skill=result.style_skill;
    owner.style=result.style;
    tabs();changed();
    notice('已将这套风格应用到当前项目。');
  }else{
    $('chat-message').focus();
  }
});
$('video-profile').addEventListener('change',async event=>{
  const name=event.target.value;
  $('selected-style').textContent=name?'将使用 '+name:'';
});
action('apply-project-style',async()=>{
  const name=$('video-profile').value;
  const owner=project;
  if(!owner)return;
  const result=await json('/api/project/style',{project:owner,name});
  if(project!==owner || $('video-profile').value!==name) return;
  owner.style_skill=result.style_skill;owner.style=result.style;
  tabs();changed();enterEditor();
  notice('已更新当前项目的风格。');
});

const current = () => project?.scenes[selected];
const currentShot = () => prompts?.shots.find(shot=>shot.id===current()?.id);
function shotState(scene, shot) {
  if(pendingShots.has(scene) && !['done','failed'].includes(shotJobs.get(scene)?.status))return 'running';
  const candidate=candidates.get(scene.id);
  if(shot && candidate?.signature===shot.signature && candidate.asset.asset_id!==scene.clip_id)return 'pending';
  if(shot?.approved)return 'approved';
  if(shotJobs.get(scene)?.status==='failed')return 'failed';
  if(scene.visual_method==='diagram' || (scene.visual_method==='auto' && !scene.clip_id))return 'diagram';
  return 'missing';
}

function timelineState() {
  if(!project)return;
  const list=project.scenes.map(scene=>shotState(scene,prompts?.shots.find(shot=>shot.id===scene.id)));
  $('scenes').querySelectorAll('[data-scene-status]').forEach((label,index)=>{
    label.dataset.sceneStatus=list[index];
    label.textContent=statuses[list[index]];
    const scene=project.scenes[index];
    const asset=list[index]==='approved'?scene.clip_id:list[index]==='pending'?candidates.get(scene.id)?.asset.asset_id:null;
    const image=label.parentElement.querySelector('img');
    if(asset && image.dataset.asset!==asset){
      image.dataset.asset=asset;
      image.onerror=()=>{image.onerror=null;thumbnail(scene,image,true);};
      image.src=api('/api/assets/clip/'+asset+'/poster');
    }else if(!asset && image.dataset.asset){
      delete image.dataset.asset;
      thumbnail(scene,image);
    }
  });
  const total=project.scenes.reduce((sum,scene)=>sum+scene.seconds,0);
  const engine=$('engine').value;
  const ready=prompts?.shots.filter((shot,i)=>shot.approved && (engine!=='hybrid' || project.scenes[i].visual_method!=='diagram')).length ?? 0;
  const pending=list.filter(state=>state==='pending').length;
  $('timeline-summary').textContent=project.scenes.length+' 镜 · 计划 '+total+' 秒';
  $('monitor-meta').textContent='第 '+(selected+1)+' 镜 · '+current().title+' · '+statuses[list[selected]];
  const summary=engine==='code'?'全片使用程序图解':ready+' / '+list.length+' 镜已确认视频素材'+
    (engine==='model'?' · 全视频模式需要逐镜确认':' · 其余镜头使用图解');
  $('delivery-summary').textContent=summary+(pending?' · '+pending+' 镜待审核':'');
  $('next-review').disabled=!list.includes('pending');
}

function releaseThumbnails() {
  for(const entry of thumbnails.values())if(entry.url)URL.revokeObjectURL(entry.url);
  thumbnails.clear();
}

function thumbnail(scene,img,fallback=false) {
  if(scene.reference_id){img.src=api('/api/assets/image/'+scene.reference_id);return;}
  const key=JSON.stringify([scene.kind,scene.title,scene.narration,scene.points,project.style]);
  let entry=thumbnails.get(scene.id);
  if(entry?.key!==key){
    if(entry?.url)URL.revokeObjectURL(entry.url);
    entry={key};
    thumbnails.set(scene.id,entry);
    entry.ready=request('/api/frame',{scene,style:project.style}).then(response=>response.blob()).then(blob=>{
      if(thumbnails.get(scene.id)===entry)entry.url=URL.createObjectURL(blob);
    }).catch(()=>{if(thumbnails.get(scene.id)===entry)thumbnails.delete(scene.id);});
  }
  if(entry.url)img.src=entry.url;
  else entry.ready.then(()=>{if(img.isConnected && entry.url && (fallback || !img.dataset.asset))img.src=entry.url;});
}

function setProject(value, id='') {
  recentId=id;
  project=value;selected=0;history=[];candidates.clear();releaseThumbnails();
  for (const scene of project.scenes) {
    const pending=scene.clip_versions?.find(version=>version.pending);
    if(pending)candidates.set(scene.id,{asset:{asset_id:pending.asset_id,url:api('/api/assets/clip/'+pending.asset_id),warnings:[]},signature:pending.signature});
  }
  $('topic').value=project.topic;
  $('direction').value=project.direction;
  $('source').value=project.source;
  if([...$('video-profile').options].some(o=>o.value===project.style_skill)) $('video-profile').value=project.style_skill;
  $('selected-style').textContent=project.style_skill?'本片风格 · '+project.style_skill:'';
  $('editor').hidden=false;
  cutMode('edit');
  activateTab('shot-story-tab');
  $('prompt-drawer').open=false;
  if(!activeRender)$('progress-box').hidden=true;
  select(0,true);
}
function tabs() {
  $('scenes').replaceChildren();
  $('script-lines').replaceChildren();
  project.scenes.forEach((scene,index)=>{
    const button=document.createElement('button');
    button.className='secondary';
    button.setAttribute('role','tab');
    button.setAttribute('aria-selected',String(index===selected));
    button.tabIndex=index===selected ? 0 : -1;
    const number = document.createElement('span');
    number.className='scene-number';
    number.textContent=String(index+1).padStart(2,'0');
    number.setAttribute('aria-hidden','true');
    const title = document.createElement('span');
    title.textContent=scene.title || '未命名镜头';
    const img=document.createElement('img');
    img.alt='';
    img.className='scene-thumb';
    const row=document.createElement('span');
    row.className='scene-caption';row.append(number,title);
    const status=document.createElement('span');
    status.dataset.sceneStatus='';
    button.append(img,row,status);
    button.title=scene.title;
    button.addEventListener('click',()=>select(index));
    button.draggable=true;
    button.addEventListener('dragstart',event=>event.dataTransfer.setData('text/x-pianyu-scene',scene.id));
    button.addEventListener('dragover',event=>{
      if(event.dataTransfer.types.includes('text/x-pianyu-scene'))event.preventDefault();
    });
    button.addEventListener('drop',event=>{
      const from=project.scenes.findIndex(item=>item.id===event.dataTransfer.getData('text/x-pianyu-scene'));
      if(from<0 || from===index)return;
      event.preventDefault();
      const [moved]=project.scenes.splice(from,1);
      project.scenes.splice(index,0,moved);
      select(index,true);
    });
    button.addEventListener('keydown',event=>{
      const length=project.scenes.length;
      const next={ArrowLeft:(index+length-1)%length,ArrowRight:(index+1)%length,Home:0,End:length-1}[event.key];
      if(next===undefined)return;
      event.preventDefault();
      select(next);
      $('scenes').children[next].focus();
    });
    $('scenes').append(button);
    thumbnail(scene,img);
    const line=document.createElement('button');
    line.type='button';line.className='script-line';
    line.setAttribute('aria-current',index===selected?'true':'false');
    const heading=document.createElement('strong');heading.textContent=String(index+1).padStart(2,'0')+'  '+scene.title;
    const text=document.createElement('span');text.textContent=scene.narration;
    line.append(heading,text);
    line.addEventListener('click',()=>{
      select(index);
      $('script-lines').children[index].focus({preventScroll:true});
    });
    $('script-lines').append(line);
  });
  $('editor-title').textContent=project.topic;
  $('editor-meta').textContent=project.style_skill?'风格 · '+project.style_skill:'分镜工作台';
  timelineState();
}
function select(index, edited=false) {
  selected=index;sceneVersion+=1;tabs();
  const scene=current();
  updateChatContext();
  const job = shotJobs.get(scene);
  if(job)showProgress('shot-progress',job);
  else $('shot-progress').hidden=true;
  for(const [id,key] of Object.entries(sceneInputs)) {
    $(id).value=key==='points'?scene.points.join('\n'):scene[key];
  }
  $('sources').textContent=scene.sources.length?'资料依据 · '+scene.sources.join(' / '):'';
  $('add-scene').disabled=project.scenes.length>=7;
  $('remove').disabled=project.scenes.length===1;
  $('move-left').disabled=index===0;
  $('move-right').disabled=index===project.scenes.length-1;
  $('remove-reference').hidden=!scene.reference_id;
  if(edited) changed(); else {applyPrompts();showCurrent();}
}
function invalidateCandidate(){
  $('editor').classList.remove('comparing');
  $('compare-player').pause();
  $('compare-version').textContent='对比已确认版';
  $('candidate-review').hidden=true;
  $('show-frame').hidden=true;
  $('player').pause();
  $('player').hidden=true;
  $('frame').hidden=false;
}
function changed() {
  revision+=1;
  prompts=null;
  $('outputs').replaceChildren();
  $('single-outputs').replaceChildren();
  const fullPlayer=$('full-player');
  if(!fullPlayer.hidden) {
    fullPlayer.hidden=true;
    fullPlayer.removeAttribute('src');
    fullPlayer.load();
  }
  applyPrompts();
  showCurrent();
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>syncPrompts().catch(err=>notice(err.message)),180);
}
async function syncPrompts() {
  clearTimeout(syncTimer);
  const version=revision, owner=project;
  const data=await json('/api/prompts',owner);
  if(revision===version && project===owner){
    const initial=!prompts;
    prompts=data;applyPrompts();
    if(initial && (currentShot()?.approved || candidates.has(current()?.id)))showCurrent();
  }
  return data;
}
function applyPrompts() {
  const scene=current(), shot=currentShot();
  if(!scene)return;
  $('master-prompt').textContent=prompts?.complete||'';
  $('code-rules').textContent=prompts?.code_rules.join('\n')||'';
  if(document.activeElement!==$('shot-prompt')) $('shot-prompt').value=scene.prompt_override||shot?.prompt||'';
  $('prompt-checks').textContent=shot?.checks.join(' ')||'';
  $('retry-shot').hidden=!config.video_connected||!attemptedShots.has(scene);
  $('retry-shot').disabled=pendingShots.has(scene);
  $('generate-shot').disabled=!config.video_connected||pendingShots.has(scene);
  $('remove-reference').hidden=!scene.reference_id;
  const candidate=candidates.get(scene.id);
  if (candidate && candidate.signature===shot?.signature && candidate.asset.asset_id!==scene.clip_id) {
    $('shot-status').textContent='请预览并确认本镜素材。';
  } else if (shot?.approved) $('shot-status').textContent='本镜素材已确认。';
  else if (scene.clip_id && shot) $('shot-status').textContent='本镜画面要求已修改，请重新确认素材。';
  else if (!pendingShots.has(scene)) $('shot-status').textContent='';
  timelineState();
  refreshVersions();
}
function showCurrent(forceFrame=false) {
  invalidateCandidate();
  const scene=current();
  if(!scene) return;
  const version=++frameVersion;
  if(!forceFrame){
    const candidate=candidates.get(scene.id);
    if(candidate && candidate.signature===currentShot()?.signature && candidate.asset.asset_id!==scene.clip_id){showCandidate(candidate);return;}
    if(currentShot()?.approved){play('/api/assets/clip/'+scene.clip_id);return;}
  }
  if(scene.reference_id && !forceFrame) {
    $('frame').src=api('/api/assets/image/'+scene.reference_id);return;
  }
  setTimeout(async()=>{
    if(version!==frameVersion)return;
    try {
      const blob=await(await request('/api/frame',{scene,style:project.style})).blob();
      if(version!==frameVersion)return;
      if(frameURL) URL.revokeObjectURL(frameURL);
      frameURL=URL.createObjectURL(blob);
      $('frame').src=frameURL;
    } catch(err) {
      if(version===frameVersion && scene.title && scene.narration) notice(err.message);
    }
  },90);
}
function play(url) {
  frameVersion+=1;
  $('player').src=api(url);$('player').hidden=false;$('frame').hidden=true;$('show-frame').hidden=false;
}
function showCandidate(candidate) {
  play(candidate.asset.url);
  const warnings=[...(candidate.asset.warnings || [])];
  const shot=currentShot();
  if(shot && candidate.asset.duration < shot.duration*.85) warnings.push('素材偏短，请试听合成并检查尾帧。');
  $('asset-checks').textContent=warnings.length?warnings.join(' '):'已通过格式检查。确认主体、动作和连续性后使用。';
  $('candidate-review').hidden=false;
}

function addCandidate(scene, candidate, source) {
  const version = {asset_id:candidate.asset.asset_id, signature:candidate.signature, source, created_at:Date.now(), pending:true};
  const versions=(scene.clip_versions || []).filter(item=>item.asset_id!==version.asset_id).map(item=>({...item,pending:false}));
  if(scene.clip_id && scene.clip_signature && !versions.some(item=>item.asset_id===scene.clip_id)){
    versions.unshift({asset_id:scene.clip_id,signature:scene.clip_signature,source:'saved',created_at:0,pending:false});
  }
  scene.clip_versions=[version,...versions].slice(0,6);
  candidates.set(scene.id,candidate);
  timelineState();
}

function refreshVersions() {
  const scene=current(), shot=currentShot();
  const versions=[...(scene.clip_versions || [])];
  if(scene.clip_id && scene.clip_signature && !versions.some(item=>item.asset_id===scene.clip_id)){
    versions.push({asset_id:scene.clip_id,signature:scene.clip_signature,source:'saved',created_at:0});
  }
  const candidate=candidates.get(scene.id);
  const selectedAsset=candidate?.signature===shot?.signature ? candidate?.asset.asset_id : scene.clip_id;
  $('version-bar').hidden=!versions.length;
  const select=$('version-select');
  select.replaceChildren(...versions.map((item,index)=>{
    const source={import:'导入',model:'模型生成',saved:'工程素材'}[item.source];
    const state=item.asset_id===scene.clip_id?' · 已选用':item.pending?' · 待审核':'';
    const date=item.created_at?' · '+new Date(item.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
    return new Option((versions.length-index)+' · '+source+state+date,item.asset_id);
  }));
  if(selectedAsset && versions.some(item=>item.asset_id===selectedAsset))select.value=selectedAsset;
  $('restore-version').hidden=true;
  $('compare-version').hidden=!scene.clip_id || !selectedAsset || scene.clip_id===selectedAsset;
}

$('version-select').addEventListener('change',()=>{
  const scene=current(), id=$('version-select').value;
  const candidate=candidates.get(scene.id);
  invalidateCandidate();
  if(candidate?.asset.asset_id===id && candidate.signature===currentShot()?.signature && id!==scene.clip_id)showCandidate(candidate);
  else play('/api/assets/clip/'+id);
  const version=scene.clip_versions?.find(item=>item.asset_id===id);
  $('restore-version').hidden=!version || id===scene.clip_id || version.signature!==currentShot()?.signature ||
    candidate?.asset.asset_id===id;
  $('compare-version').hidden=!scene.clip_id || id===scene.clip_id;
  $('compare-version').textContent='对比已确认版';
  if(version && id!==scene.clip_id && version.signature!==currentShot()?.signature){
    $('shot-status').textContent='此版对应旧画面要求，可播放对比。';
  }
});

$('compare-version').addEventListener('click',()=>{
  const showing=$('editor').classList.toggle('comparing');
  const player=$('compare-player');
  if(showing)player.src=api('/api/assets/clip/'+current().clip_id);
  else player.pause();
  $('compare-version').textContent=showing?'结束对比':'对比已确认版';
});

async function selectVersion(scene,id,signature) {
  scene.clip_id=id;
  scene.clip_signature=signature;
  scene.clip_versions=(scene.clip_versions || []).map(item=>({...item,pending:false}));
  candidates.delete(scene.id);
  shotJobs.delete(scene);
  $('shot-progress').hidden=true;
  changed();
  await syncPrompts();
  if(current()===scene){
    showCurrent();
    $('shot-status').textContent='本镜已确认，可用于合成。';
  }
}

action('restore-version',async()=>{
  const scene=current();
  const version=scene.clip_versions?.find(item=>item.asset_id===$('version-select').value);
  if(!version || version.signature!==currentShot()?.signature)throw new Error('该版本对应不同的画面要求。');
  await selectVersion(scene,version.asset_id,version.signature);
});
$('next-review').addEventListener('click',()=>{
  const next=project.scenes.map((_,i)=>(selected+i+1)%project.scenes.length)
    .find(i=>shotState(project.scenes[i],prompts?.shots[i])==='pending');
  if(next!==undefined)select(next);
});
$('engine').addEventListener('change',timelineState);

let openingSample=false;
async function openSample(){
  if(openingSample || chatBusy)return;
  openingSample=true;
  try{
    const value=await json('/api/examples/metal-project');
    const response=await fetch(sampleMedia+'metal-reference-motion.mp4');
    if(!response.ok)throw new Error('样片素材暂不可用。');
    const form=new FormData();
    form.append('file',await response.blob(),'metal-reference-motion.mp4');
    const asset=await json('/api/assets/clip',form);
    const compiled=await json('/api/prompts',value);
    value.scenes[0].clip_id=asset.asset_id;
    value.scenes[0].clip_signature=compiled.shots[0].signature;
    value.scenes[0].clip_versions=[{asset_id:asset.asset_id,signature:compiled.shots[0].signature,source:'import',created_at:0,pending:false}];
    setProject(value);
    resetConversation();
    location.hash='video';
    enterEditor();
    bubble('assistant','样片工程已打开。选一幕，就可以继续修改。');
  }catch(err){notice(err.message);}
  finally{openingSample=false;}
}
document.querySelectorAll('[data-open-sample]').forEach(button=>button.addEventListener('click',openSample));
function saveBlob(filename, text, mime) {
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1200);
}
async function copy(text) {
  if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else {
    const area=document.createElement('textarea');area.value=text;
    document.body.append(area);area.select();
    const ok=document.execCommand('copy');area.remove();
    if(!ok)throw new Error('浏览器未允许复制，可使用导出提示词。');
  }
  notice('已复制。');
}
function link(label,href,filename) {
  const a=document.createElement('a');a.textContent=label;a.href=href;a.download=filename;return a;
}
async function poll(job, onUpdate, timeout = 8 * 60 * 1000) {
  let result=job;
  const deadline = Date.now() + timeout;
  while(Date.now() < deadline){
    onUpdate(result);
    if(result.status==='done')return result;
    if(result.status==='failed')throw new Error(result.error||'任务失败。');
    await sleep(780);
    result=await json('/api/render/'+job.id);
  }
  throw new Error('等待超时，可以继续查询。');
}
function showProgress(id,state) {
  const box = $(id);
  const dial = box.querySelector('.task-dial');
  const completed = state.status==='done';
  const percent = completed ? 100 : !state.assembling && Number.isFinite(state.progress) ?
    Math.min(100,Math.max(0,Math.floor(state.progress*100))) : null;
  const marker = percent===null ? state.status==='failed'?'!':'…' : percent+'%';
  const phase = state.phase || '提交任务';
  const detail = state.error || (Number.isInteger(state.total_scenes) ?
    state.completed_scenes+' / '+state.total_scenes+' 幕已处理' : 'MiniMax H3');
  box.hidden=false;
  box.dataset.state=state.status;
  if(percent===null)dial.removeAttribute('aria-valuenow');
  else dial.setAttribute('aria-valuenow',String(percent));
  dial.setAttribute('aria-valuetext',percent===null?phase:percent+'% · '+phase);
  for(const [selector,value] of [['.task-value',marker],['[data-phase]',phase],['[data-progress-detail]',detail]]){
    const element = box.querySelector(selector);
    if(element.textContent!==value)element.textContent=value;
  }
  const arc = box.querySelector('.task-arc');
  if(box.dataset.percent!==String(percent)){
    box.dataset.percent=String(percent);
    box.dispatchEvent(new CustomEvent('pianyu:progress',{bubbles:true,detail:{arc,percent}}));
  }
  arc.style.visibility=percent===null?'hidden':'visible';
}
async function renderVideo(quality, single) {
  if(activeRender){notice('已有成片任务正在运行。');return;}
  if(config.local && Object.values(config.local).some(ready=>!ready)){
    throw new Error('本地合成依赖尚未齐全，请查看「模型配置」。');
  }
  activeRender=true;
  const version=revision, sceneAtStart=sceneVersion, engine=$('engine').value;
  const snapshot={...project,quality,engine,scenes:single?[current()]:project.scenes};
  const footageIds = new Set(snapshot.scenes.filter(scene=>scene.visual_method==='footage').map(scene=>scene.id));
  const outputs=$(single?'single-outputs':'outputs');
  outputs.before($('progress-box'));
  outputs.replaceChildren();
  if(!single)$('full-player').pause();
  showProgress('progress-box',{status:'queued',progress:0,phase:'提交本地合成',completed_scenes:0,total_scenes:snapshot.scenes.length});
  let lastState;
  try {
    const result=await poll(await json('/api/render',snapshot),state=>{
      lastState=state;
      showProgress('progress-box',state);
    });
    if(version===revision) {
      if(single && sceneAtStart===sceneVersion) {
        $('candidate-review').hidden=true;play(result.video);
      } else if(!single) {
        $('player').pause();
        $('full-player').src=result.video;
        $('full-player').hidden=false;
      }
    }
    const description=document.createElement('span');
    const reused=result.scenes.filter(s=>s.reused).length;
    const videos=result.scenes.filter(s=>s.source==='video').length;
    const missingFootage=engine==='hybrid' && result.scenes.some(s=>s.source==='code' && footageIds.has(s.id));
    description.textContent=(version===revision?'':'上一版 · ')+videos+' 幕视频素材 · '+(result.scenes.length-videos)+' 幕程序图解 · 复用 '+reused+' 幕'
      +(missingFootage?' · 未确认的视频镜头使用图解占位':'');
    outputs.replaceChildren(description,link('下载 MP4',result.video,'video.mp4'),link('下载字幕',result.subtitles,'subtitles.srt'));
  } catch(err) {
    showProgress('progress-box',{...lastState,status:'failed',phase:'合成失败',error:err.message});
    throw err;
  } finally {activeRender=false;}
}

const sceneInputs={'scene-title':'title','scene-kind':'kind','scene-camera':'camera','scene-visual':'visual','scene-narration':'narration',
  'scene-points':'points','scene-seconds':'seconds','scene-visual-method':'visual_method'};
for(const [id,key] of Object.entries(sceneInputs)){
  $(id).addEventListener(id==='scene-seconds'?'change':'input',event=>{
    const raw=event.target.value.trim();
    current()[key]=key==='points'?raw.split('\n').map(x=>x.trim().slice(0,35)).filter(Boolean).slice(0,4):
      key==='seconds'?Math.max(4,Math.min(15,Math.round(Number(raw)||6))):raw;
    if(key==='seconds')event.target.value=current().seconds;
    if(key==='title')tabs();
    changed();
  });
}
$('shot-prompt').addEventListener('change',event=>{
  if(event.target.value.trim()!==(current().prompt_override||currentShot()?.prompt||'')){
    current().prompt_override=event.target.value.trim();changed();
  }
});
async function reviseShot(owner, scene, message) {
  const before=JSON.stringify(scene);
  const result=await json('/api/revise',{scene,message});
  const index=owner.scenes.indexOf(scene);
  if(project!==owner || index<0 || JSON.stringify(scene)!==before)throw new Error('这幕已被修改，请核对后重试。');
  owner.scenes[index]=result.scene;
  if(selected===index)select(index,true);
  else {tabs();changed();}
  return result;
}
$('edit-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const text=$('edit-message').value.trim(), scene=current(), owner=project;
  if(!text)return;
  event.submitter.disabled=true;
  try {
    const result=await reviseShot(owner,scene,text);
    $('edit-message').value='';
    if(result.changed.includes('prompt_override'))notice('画面要求已更新，本镜提示词已按新要求重新编译。');
  } catch(err){notice(err.message);}
  finally{event.submitter.disabled=false;}
});
action('plan',async()=>{
  if(chatBusy)throw new Error('请等创作对话完成。');
  const topic=$('topic').value.trim();
  if(!topic){activateTab('brief-topic-tab');$('topic').focus();throw new Error('请先输入视频主题。');}
  if(!config.model_connected&&!$('source').value.trim()){
    activateTab('brief-material-tab');$('source').focus();throw new Error('离线模式需要参考资料。');
  }
  const result=await json('/api/plan',{topic,source:$('source').value,direction:$('direction').value,
    style_skill:$('video-profile').value,style:draft});
  setProject(result);
  enterEditor();
  bubble('assistant','第一版分镜已完成，共 '+result.scenes.length+' 幕。');
  rememberProject();
});
$('open-project').addEventListener('click',()=>$('project-file').click());
$('project-file').addEventListener('change',async event=>{
  try {
    if(event.target.files.length){
      if(chatBusy)throw new Error('请等创作对话完成。');
      const value = await json('/api/project',JSON.parse(await event.target.files[0].text()));
      $('source').value='';
      setProject(value);
      resetConversation();
      rememberProject();
      enterEditor();
    }
  } catch(err){notice(err.message);}
  finally{event.target.value='';}
});
$('save-project').addEventListener('click',()=>{
  rememberProject();
  saveBlob('video-project.json',JSON.stringify(project,null,2),'application/json');
});
$('add-scene').addEventListener('click',()=>{
  if(project.scenes.length>=7)return;
  const id=crypto.randomUUID().slice(0,10);
  project.scenes.splice(selected+1,0,{id,kind:'cards',title:'新镜头',kicker:'',points:[],narration:'请输入本镜旁白。',visual_method:'auto',
    sources:[],camera:'locked',seconds:6,visual:'',prompt_override:'',reference_id:null,clip_id:null,clip_signature:'',clip_versions:[]});
  select(selected+1,true);
});
for(const [id,delta] of [['move-left',-1],['move-right',1]])$(id).addEventListener('click',()=>{
  const next=selected+delta;
  [project.scenes[selected],project.scenes[next]]=[project.scenes[next],project.scenes[selected]];select(next,true);
});
$('remove').addEventListener('click',()=>{candidates.delete(current().id);project.scenes.splice(selected,1);select(Math.min(selected,project.scenes.length-1),true);});
$('show-frame').addEventListener('click',()=>showCurrent(true));
$('open-shot-prompt').addEventListener('click',()=>{
  $('prompt-drawer').open=true;
  activateTab('shot-tab');
  $('shot-prompt').focus();
});
action('preview',()=>renderVideo('preview',false));
action('preview-scene',()=>renderVideo('preview',true));
action('export',()=>renderVideo('export',false));
action('copy-master',async()=>copy((await syncPrompts()).complete));
action('copy-shot',async()=>{const id=current().id;const data=await syncPrompts();return copy(data.shots.find(s=>s.id===id).prompt);});
action('download-prompts',async()=>{const data=await syncPrompts();saveBlob('video-prompts.json',JSON.stringify(data,null,2),'application/json');});
action('reset-shot',async()=>{current().prompt_override='';changed();});

for(const [button,input,kind] of [['reference','reference-file','image'],['import-clip','clip-file','clip']]){
  $(button).addEventListener('click',()=>$(input).click());
  $(input).addEventListener('change',async event=>{
    const file=event.target.files[0], scene=current(), owner=project;
    if(!file)return;
    const form=new FormData();form.append('file',file);
    try {
      const signed=kind==='clip'?(await syncPrompts()).shots.find(shot=>shot.id===scene.id):null;
      const asset=await json('/api/assets/'+kind,form);
      if(project!==owner||!project.scenes.includes(scene))return;
      if(kind==='image') {
        scene.reference_id=asset.asset_id;
        changed();
      } else {
        const candidate={asset,signature:signed.signature};addCandidate(scene,candidate,'import');
        if(current()===scene && currentShot()?.signature===candidate.signature){showCandidate(candidate);applyPrompts();}
      }
    }catch(err){notice(err.message);}
    finally{event.target.value='';}
  });
}
action('remove-reference',async()=>{current().reference_id=null;changed();});
async function generateShot(regenerate=false){
  const scene=current(), owner=project;
  if(pendingShots.has(scene))return;
  const compiled=await syncPrompts();
  if(project!==owner || current()!==scene)throw new Error('镜头已切换，请重新发起。');
  const shot=compiled.shots.find(s=>s.id===scene.id);
  if(!scene.visual&&!scene.prompt_override){
    activateTab('shot-visual-tab');$('scene-visual').focus();
    throw new Error('先补充主体、场景和一个具体动作，或编辑本镜提示词。');
  }
  pendingShots.add(scene);attemptedShots.add(scene);applyPrompts();
  $('shot-status').textContent='';
  const update = state => {
    shotJobs.set(scene,state);
    if(project===owner)timelineState();
    if(current()===scene)showProgress('shot-progress',state);
  };
  update({status:'queued',phase:'提交镜头 · '+scene.seconds+' 秒'});
  try {
    const result=await poll(await json('/api/model-shots',{project:owner,scene_id:scene.id,regenerate}),update,18 * 60 * 1000);
    if(project!==owner||!project.scenes.includes(scene))return;
    const candidate={asset:result.asset,signature:result.signature||shot.signature};
    addCandidate(scene,candidate,'model');
    if(current()===scene && currentShot()?.signature===candidate.signature){
      showCandidate(candidate);applyPrompts();
    }else notice('素材已返回，原镜头已变化。按当前要求可重新生成。');
  }catch(err){update({status:'failed',phase:'镜头生成失败',error:err.message});throw err;}
  finally{pendingShots.delete(scene);if(current()===scene){$('generate-shot').disabled=!config.video_connected;$('retry-shot').disabled=false;}}
}
action('generate-shot',()=>generateShot(false));
action('retry-shot',()=>generateShot(true));
action('approve',async()=>{
  const scene=current(), candidate=candidates.get(scene.id);
  if(!candidate||candidate.signature!==currentShot()?.signature)throw new Error('镜头要求已改变，请重新预览当前版本。');
  await selectVersion(scene,candidate.asset.asset_id,candidate.signature);
});

async function boot(){
  tab();setDraft({...defaults,background:'#101010',text:'#F2F2F2',accent:'#BBBBBB'});
  const [options,examples]=await Promise.all([json('/api/options'),json('/api/examples')]);
  config=options;
  $('mode').textContent=config.model_connected?'DeepSeek 已配置':'离线资料模式';
  $('provider').textContent=config.video_connected?'MiniMax H3 · '+config.video_resolution+' · 可逐镜生成':'填写 MiniMax Key 后可生成镜头，也可导入 MP4';
  const status = (id, ready, missing) => {
    $(id).textContent = ready ? '已配置' : missing;
    $(id).classList.toggle('ready',ready);
  };
  status('text-config-state',config.model_connected,'离线模式');
  status('video-config-state',config.video_connected,'待填写 Key');
  status('local-config-state',Object.values(config.local).every(Boolean),'依赖待安装');
  const readyCount = [config.model_connected,config.video_connected,Object.values(config.local).every(Boolean)].filter(Boolean).length;
  $('setup-readiness').textContent=readyCount+' / 3 项已配置';
  $('setup-video-model').textContent=config.video_models[config.video_model]+' · '+config.video_resolution;
  for(const [key,label,hint] of [
    ['ffmpeg','FFmpeg 和 ffprobe','安装 FFmpeg 或设置 VIDEO_FFMPEG_DIR'],
    ['voice','Piper 中文语音','运行 setup_voice.py'],
    ['fonts','中文字体','设置 VIDEO_FONT 和 VIDEO_FONT_BOLD'],
  ]){
    $(key+'-check').textContent=label+' · '+(config.local[key]?'已就绪':hint);
  }
  $('generate-shot').disabled=!config.video_connected;
  for(const [index,example] of examples.entries()){
    const [label,caption,direction]=approaches[index] || ['示例','',''];
    const button=document.createElement('button');
    const kind=document.createElement('span');kind.textContent=label;
    const title=document.createElement('strong');title.textContent=example.topic;
    const description=document.createElement('span');description.textContent=caption;
    button.append(kind,title,description);
    button.addEventListener('click',()=>{
      $('topic').value=example.topic;
      $('source').value=example.source;
      $('direction').value=direction;
      $('chat-message').value='我想做一期「'+example.topic+'」，请根据项目里的资料做第一版分镜。';
      workspaceView('chat');
      $('chat-message').focus();
    });
    $('examples').append(button);
  }
  await refreshProfiles();
}
showRecentProjects();
boot().catch(err=>notice(err.message));

let accountName='';
let registering=false;
function showAccount() {
  $('account-title').textContent=accountName ? '片语账号' : registering ? '注册片语' : '登录片语';
  $('account-form').hidden=Boolean(accountName);
  $('account-signed-in').hidden=!accountName;
  $('account-user').textContent=accountName ? '当前账号 · '+accountName : '';
  $('account-submit').textContent=registering ? '注册并登录' : '登录';
  $('account-switch').textContent=registering ? '已有账号？登录' : '注册账号';
  $('account-password').autocomplete=registering ? 'new-password' : 'current-password';
  document.querySelectorAll('[data-account]').forEach(button=>{
    button.textContent=accountName ? '账号 · '+accountName : '登录 / 注册';
  });
}
document.querySelectorAll('[data-account]').forEach(button=>button.addEventListener('click',()=>{
  $('account-status').textContent='';
  $('account-password').value='';
  registering=false;
  showAccount();
  $('account-dialog').showModal();
}));
$('account-dialog').addEventListener('close',()=>$('account-password').value='');
$('account-switch').addEventListener('click',()=>{
  registering=!registering;
  $('account-status').textContent='';
  showAccount();
});
$('account-form').addEventListener('submit',async event=>{
  event.preventDefault();
  $('account-submit').disabled=$('account-switch').disabled=true;
  try{
    const result=await json('/api/account/'+(registering?'register':'login'),{
      username:$('account-name').value.trim(),password:$('account-password').value
    });
    accountName=result.username;
    showAccount();
    $('account-dialog').close();
    notice(registering?'注册成功，已登录。':'登录成功。');
  }catch(err){$('account-status').textContent=err.message;}
  finally{$('account-submit').disabled=$('account-switch').disabled=false;}
});
action('logout',async()=>{
  await json('/api/account/logout',{});
  accountName='';
  $('account-status').textContent='已退出登录。';
  showAccount();
});
json('/api/account/me').then(result=>{accountName=result.username || '';showAccount();}).catch(()=>{});
