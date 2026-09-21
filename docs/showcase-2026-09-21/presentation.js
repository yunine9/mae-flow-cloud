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
// 每段保留完整讲解；底栏仅放一句提要，不用播放时长裁剪正文。
const beats=[
 ['overview',[],[], '做完一个需求，也为下一个需求留下经验。',
  '这张图从上往下看：上层把需求变成真正合入的代码，中层把做过的事情整理成以后能用的知识，底层负责连接 Agent、代码仓和研发工具。\n\n比如做一个新接口，不只是让 AI 写出代码，还要把测试、检视、修改和合入接起来。过程中发现的内部组件用法和常见错误，经过人审视后留下来，下次遇到类似需求就有据可查。',
  '上层完成交付，中层积累知识，底层连接实际研发环境。'],
 ['delivery',['intent','design'],['delivery-0'],'先说清楚做什么，再决定怎么分工。',
  '拿到需求后，先明确用户要解决什么问题、哪些内容本次要做、怎样算完成，再分析各个模块的职责和依赖，形成需求说明、设计文档和子任务。\n\n例如几个功能都要用一个新接口，可以先把公共接口搭好，再让各个功能并行开发。已有接口足够稳定的任务可以直接并行，不必等整个前置需求合入；有真实依赖的部分才需要等待。',
  '按真实依赖安排工作，避免一个大任务把后面的开发全堵住。'],
 ['delivery',['design','develop'],['delivery-1'],'写代码之前，先弄清楚公司里应该怎么写。',
  'Agent 结合实施计划和现有代码开发，也要查当前问题需要的内部知识。工作步骤由 Workflow 和 Skill 提供，组件用法、编码规范等文档通过知识工具按需查找。\n\n例如要在 C++ 中读写文件，就应先查内部文件组件怎么打开、释放和处理异常，再把适用做法用到实现和单元测试中。不需要开局就背下整本手册，而是在真正用到时读懂相关章节。',
  '带着适用的组件用法和规范实现代码，同时编写单元测试。'],
 ['delivery',['develop','verify'],['delivery-2','repair'],'代码写完不算完成，要让真实验证说话。',
  'Agent 要运行实际的编译、单元测试和流水线，依据结果修复问题，不能只说“应该没问题”。例如测试报错，就查看失败用例和日志，修改后再验证。\n\n检视意见则需要人的判断：尤其是 AI 提出的建议，不一定都值得改。责任人可以补充说明、自己答复或闭环，也可以选中多条统一交给 Agent，避免为了追逐新意见无休止地改代码。',
  '客观失败进入修复；检视建议由责任人判断和分派。'],
 ['delivery',['iterate','deliver'],['delivery-4'],'把推送、修复和合入接起来，少让人来回盯。',
  '代码准备好后，平台衔接推送和 MR 创建，持续观察流水线与 MR 状态。需要修复时把具体问题交给 Agent；需要人做决定时，通过工作台和小鲁班通知责任人。\n\n首次交付还会生成简短的交付摘要，帮助检视者理解改了什么、验证了什么。后面的修复继续围绕具体问题快速迭代，直到 MR 实际合入，再确认这次需求完成。',
  '交付进展可见，需要处理的事项主动送到责任人面前。'],
 ['knowledge',['deliver','retrospect'],['learn'],'合入之后，回头看哪些地方本来可以一次写对。',
  '任务完成后，Agent 结合检视意见和首次交付之后的代码修改做复盘：哪些地方反复改了，最初缺少什么知识，什么经验能帮助下一次开发。\n\n比如代码最初用了不允许的原生库，后来改成内部组件，值得留下的是“这个场景应该使用哪个组件、如何使用”。复盘先生成待审视的草稿，再通知责任人，不把一次修改直接当成所有项目都适用的规则。',
  '从交付后的真实修改中提炼经验，而不是只复述任务经过。'],
 ['knowledge',['retrospect','organize','adopt'],['retrospect-organize','organize-adopt'],'把具体教训讲成能复用的做法，再请人把关。',
  '一条有用的经验要说清：什么时候适用、应该怎么做、为什么，以及一个容易理解的例子。去掉工单号和偶然的业务细节，但保留必要条件与依据。\n\n例如“修了某个回调崩溃”还不够，应说明异步回调中对象何时可能销毁、如何保证生命周期。团队成员可以修改、采纳或放弃草稿；采纳后才进入日常知识复用，来源和修改记录也会保留。',
  'Agent 负责整理，人判断是否正确、是否值得长期复用。'],
 ['knowledge',['adopt','assets','search'],['adopt-assets','assets-search'],'知识要能找对，也要知道用在哪儿。',
  '规范、内部组件手册、业务知识和已采纳经验，以文档保存并建立检索索引。语言、模块、仓库和版本等适用范围，帮助区分名字相似但规则不同的知识。\n\nAgent 遇到具体问题时，用统一的 knowledge 工具搜索，结合关键词与语义找到相关章节，再读取原文、核对适用条件。例如“谁负责关闭文件句柄”，应该找到对应组件的资源释放约定，而不是照搬另一个模块的规则。',
  '知识带着来源和适用范围被检索，读取后再决定怎么用。'],
 ['knowledge',['search','extract','organize'],['search-extract','gap'],'没有现成手册，就从真实代码里找做法。',
  '内部组件往往不是通用模型熟悉的内容。平台可以按主题研究，也可以选定语言后扫描已配置的同语言组件仓，从源码中识别接口，再通过跨仓搜索寻找真实调用例子。\n\n例如研究文件组件，不仅看函数声明，还看大家怎样按顺序调用、怎样处理失败、怎样释放资源和编写测试。提炼出来的知识保留源码依据，供人审视。普通搜索仍保持轻量，知识萃取在后台单独执行。',
  '源码和真实调用例子共同支撑组件知识，补上模型不知道的部分。'],
 ['knowledge',['search','design','develop'],['reuse','delivery-1'],'上次留下的经验，要真正用进下次代码里。',
  '新任务进入相关设计或实现问题时，Agent 检索并使用已采纳的知识。价值不在于平台存了多少篇文档，而在于下一次少走了哪些弯路、少改了哪些重复错误。\n\n随着文档增多，定时整理把相近内容归纳、减少重复，保留适用条件和来源；整理了什么、何时整理、依据是什么，都有记录可回看。知识因此可以持续维护，而不是越积越乱。',
  '检索让知识进入开发，定时整理让积累的内容保持可用。'],
 ['overview',foundation,[],'底下这层，负责让整件事稳定地跑起来。',
  '主 Agent 衔接任务，子 Agent 按需要承担分析、实现、测试和知识整理；能独立做的工作并行推进。宿主保存执行状态，连接 Git、CodeHub、流水线和通知工具，支持任务暂停与恢复。\n\n工作方法尽量放进可维护的提示词、Workflow 和 Skill。程序承担必要的权限、状态和工具操作，避免因为重复审批或形式检查让任务反复卡住。这样既能改方法，也能查清出了什么问题。',
  'Agent 分工执行，宿主衔接工具和状态，工作方法可以持续调整。'],
 ['philosophy',[],[],'让人把精力花在判断上，让经验留得下来。',
  '人负责目标、边界和关键取舍，Agent 承担具体执行。已经确认的决定应持续生效，真正需要判断时再找人，而不是靠不断点确认推动流程。\n\n我们的取舍是：流程不能明显提升质量，就应该为速度让步；可靠性要靠真实验证和可追溯的结果。一次交付结束，代码进入仓库，经过审视的经验也留给团队，让下一次开发有更好的起点。',
  '可靠、易改、够快、安全，体现在每天开发时的具体取舍里。']
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
 const visible=beat>=0;
 $('#auto-explanation').hidden=!visible;$('.stage').classList.toggle('presenting',visible);
 $('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${playing?'自动讲解':'已暂停'}`;
 $('#auto-title').textContent=title;$('#auto-body').textContent=body;$('#auto-body').scrollTop=0;
 $('#lecture-pause').textContent=playing?'暂停':'继续';
 $('#auto-explanation').classList.remove('arriving');void $('#auto-explanation').offsetWidth;$('#auto-explanation').classList.add('arriving');
}
$('#zoom-in').addEventListener('click',()=>manualZoom(1.25));
$('#zoom-out').addEventListener('click',()=>manualZoom(.8));
$('#fit').addEventListener('click',()=>setScene('overview'));
$('#lecture-pause').addEventListener('click',()=>togglePlay());
$('#lecture-next').addEventListener('click',()=>showBeat(beat+1));
// 阅读正文时停留在当前段，用户主动继续，避免长文在阅读中自动消失。
for(const event of ['pointerenter','focus'])$('#auto-body').addEventListener(event,()=>{if(playing)stop()});

function caption(label,title,body){$('#chapter').textContent=label;$('#narrative-title').textContent=title;$('#narrative-body').textContent=body}
function clearParticles(){svg.querySelectorAll('.flow-particle').forEach(n=>n.remove())}
function focus(ids=[],edgeIds=[]){const selected=new Set(ids),es=new Set(edgeIds);nodes.forEach(n=>{n.classList.toggle('dim',selected.size>0&&!selected.has(n.dataset.nodeId));n.classList.toggle('active',selected.has(n.dataset.nodeId));n.setAttribute('aria-pressed',String(selected.has(n.dataset.nodeId)))});edges.forEach(e=>{const lit=es.has(e.dataset.edgeId)||(es.size===0&&selected.has(e.dataset.edgeFrom)&&selected.has(e.dataset.edgeTo));e.classList.toggle('dim',selected.size>0&&!lit);e.classList.toggle('active',lit)});clearParticles();if(playing){svg.querySelectorAll('path[data-edge-id].active').forEach(p=>{const c=p.cloneNode();for(const a of [...c.attributes])if(a.name.startsWith('data-')||a.name==='marker-end')c.removeAttribute(a.name);c.setAttribute('class','flow-particle');c.setAttribute('stroke',p.classList.contains('knowledge-edge')?'#a0f9df':'#b5eaff');p.after(c)})}}
function stop(){playing=false;clearTimeout(timer);clearParticles();$('#play').innerHTML=`▶ <span>${beat>=0&&beat<beats.length-1?'继续播放':beat===beats.length-1?'重新播放':'一键播放'}</span>`;$('#play').setAttribute('aria-label',beat>=0&&beat<beats.length-1?'继续播放讲解':'一键播放完整讲解');$('#lecture-pause').textContent='继续';if(beat>=0)$('#auto-step').textContent=`${String(beat+1).padStart(2,'0')} / ${beats.length} · 已暂停`}
function setScene(name,manual=true){if(manual){beat=-1;stop();clearExplanation();moveCamera(fullView)}scene=name;$('#diagram').inert=name==='philosophy';$('#diagram').setAttribute('aria-hidden',String(name==='philosophy'));$('#detail').hidden=true;$('#philosophy').hidden=name!=='philosophy';document.querySelectorAll('[data-scene]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.scene===name)));const ids=name==='delivery'?delivery:name==='knowledge'?[...knowledge,'design','deliver']:[];focus(ids);const s=scenes[name];caption(s.label,s.title,s.body);if(manual)$('#progress').style.width='12%'}
function showBeat(index){beat=(index+beats.length)%beats.length;const [name,ids,es,title,body,takeaway]=beats[beat];setScene(name,false);focus(ids,es);explainBeat(name,title,body);focusCamera(ids);caption(`${String(beat+1).padStart(2,'0')} / ${beats.length} · ${name==='knowledge'?'知识闭环':name==='delivery'?'交付闭环':name==='philosophy'?'设计思想':'全景架构'}`,title,takeaway);$('#progress').style.width=`${(beat+1)/beats.length*100}%`;if(playing){clearTimeout(timer);timer=setTimeout(()=>{if(beat===beats.length-1)stop();else showBeat(beat+1)},3300)}}
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
