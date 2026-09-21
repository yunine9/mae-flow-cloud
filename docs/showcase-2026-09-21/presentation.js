'use strict';
const graph=JSON.parse(document.querySelector('#graph-data').textContent);
const svg=document.querySelector('#diagram>svg');
const nodes=[...svg.querySelectorAll('[data-node-id]')];
const edges=[...svg.querySelectorAll('[data-edge-id]')];
const knowledge=new Set(['extract','search','assets','adopt','organize','retrospect']);
const delivery=['intent','design','develop','verify','iterate','deliver'];
const foundation=['agents','harness','tools'];
const ns='http://www.w3.org/2000/svg';
const details={
 intent:['交付闭环','先把要解决的问题讲清楚，明确目标、边界与验收预期，形成可共同审视的 Spec。','人的决定进入后续执行，不靠反复交代维持上下文。'],
 design:['交付闭环','分析模块职责和依赖，形成 Story 与任务拆分。公共准备按需先行，互不依赖的工作谨慎并行。','连线表达协作和依赖，不意味着所有任务一律串行。'],
 develop:['交付闭环','Agent 结合实施计划、现有代码和适用知识完成代码与 UT。主会话和子任务按需要协作。','知识按当前问题检索，不将整本手册塞进每轮上下文。'],
 verify:['交付闭环','编译、测试和流水线提供真实结果。人工与 MR 检视意见由责任人判断是否交给 Agent 修复。','自动修复客观失败；不盲目追着每条 AI 检视意见反复修改。'],
 iterate:['交付闭环','宿主推送代码、创建 MR 并持续观察远端结果。Agent 承接修复，责任人掌握取舍与交付范围。','首次交付生成简明摘要，后续修复保持短反馈。'],
 deliver:['交付闭环','以实际 MR 合入确认交付，保留代码、验证和过程材料；完成后自动启动经验复盘。','合入是事实，交付后复盘是知识闭环的输入。'],
 retrospect:['知识自闭环','结合首次交付后的代码修改和检视意见，分析为什么一次没有写对，提炼可复用经验草稿。','任务完成后自动启动；草稿待人审视，不直接变成团队规范。'],
 organize:['知识自闭环','去掉具体任务细节，保留可复用的原则、条件和例子；定时整理已有文档，减少重复和零散知识。','整理记录保留时间、来源与改动依据，便于核查。'],
 adopt:['知识自闭环','成员可以审视、修改、采纳知识草稿。依据信任原则开放维护，保留来源、适用范围和修改记录。','自动化负责提炼和整理，人判断是否值得长期复用。'],
 assets:['知识自闭环','统一管理规范、组件用法、业务模块知识和已采纳经验。以 Markdown 保留内容，索引供按需检索。','语言、业务模块、仓库与版本定义适用范围；Skill 独立承载方法。'],
 search:['知识自闭环','Agent 使用统一 knowledge 工具，结合关键词与语义匹配查找当前问题所需知识，读取证据后应用。','普通检索不启动萃取；发现内部组件知识缺口时，Agent 可发起后台研究。'],
 extract:['知识自闭环','从已配置的同语言组件仓读取源码，结合跨仓代码搜索寻找真实用例，提炼调用顺序、资源管理和测试范式。','支持按主题研究或一键扫描全部同语言组件；草稿保留源码依据。'],
 agents:['工程能力底座','主会话衔接任务上下文，子任务承担分析、实现、验证与知识工作；具备条件时并行推进。','并行服务闭环效率，按依赖和实际写入边界安排工作。'],
 harness:['工程能力底座','Workflow 和 Skill 组织工作方法；Cloud 宿主编排执行、保存状态并支持恢复，连接内核与外部工具。','保留必要权限和真实事实边界，不用无效流程替代质量。'],
 tools:['工程能力底座','连接代码仓、CodeHub、CI、构建测试环境和代码搜索，小鲁班将进展与待处理事项送给责任人。','复用已有研发环境，不另造一套脱离实际交付的演示链路。']
};
const scenes={
 overview:{label:'全景 / OVERVIEW',title:'交付是结果，知识是留下来的能力。',body:'上层完成一次真实交付，中层让经验持续回流，底层让人、Agent 与现有研发环境协同工作。'},
 delivery:{label:'01 / DELIVERY LOOP',title:'从需求意图，一路走到真实合入。',body:'澄清、设计、开发、验证与 MR 迭代相互衔接；真实失败进入修复，检视意见由人判断与分派。'},
 knowledge:{label:'02 / KNOWLEDGE LOOP',title:'发现缺口、补充知识、交付复盘，再回到下一次开发。',body:'自动萃取与复盘产生草稿，人工审视后入库；按需检索和定时整理，让经验持续积累并可复用。'},
 philosophy:{label:'03 / DESIGN PRINCIPLES',title:'可靠、易改、够快、安全，要落实在具体取舍里。',body:'不把流程完整当作质量证明；人把握方向、Agent 执行，让真实交付成为组织能力的积累。'}
};
const beats=[
 ['overview',[],[], '两条闭环，一套底座。','需求交付形成代码，知识回流支撑下次开发。'],
 ['delivery',['intent','design'],['delivery-0'],'先拆清，再并行。','明确目标与依赖，让独立任务同时推进。'],
 ['delivery',['design','develop'],['delivery-1'],'带着知识写代码。','Workflow、Skill 与知识支撑代码和 UT。'],
 ['delivery',['develop','verify'],['delivery-2','repair'],'用真实结果验证。','编译、测试失败自动修；检视意见由人取舍。'],
 ['delivery',['iterate','deliver'],['delivery-4'],'持续迭代，直到合入。','连接 Git、MR 与流水线，进度可见、可恢复。'],
 ['knowledge',['deliver','retrospect'],['learn'],'合入后，自动复盘。','对比交付后的修改，分析为什么一次没写对。'],
 ['knowledge',['retrospect','organize','adopt'],['retrospect-organize','organize-adopt'],'提炼共性，人来采纳。','归纳适用条件与做法，成员审视后入库。'],
 ['knowledge',['adopt','assets','search'],['adopt-assets','assets-search'],'知识在需要时出现。','按语言、模块和当前问题检索适用知识。'],
 ['knowledge',['search','extract','organize'],['search-extract','gap'],'缺知识，就从源码补齐。','组件源码与跨仓真实用例支撑范式萃取。'],
 ['knowledge',['search','design','develop'],['reuse','delivery-1'],'回到开发，形成闭环。','经验用于下次实现，定时整理减少重复。'],
 ['overview',foundation,[],'工程底座，让能力可靠。','Agent 协作、任务恢复与工具适配共同支撑。'],
 ['philosophy',[],[],'从个人提效，到组织能力。','人做判断，Agent 执行，经验反复复用。']
];
let scene='overview',playing=false,beat=-1,timer;
const $=s=>document.querySelector(s);
const fullView=svg.getAttribute('viewBox').split(/\s+/).map(Number);
let camera=[...fullView],cameraFrame;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function moveCamera(target){
 cancelAnimationFrame(cameraFrame);
 const from=[...camera],started=performance.now();
 function draw(now){const t=reducedMotion.matches?1:Math.min(1,(now-started)/350);const eased=1-(1-t)**3;camera=from.map((n,i)=>n+(target[i]-n)*eased);svg.setAttribute('viewBox',camera.join(' '));$('#zoom-level').textContent=`${Math.round(fullView[2]/camera[2]*100)}%`;if(t<1)cameraFrame=requestAnimationFrame(draw)}
 cameraFrame=requestAnimationFrame(draw);
}
function focusCamera(ids){
 if(!ids.length){moveCamera(fullView);return}
 const boxes=nodes.filter(n=>ids.includes(n.dataset.nodeId)).map(n=>n.getBBox());
 const left=Math.min(...boxes.map(b=>b.x)),right=Math.max(...boxes.map(b=>b.x+b.width));
 const top=Math.min(...boxes.map(b=>b.y)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
 const ratio=fullView[2]/fullView[3];
 const width=Math.min(fullView[2],Math.max(right-left+100,(bottom-top+80)*ratio,fullView[2]/1.7));
 const height=width/ratio;
 moveCamera([Math.max(0,Math.min(fullView[2]-width,(left+right-width)/2)),Math.max(0,Math.min(fullView[3]-height,(top+bottom-height)/2)),width,height]);
}
function manualZoom(factor){stop();const width=Math.max(fullView[2]/2.5,Math.min(fullView[2],camera[2]/factor));const height=width*fullView[3]/fullView[2];moveCamera([Math.max(0,Math.min(fullView[2]-width,camera[0]+(camera[2]-width)/2)),Math.max(0,Math.min(fullView[3]-height,camera[1]+(camera[3]-height)/2)),width,height])}
function clearExplanation(){$('#auto-explanation').hidden=true;$('.stage').classList.remove('presenting')}
function explainBeat(name,title,body){
 const visible=name!=='philosophy'&&beat>0;
 $('#auto-explanation').hidden=!visible;$('.stage').classList.toggle('presenting',visible);
 $('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${playing?'自动讲解':'已暂停'}`;
 $('#auto-title').textContent=title;$('#auto-body').textContent=body;
 $('#lecture-pause').textContent=playing?'暂停':'继续';
 $('#auto-explanation').classList.remove('arriving');void $('#auto-explanation').offsetWidth;$('#auto-explanation').classList.add('arriving');
}
$('#zoom-in').addEventListener('click',()=>manualZoom(1.25));
$('#zoom-out').addEventListener('click',()=>manualZoom(.8));
$('#fit').addEventListener('click',()=>setScene('overview'));
$('#lecture-pause').addEventListener('click',()=>togglePlay());
$('#lecture-next').addEventListener('click',()=>showBeat(beat+1));

function caption(label,title,body){$('#chapter').textContent=label;$('#narrative-title').textContent=title;$('#narrative-body').textContent=body}
function clearParticles(){svg.querySelectorAll('.flow-particle').forEach(n=>n.remove())}
function focus(ids=[],edgeIds=[]){const selected=new Set(ids),es=new Set(edgeIds);nodes.forEach(n=>{n.classList.toggle('dim',selected.size>0&&!selected.has(n.dataset.nodeId));n.classList.toggle('active',selected.has(n.dataset.nodeId));n.setAttribute('aria-pressed',String(selected.has(n.dataset.nodeId)))});edges.forEach(e=>{const lit=es.has(e.dataset.edgeId)||(es.size===0&&selected.has(e.dataset.edgeFrom)&&selected.has(e.dataset.edgeTo));e.classList.toggle('dim',selected.size>0&&!lit);e.classList.toggle('active',lit)});clearParticles();if(playing){svg.querySelectorAll('path[data-edge-id].active').forEach(p=>{const c=p.cloneNode();for(const a of [...c.attributes])if(a.name.startsWith('data-')||a.name==='marker-end')c.removeAttribute(a.name);c.setAttribute('class','flow-particle');c.setAttribute('stroke',p.classList.contains('knowledge-edge')?'#a0f9df':'#b5eaff');p.after(c)})}}
function stop(){playing=false;clearTimeout(timer);clearParticles();$('#play').innerHTML=`▶ <span>${beat>=0&&beat<beats.length-1?'继续播放':beat===beats.length-1?'重新播放':'一键播放'}</span>`;$('#play').setAttribute('aria-label',beat>=0&&beat<beats.length-1?'继续播放讲解':'一键播放完整讲解');$('#lecture-pause').textContent='继续';if(beat>=0)$('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · 已暂停`}
function setScene(name,manual=true){if(manual){beat=-1;stop();clearExplanation();moveCamera(fullView)}scene=name;$('#diagram').inert=name==='philosophy';$('#diagram').setAttribute('aria-hidden',String(name==='philosophy'));$('#detail').hidden=true;$('#philosophy').hidden=name!=='philosophy';document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.scene===name)));const ids=name==='delivery'?delivery:name==='knowledge'?[...knowledge,'design','deliver']:[];focus(ids);const s=scenes[name];caption(s.label,s.title,s.body);if(manual)$('#progress').style.width='12%'}
function showBeat(index){beat=(index+beats.length)%beats.length;const [name,ids,es,title,body]=beats[beat];setScene(name,false);focus(ids,es);explainBeat(name,title,body);focusCamera(ids);caption(`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${name==='knowledge'?'知识闭环':name==='delivery'?'交付闭环':name==='philosophy'?'设计思想':'全景架构'}`,title,body);$('#progress').style.width=`${(beat+1)/beats.length*100}%`;if(playing){clearTimeout(timer);timer=setTimeout(()=>{if(beat===beats.length-1)stop();else showBeat(beat+1)},3300)}}
function togglePlay(){if(playing){stop();return}playing=true;$('#play').innerHTML='Ⅱ <span>暂停讲解</span>';$('#play').setAttribute('aria-label','暂停讲解');showBeat(beat<0||beat===beats.length-1?0:beat)}
document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>setScene(b.dataset.scene)));
$('#play').addEventListener('click',togglePlay);
$('#previous').addEventListener('click',()=>{stop();showBeat(beat<=0?0:beat-1)});
$('#next').addEventListener('click',()=>{stop();showBeat(beat+1)});
function showDetail(n){stop();clearExplanation();moveCamera(fullView);const id=n.dataset.nodeId,[category,body,foot]=details[id];$('#detail-category').textContent=category;$('#detail-title').textContent=graph.components.find(c=>c.id===id).label;$('#detail-body').textContent=body;$('#detail-foot').textContent=foot;$('#detail').hidden=false;focus([id]);$('#close-detail').focus()}
nodes.forEach(n=>{n.addEventListener('click',()=>showDetail(n));n.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();showDetail(n)}})});
$('#close-detail').addEventListener('click',()=>setScene(scene));
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{caption('全屏提示','可使用浏览器全屏展示。','当前浏览器未开放网页全屏权限，可以使用浏览器的全屏功能继续演示。')}});
document.addEventListener('fullscreenchange',()=>{$('#fullscreen').innerHTML=document.fullscreenElement?'⛶ <span>退出全屏</span>':'⛶ <span>全屏</span>'});
$('#export').addEventListener('click',()=>{if(/^https?:$/.test(location.protocol)){const a=document.createElement('a');a.href=new URL('architecture.svg',location.href).href;a.download='MAE-Flow-端到端架构.svg';a.click();return}const copy=svg.cloneNode(true);copy.setAttribute('xmlns',ns);copy.setAttribute('viewBox',fullView.join(' '));copy.querySelectorAll('.flow-particle').forEach(n=>n.remove());copy.querySelectorAll('.dim,.active').forEach(n=>n.classList.remove('dim','active'));const style=document.createElementNS(ns,'style');style.textContent=$('#presentation-style').textContent;copy.prepend(style);const bg=document.createElementNS(ns,'rect');bg.setAttribute('width','100%');bg.setAttribute('height','100%');bg.setAttribute('fill','#081322');style.after(bg);const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml'}));const a=document.createElement('a');a.href=url;a.download='MAE-Flow-端到端架构.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
document.addEventListener('keydown',e=>{if(e.target.closest('button,input,textarea,[data-node-id]'))return;if(e.key===' '){e.preventDefault();togglePlay()}else if(e.key==='ArrowRight'){stop();showBeat(beat+1)}else if(e.key==='ArrowLeft'){stop();showBeat(beat<=0?0:beat-1)}else if(e.key==='Escape'){stop();setScene('overview')}});
let autoStart=new URLSearchParams(location.search).get('autoplay')==='1';
function startWhenVisible(){if(autoStart&&!document.hidden){autoStart=false;togglePlay()}}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else startWhenVisible()});
setScene('overview');
startWhenVisible();
