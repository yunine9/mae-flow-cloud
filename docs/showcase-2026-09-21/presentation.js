'use strict';
const data=JSON.parse(document.querySelector('#graph-data').textContent);
const $=s=>document.querySelector(s);
const ns='http://www.w3.org/2000/svg';
const scenes={
 overview:{label:'全景 / OVERVIEW',title:'交付是结果，知识是留下来的能力。',body:'从需求到 MR 迭代，从三类知识生产到外部仓库与 RAG 消费；切换视图，展开每个能力域。'},
 delivery:{label:'01 / DELIVERY VIEW',title:'把交付拆开看：首次交付、MR LOOP、合入与反馈。',body:'客观失败自动修复，检视意见由人判断；观察 → 修复 → 提交 → 复验，直到真实合入。'},
 knowledge:{label:'02 / KNOWLEDGE VIEW',title:'知识有来处、有归宿，也有明确的消费入口。',body:'三类生产 → 审视治理 → 外部知识仓 → 获取与 RAG。统一呈现生产、治理、外部存储与消费；标记“近期接入”的能力正在规划开发。'},
 philosophy:{label:'03 / DESIGN PRINCIPLES',title:'人掌方向，Agent 执行；流程为质量和速度服务。',body:'方法可维护、过程可追溯、知识可带走。让真实交付和反复复用的经验成为组织能力。'}
};
// 保留完整讲解，短播放只控制节奏。移入讲解正文即可暂停阅读。
const beats=[
 ['overview',[],[], '一次交付，留下两份成果。',
  '一份是实际合入的代码，另一份是以后还能用的知识。上层把需求分析、开发、测试、MR 修复与合入接起来；中层把复盘、组件研究和业务资料汇成知识，再回到下一次开发。\n\n下面的工程底座负责衔接 Agent、Git、流水线、代码搜索和通知。全景先讲清各部分关系，交付视图和知识视图再展开每个大框里的具体能力。',
  '交付闭环完成需求，知识闭环让下一次开发有更好的起点。'],
 ['delivery',['d_plan','d_code','d_verify'],['d_plan_code','d_code_verify'],'先分清职责，再带着适用知识写代码。',
  '先明确需求边界与验收目标，再分析模块职责和依赖，形成 Story 与实施计划。公共接口需要先准备，互不依赖的任务可以并行；同仓不意味着一律串行。\n\n例如要用内部 C++ 组件读文件，先查接口、资源归属和失败处理，再落实到代码和 UT。编译与测试要真正执行，失败日志是修复依据，不能靠一句“应该通过”代替结果。',
  '模块职责、依赖和适用知识，共同指导实现与验证。'],
 ['delivery',['d_scope','d_mr','d_report'],['d_scope_mr','d_summary'],'首次交付：确认范围、提交 MR、留下简短说明。',
  '责任人核对交付范围与检视意见，宿主执行分支同步、推送和 MR 创建或关联。已经确认的文件范围继续有效，不因为同范围修复产生新 SHA 就反复问同一个问题。\n\n首次交付后台生成短摘要，用图说明主要变化，交代执行了哪些测试、覆盖哪些场景，帮助 Committer 抓住重点。后续每轮修复不反复重写报告，让 MR 尽快闭环。',
  '代码发布与交付说明各司其职，摘要在后台生成。'],
 ['delivery',['d_watch','d_gate','d_push'],['d_fail','d_repair','d_repeat'],'LOOP 的核心，是围绕当前失败快速复验。',
  '平台观察当前发布版本的 MR 与流水线，拿到编译、UT、CodeCheck 等真实失败后，把具体日志交给 Agent。Agent 修复并提交新版本，宿主推送，监听随之切到新版本，重新验证。\n\n这个循环不是固定跑几轮，也不是把旧日志反复交给 Agent。新结果决定下一步；真实工具错误要能看见，需要人的决定要及时提出，实际合入才算交付完成。',
  '观察当前结果 → 定向修复 → 发布新版本 → 再验证。'],
 ['delivery',['d_comments','d_triage','d_review','d_push'],['d_judge','d_assign','d_submit_review'],'检视建议先让人判断，不让两个 AI 互相追着改。',
  'MR 上的人工意见和数字人报告进入统一批注。责任人可以自行答复、闭环，也可以补充具体要求后，把值得修改的一批交给 Agent。Agent 根据采纳的意见修改，再汇入发布与验证。\n\n数字人每次提交都可能出新报告，但新报告不代表每条都要自动改。人的筛选能切断无休止返工；相互独立的检视修复与 CI 工作具备条件时可以协作推进。',
  '流水线失败与检视建议分开处理，人掌握修改的取舍和节奏。'],
 ['delivery',['d_merge','d_notify','d_retro'],['d_know','d_retrospect'],'合入之后交付完成，经验复盘再接上。',
  'MR 真正合入后才确认任务交付，保留代码、测试和过程记录。需要人关注的新意见、交付摘要与复盘草稿，通过工作台和小鲁班送达，责任人不必一直盯着页面。\n\n这时再分析首次交付后的修改与检视意见：最初为什么没有写对，什么经验值得给下一个需求用。产物先是待审草稿，不阻塞本次合入，也不未经判断直接变成规范。',
  '以实际合入完成交付，以待审草稿开启知识回流。'],
 ['knowledge',['k_retro','k_component','k_business'],[], '知识生产有三条路，不只有检视意见。',
  '第一条是交付复盘，从实际返工中总结经验。第二条是基础组件萃取，按语言扫描组件仓，用源码定义和跨仓真实调用归纳公司内部的开发范式。\n\n第三条是资料与源码治理：承接瑞阳团队已有的 Skill，把业务资料与模块源码一起研究，整理业务概念、职责和使用条件。这套团队方法将接入平台，图中以“近期接入”标明，三条路线最终都产出可阅读的 Markdown。',
  '交付复盘、基础组件、业务资料与源码，汇入同一治理链。'],
 ['knowledge',['k_component','k_organize'],['k_produce_1'],'内部组件怎么用，要从真实使用中找答案。',
  '不只把头文件翻译成说明书。组件研究会先读接口、实现与测试，再通过代码搜索查其他仓库怎样调用，归纳调用顺序、错误处理、资源生命周期和 UT/Mock 方式。\n\n比如文件句柄由谁关闭、异步回调中对象如何存活，这些都应有源码或调用依据。研究过程与草稿可查看，可重试；知识不足时也可以后台补充，不让普通检索等待完整扫描。',
  '从真实源码和调用例子提炼开发范式，补上模型不熟悉的内部知识。'],
 ['knowledge',['k_adopt','k_organize','k_scope'],['k_adopt_organize','k_organize_scope'],'把零散经验整理成有边界、能复用的做法。',
  'Agent 先提炼，人来判断、修改和采纳。定时整理再把零散文档按主题组织起来，减少重复，保留推荐步骤、最小例子和必要例外，并记录整理了什么、依据什么。\n\n抽象不等于去掉所有条件。两个模块术语相近，规则可能不同，所以语言、业务模块、仓库与版本都要保留。成员基于信任维护，来源和变更留痕，方便纠正和回溯。',
  '人审视结论，系统保留出处与适用条件，定时整理减少碎片。'],
 ['knowledge',['k_organize','k_git'],['k_to_git'],'知识最终要能放进公共仓，离开平台也能用。',
  '治理后的资产以 Markdown 保存，外部公共 Git 仓承载文档、目录结构和版本历史。目标是自动发布到专用分支，由人审视合入主分支；自动发布近期接入，当前已经支持导出文档后人工入仓。\n\n这样，知识不是只能在这个平台里检索的一堆向量。团队能直接阅读、维护、备份，也能交给别的 Coding Agent 使用。原文才是资产，索引只是为了更快找到内容。',
  '治理后的 Markdown 发布到公共仓，形成可移植、可版本管理的组织资产。'],
 ['knowledge',['k_git','k_import','k_index','k_search'],['k_get','k_build_index','k_rag'],'从仓里取回知识，再为当前问题检索。',
  '消费端从指定仓库和分支选文件或文件夹导入，保留相对路径与来源，长文分节后建立检索索引。当前支持主动导入和更新，不把它说成已经完成自动双向同步。\n\nAgent 用统一 knowledge 工具，结合关键词与语义匹配寻找相关章节。接口名、错误码靠精确匹配，自然语言问题靠语义召回；找到后展开原文，核对语言、模块和版本，再决定怎么用。',
  '外部仓获取 → 分节与索引 → RAG 检索 → 原文核对。'],
 ['knowledge',['k_search','k_apply','k_feedback'],['k_use','k_learn','k_cycle'],'查到知识还不够，要用到计划、代码和测试里。',
  '例如即将使用 C++ 文件组件，就查当前组件的打开顺序、异常处理和释放约定，把它写进实施计划并落实到代码与 UT。进入新技术问题或遇到意外结果时再检索，已读且仍适用的内容直接复用。\n\n交付后产生新经验，知识缺口可以发起研究，不适用的文档可以修正，再回到治理。普通文档走知识工具，Skill 保持独立加载，避免把所有手册都塞进系统提示词。',
  '消费进入实际开发，交付反馈重新推动知识生产与治理。'],
 ['overview',['o_agents','o_harness','o_tools'],[],'工程底座把这些能力接成日常能用的工具。',
  '主 Agent 衔接目标和上下文，子任务按需要承担分析、实现、验证和知识工作。宿主管理执行状态、工具连接、隔离、暂停与恢复，接入团队已有的代码仓、流水线、构建环境和通知。\n\n工作方法放进可维护的 Workflow、Skill 和提示词，必要的外部操作和真实结果由程序处理。这样既能逐步改方法，也能查清哪里失败，减少形式检查和重复确认带来的等待。',
  '方法可调整、过程可追溯、工具可连接，独立工作按需并行。'],
 ['philosophy',[],[],'让人做判断，让经验留得下来。',
  '人负责目标、边界和关键取舍，Agent 承担具体执行。已经确认的决定应持续生效，真正需要判断时再找人；流程不能显著提升质量，就应该为速度让步。\n\n一次交付结束，代码进入业务仓，经过审视的知识也应成为可带走、能维护、可复用的 Markdown 资产。可靠、易改、够快、安全，就体现在每一天的这些具体取舍里。',
  '代码形成交付，经验形成资产，人的判断始终有效。']
];
let scene='overview',view='overview',playing=false,beat=-1,timer,svg,nodes=[],edges=[],fullView,camera,cameraFrame;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function mountView(name){
 if(svg&&view===name)return;
 cancelAnimationFrame(cameraFrame);view=name;
 $('#diagram').replaceChildren($(`#view-${name}`).content.cloneNode(true));
 svg=$('#diagram>svg');nodes=[...svg.querySelectorAll('[data-node-id]')];edges=[...svg.querySelectorAll('[data-edge-id]')];
 fullView=svg.getAttribute('viewBox').split(/\s+/).map(Number);camera=[...fullView];$('#zoom-level').textContent='100%';
 nodes.forEach(n=>{n.setAttribute('role','button');n.setAttribute('tabindex','0');n.setAttribute('aria-label',data.graphs[name].components.find(c=>c.id===n.dataset.nodeId).label+'：查看职责');n.addEventListener('click',()=>showDetail(n));n.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();showDetail(n)}})});
}
function moveCamera(target){
 cancelAnimationFrame(cameraFrame);const from=[...camera],started=performance.now();
 function draw(now){const t=reducedMotion.matches?1:Math.min(1,(now-started)/350),eased=1-(1-t)**3;camera=from.map((n,i)=>n+(target[i]-n)*eased);svg.setAttribute('viewBox',camera.join(' '));$('#zoom-level').textContent=`${Math.round(fullView[2]/camera[2]*100)}%`;if(t<1)cameraFrame=requestAnimationFrame(draw)}
 cameraFrame=requestAnimationFrame(draw);
}
function focusCamera(ids){
 const boxes=nodes.filter(n=>ids.includes(n.dataset.nodeId)).map(n=>n.getBBox());
 if(!boxes.length){moveCamera(fullView);return}
 const left=Math.min(...boxes.map(b=>b.x)),right=Math.max(...boxes.map(b=>b.x+b.width)),top=Math.min(...boxes.map(b=>b.y)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
 const ratio=fullView[2]/fullView[3],width=Math.min(fullView[2],Math.max(right-left+100,(bottom-top+80)*ratio,fullView[2]/1.7)),height=width/ratio;
 moveCamera([Math.max(0,Math.min(fullView[2]-width,(left+right-width)/2)),Math.max(0,Math.min(fullView[3]-height,(top+bottom-height)/2)),width,height]);
}
function manualZoom(factor){stop();const width=Math.max(fullView[2]/2.5,Math.min(fullView[2],camera[2]/factor)),height=width*fullView[3]/fullView[2];moveCamera([Math.max(0,Math.min(fullView[2]-width,camera[0]+(camera[2]-width)/2)),Math.max(0,Math.min(fullView[3]-height,camera[1]+(camera[3]-height)/2)),width,height])}
function clearExplanation(){$('#auto-explanation').hidden=true;$('.stage').classList.remove('presenting')}
function explainBeat(title,body){$('#auto-explanation').hidden=false;$('.stage').classList.add('presenting');$('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${playing?'自动讲解':'已暂停'}`;$('#auto-title').textContent=title;$('#auto-body').textContent=body;$('#auto-body').scrollTop=0;$('#lecture-pause').textContent=playing?'暂停':'继续'}
function caption(label,title,body){$('#chapter').textContent=label;$('#narrative-title').textContent=title;$('#narrative-body').textContent=body}
function clearParticles(){svg?.querySelectorAll('.flow-particle').forEach(n=>n.remove())}
function focus(ids=[],edgeIds=[]){const selected=new Set(ids),es=new Set(edgeIds);nodes.forEach(n=>{n.classList.toggle('dim',selected.size>0&&!selected.has(n.dataset.nodeId));n.classList.toggle('active',selected.has(n.dataset.nodeId));n.setAttribute('aria-pressed',String(selected.has(n.dataset.nodeId)))});edges.forEach(e=>{const lit=es.has(e.dataset.edgeId)||(es.size===0&&selected.has(e.dataset.edgeFrom)&&selected.has(e.dataset.edgeTo));e.classList.toggle('dim',selected.size>0&&!lit);e.classList.toggle('active',lit)});clearParticles();if(playing&&!reducedMotion.matches)svg.querySelectorAll('path[data-edge-id].active').forEach(p=>{const c=p.cloneNode();for(const a of [...c.attributes])if(a.name.startsWith('data-')||a.name==='marker-end')c.removeAttribute(a.name);c.setAttribute('class','flow-particle');c.setAttribute('stroke',p.classList.contains('knowledge-edge')?'#a0f9df':'#b5eaff');p.after(c)})}
function stop(){playing=false;clearTimeout(timer);clearParticles();$('#play').innerHTML=`▶ <span>${beat>=0&&beat<beats.length-1?'继续播放':beat===beats.length-1?'重新播放':'一键播放'}</span>`;$('#play').setAttribute('aria-label',beat>=0&&beat<beats.length-1?'继续播放讲解':'一键播放完整讲解');$('#lecture-pause').textContent='继续';if(beat>=0)$('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · 已暂停`}
function setScene(name,manual=true){
 if(!scenes[name])name='overview';
 if(manual){beat=-1;stop();clearExplanation()}
 closeDetail();scene=name;mountView(name==='philosophy'?'overview':name);
 if(manual)moveCamera(fullView);
 $('#diagram').inert=name==='philosophy';$('#diagram').setAttribute('aria-hidden',String(name==='philosophy'));$('#detail').hidden=true;$('#philosophy').hidden=name!=='philosophy';
 document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.scene===name)));
 focus();const s=scenes[name];caption(s.label,s.title,s.body);if(manual)$('#progress').style.width='0%';
}
function showBeat(index){beat=(index+beats.length)%beats.length;const [name,ids,es,title,body,takeaway]=beats[beat];setScene(name,false);focus(ids,es);explainBeat(title,body);focusCamera(ids);caption(`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${scenes[name].label.split(' / ')[0]}`,title,takeaway);$('#progress').style.width=`${(beat+1)/beats.length*100}%`;if(playing){clearTimeout(timer);timer=setTimeout(()=>{if(beat===beats.length-1)stop();else showBeat(beat+1)},3300)}}
function togglePlay(){if(playing){stop();return}playing=true;$('#play').innerHTML='Ⅱ <span>暂停讲解</span>';$('#play').setAttribute('aria-label','暂停讲解');showBeat(beat<0||beat===beats.length-1?0:beat)}
function showDetail(n){stop();clearExplanation();moveCamera(fullView);const id=n.dataset.nodeId,[body,foot]=data.details[id];$('#detail-category').textContent=scenes[scene].label;$('#detail-title').textContent=data.graphs[view].components.find(c=>c.id===id).label;$('#detail-body').textContent=body;$('#detail-foot').textContent=foot;$('#detail-foot').hidden=!foot;$('#detail').hidden=false;$('.stage').classList.add('inspecting');focus([id]);$('#close-detail').focus()}
function closeDetail(){$('#detail').hidden=true;$('.stage').classList.remove('inspecting')}
document.querySelectorAll('[data-scene]').forEach(b=>b.addEventListener('click',()=>{closeDetail();setScene(b.dataset.scene)}));
$('#play').addEventListener('click',()=>{closeDetail();togglePlay()});
$('#previous').addEventListener('click',()=>{closeDetail();stop();showBeat(beat<=0?0:beat-1)});
$('#next').addEventListener('click',()=>{closeDetail();stop();showBeat(beat+1)});
$('#zoom-in').addEventListener('click',()=>manualZoom(1.25));$('#zoom-out').addEventListener('click',()=>manualZoom(.8));
$('#fit').addEventListener('click',()=>{closeDetail();setScene(scene)});
$('#lecture-pause').addEventListener('click',togglePlay);$('#lecture-next').addEventListener('click',()=>showBeat(beat+1));
for(const event of ['pointerenter','focus'])$('#auto-body').addEventListener(event,()=>{if(playing)stop()});
$('#close-detail').addEventListener('click',()=>{closeDetail();focus();moveCamera(fullView)});
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{caption('全屏提示','可使用浏览器全屏展示。','当前浏览器未开放网页全屏权限，可以使用浏览器的全屏功能继续演示。')}});
document.addEventListener('fullscreenchange',()=>{$('#fullscreen').innerHTML=document.fullscreenElement?'⛶ <span>退出全屏</span>':'⛶ <span>全屏</span>'});
$('#export').addEventListener('click',()=>{
 const name=`MAE-Flow-${view==='knowledge'?'知识视图':view==='delivery'?'交付视图':'全景架构'}.svg`;
 if(/^https?:$/.test(location.protocol)){const a=document.createElement('a');a.href=new URL(data.filenames[view],location.href).href;a.download=name;a.click();return}
 const copy=svg.cloneNode(true);copy.setAttribute('xmlns',ns);copy.setAttribute('viewBox',fullView.join(' '));copy.querySelectorAll('.flow-particle').forEach(n=>n.remove());copy.querySelectorAll('.dim,.active').forEach(n=>n.classList.remove('dim','active'));const style=document.createElementNS(ns,'style');style.textContent=$('#presentation-style').textContent;copy.prepend(style);const bg=document.createElementNS(ns,'rect');bg.setAttribute('width','100%');bg.setAttribute('height','100%');bg.setAttribute('fill','#081322');style.after(bg);const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){stop();closeDetail();setScene('overview');return}if(e.target.closest('button,input,textarea,[data-node-id],#auto-body'))return;if(e.key===' '){e.preventDefault();togglePlay()}else if(e.key==='ArrowRight'){stop();showBeat(beat+1)}else if(e.key==='ArrowLeft'){stop();showBeat(beat<=0?0:beat-1)}});
let autoStart=new URLSearchParams(location.search).get('autoplay')==='1';
function startWhenVisible(){if(autoStart&&!document.hidden){autoStart=false;togglePlay()}}
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else startWhenVisible()});
setScene(new URLSearchParams(location.search).get('view')||'overview');startWhenVisible();
