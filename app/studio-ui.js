'use strict';
const el=id=>document.getElementById(id);
const states={ready:'Chờ vẽ sau khi rà toàn job',saved:'Đã lưu CVAT',matched:'Khớp bản gốc',review:'Cần kiểm tra bản vẽ',proposal:'Có gợi ý sửa',error:'Lỗi',no_driver:'Không có người lái',unavailable:'Frame bị bỏ qua'};
let data={rows:[]},selected=null;
let listKey='';
let tab='draw',renderId=0;
const drafts=new Map(),reviewDrafts=new Map();
const picked=new Set();
let confirmedFrames=[],applying=false,starting=false,switching=false;
const isFace=()=>data.mode==='face';
const totalFrames=()=>(data.last??-1)-(data.first??0)+1;
const frameNumber=f=>String(f).padStart(2,'0');
const draftId=r=>[r.frame,r.state,r.id||0,r.revision||''].join('/');
const legacyExit='Pose agent failed (exit 1)';
function failureText(message){
  return message===legacyExit?'Lượt chạy trước dừng với mã 1. Phiên bản cũ chưa lưu nguyên nhân. Tích frame này để chạy lại.':message;
}
function retrying(row){
  return row?.state==='error' && data.running===true && data.current===row.frame;
}
function frameStatus(row){
  if(retrying(row))return 'Đang chạy lại';
  if(row.state==='error' && row.note===legacyExit)return 'Cần chạy lại';
  if(row.saveUnverified)return 'Chờ xác minh bản lưu';
  return states[row.state]||row.state;
}
const canReview=r=>!!r && !!data.reviewFrames?.includes(r.frame);
const awaitsReview=r=>canReview(r) && !r.reviewDone;
const saved=r=>!!r && !r.saveUnverified && (r.state==='saved'||r.savedId!=null);
function runControls(){
  el('runPicked').textContent='Chạy frame đã tích ('+picked.size+')';
  el('runPicked').disabled=!picked.size||starting||applying||data.running||!data.connected||!data.frameSelection;
  el('clearPicked').hidden=!picked.size;
  el('clearPicked').disabled=starting||data.running;
  const report=data.scanReport;
  el('runHint').textContent=!data.frameSelection?'Đóng cửa sổ Chrome của Studio rồi mở lại launcher để cập nhật.':
    report?.retry?'Frame '+frameNumber(report.retry.frame)+(report.retry.attempt?' gặp HTTP 429. Tự thử lại lần '+report.retry.attempt+'/'+report.retry.max:' sẽ được gửi tới AI')+
      ' sau '+Math.max(0,Math.ceil((report.retry.at-Date.now())/1000))+' giây. Bấm Tạm dừng để dừng lượt chạy.':
    report?.total && data.running && data.current!=null && !applying?'Đã xử lý '+report.finished+'/'+report.total+' frame trong lượt chạy.':
    picked.size?'Sẽ chạy AI trên frame '+[...picked].sort((a,b)=>a-b).map(frameNumber).join(', ')+'.':'Tích ô cạnh số frame để chạy lại AI trên các frame đó.';
  el('runIssues').textContent=[...(report?.errors||[]).map(e=>'Frame '+frameNumber(e.frame)+' · '+failureText(e.message)),
    ...(report?.interrupted!=null?['Đã tạm dừng khi chờ thử lại frame '+frameNumber(report.interrupted)+'.']:[]),
    ...(report?.deferred?.length?['Các frame chưa gửi tới AI: '+report.deferred.map(frameNumber).join(', ')+'.']:[]),
    ...(report?.unselected?.length?['Cần chọn lại đề xuất cho frame '+report.unselected.map(frameNumber).join(', ')+'.']:[])].join('\n');
}
function approvalControls(){
  const chosen=data.rows.filter(r=>r.selected);
  const errors=data.rows.filter(r=>r.state==='error');
  let reason='';
  if(!data.frameSelection)reason='Đóng cửa sổ Chrome của Studio rồi mở lại launcher để dùng phiên bản mới.';
  else if(!data.connected)reason='Chọn Mở CVAT để kết nối lại.';
  else if(applying||data.running||starting)reason='Chờ thao tác hiện tại hoàn tất.';
  else if(data.rows.length<totalFrames()||errors.length)reason='Cần rà đủ '+totalFrames()+' frame. Đã rà '+(data.rows.length-errors.length)+'/'+totalFrames()+'.';
  else if(!chosen.length)reason='Mở một frame rồi bấm Chọn để phê duyệt trong tab Vẽ và phê duyệt.';
  else if(chosen.some(r=>drafts.has(draftId(r))))reason='Có thay đổi mới. Bấm Chọn để phê duyệt lại ở frame '+chosen.filter(r=>drafts.has(draftId(r))).map(r=>frameNumber(r.frame)).join(', ')+'.';
  el('apply').disabled=!!reason;
  el('applyHint').textContent=chosen.length+' frame chờ ghi. '+(reason||'Bấm Áp dụng để xem danh sách và xác nhận lưu.');
}
function node(tag,text){const n=document.createElement(tag);n.textContent=text??'';return n;}
async function call(action,arg){return window.landmarkDesk(action,arg,data.mode||'pose');}
function warn(e){el('error').textContent=e.message||String(e);}
function button(text,fn){const b=node('button',text);b.onclick=()=>Promise.resolve(fn()).catch(warn);return b;}
async function update(){
  const next=await call('state');
  const previous=data.rows.find(r=>r.frame===selected);
  const wasRetrying=retrying(previous);
  if(data.mode && next.mode!==data.mode){
    selected=null;renderId++;listKey='';picked.clear();drafts.clear();reviewDrafts.clear();confirmedFrames=[];
    el('applyDialog').close();el('frameActions').hidden=true;el('native').hidden=true;el('title').textContent='Chi tiết frame';el('detail').textContent='Chọn một frame để xem chi tiết.';
  }
  data=next; const rows=data.rows;
  el('mode').value=data.mode||'pose';el('mode').disabled=switching||data.switching||data.running||applying||starting;
  document.title='LandmarkDesk · '+(isFace()?'Face 50':'Pose 17')+' · Job '+data.jobId;
  el('modelName').textContent=data.model;
  for(const option of el('mode').options)option.disabled=!data.modes.includes(option.value);
  document.querySelector('h1').textContent=isFace()?'50 điểm khuôn mặt người lái':'Annotation người lái';
  document.querySelector('.mark').textContent=isFace()?'F50':'H17';
  el('progress').max=Math.max(1,totalFrames());
  const current=rows.find(r=>r.frame===selected);
  if(current && (current.state!==previous?.state||current.id!==previous?.id||current.revision!==previous?.revision||
      current.selected!==previous?.selected||current.saveUnverified!==previous?.saveUnverified||
      (current.state==='error' && (current.note!==previous?.note||retrying(current)!==wasRetrying))))show(selected).catch(warn);
  el('reviewTab').disabled=!canReview(current);
  el('status').textContent=data.status+(data.current!=null?' · Frame '+data.current:'');
  const reviewed=rows.filter(r=>r.state!=='error').length;
  el('count').textContent=reviewed+' / '+totalFrames();el('saved').textContent=rows.filter(saved).length;
  el('review').textContent=rows.filter(awaitsReview).length;
  el('suggest').textContent=rows.filter(r=>r.state==='proposal').length;el('progress').value=reviewed;
  el('start').disabled=starting||applying||data.running||!data.connected;el('pause').disabled=!data.running||applying;
  runControls();approvalControls();
  el('native').disabled=data.running;
  const key=JSON.stringify([data.mode,data.first,data.last,selected,el('filter').value,data.current,data.running,data.reviewFrames,rows.map(r=>[r.frame,frameStatus(r),r.selected,r.reviewDone,r.pending,r.revision,r.id,r.savedId])]);
  if(key===listKey)return;
  listKey=key;
  const list=el('list');list.replaceChildren();
  for(let f=data.first??0;f<=(data.last??-1);f++){
    const r=rows.find(x=>x.frame===f);
    const filter=el('filter').value;
    if(filter==='review'?!awaitsReview(r):filter==='saved'?!saved(r):filter && r?.state!==filter)continue;
    const b=button('',()=>show(f,true));b.className='frame';b.setAttribute('aria-current',String(selected===f));
    b.append(node('b',String(f).padStart(2,'0')),node('span',r?frameStatus(r):f===data.current?'Đang xử lý':'Đang chờ'),node('small',r?.selected?'Đã chọn':r?.id||r?.existing?'#'+(r.id||r.existing):''));
    const line=node('div'),label=node('label'),box=node('input');
    line.className='frame-row';box.type='checkbox';box.checked=picked.has(f);box.disabled=data.running;
    box.setAttribute('aria-label','Chạy AI trên frame '+frameNumber(f));
    box.onchange=()=>{if(box.checked)picked.add(f);else picked.delete(f);runControls();};
    label.append(box);line.append(label,b);list.append(line);
  }
}
async function show(f,navigate=false){
  const version=++renderId;
  if(selected!==f)el('error').textContent='';
  if(navigate && data.connected && !data.running)call('navigate',{frame:f}).catch(e=>{if(selected===f)warn(e);});
  const actions=el('frameActions');actions.replaceChildren();actions.hidden=true;
  selected=f;el('title').textContent='Frame '+String(f).padStart(2,'0');const pane=el('detail');pane.className='';pane.replaceChildren();
  pane.scrollTop=0;
  const r=data.rows.find(x=>x.frame===f);el('native').hidden=true;
  el('reviewTab').disabled=!canReview(r);
  el('reviewTab').title=canReview(r)?'Đánh giá bản đã lưu trên CVAT':'Review mở sau khi bản vẽ được xác minh trên CVAT.';
  if(!canReview(r))tab='draw';
  for(const t of ['draw','review'])el(t+'Tab').setAttribute('aria-pressed',String(t===tab));
  if(!r){pane.textContent='Frame chưa có kết quả.';return;}
  const note=retrying(r)?'Đang chạy lại frame '+frameNumber(f)+'.':r.state==='error'?failureText(r.note):r.note;
  if(r.state==='error' && tab==='draw')pane.append(node('p',note||'Lượt rà frame gặp lỗi.'));
  const d=await call('detail',{frame:f});if(version!==renderId)return;
  el('native').hidden=!d.image&&!r.protected;el('native').dataset.frame=f;
  if(tab==='review'){
    if(note)pane.append(node('p',isFace() && r.checkedTwice?'Ghi chú từ lượt rà · '+note:note));
    pane.append(node('p',r.reviewDone?'Đã hoàn tất review':'Đang chờ review bản đã lưu trên CVAT.'));
    const record=reviewDrafts.get(f)||{...d.review}, inputs={};
    for(const [key,title] of Object.entries({team_vote:'Kết quả biểu quyết nhóm',cvat_issue:'Issue/comment CVAT',mentor_decision:'Kết luận mentor'})){
      const label=node('label',title),input=node('textarea');input.value=record[key]||'';input.rows=2;
      input.oninput=()=>{record[key]=input.value;reviewDrafts.set(f,record);};label.append(input);pane.append(label);inputs[key]=input;
    }
    for(const [title,complete] of [['Lưu ghi chú review',false],['Hoàn tất review',true]]){
      const submit=button(title,async()=>{
        await call('review',{frame:f,fields:Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])),complete});
        reviewDrafts.delete(f);await update();await show(f);el('error').textContent=(complete?'Đã hoàn tất review':'Đã lưu ghi chú')+' cho frame '+frameNumber(f)+'.';
      });
      actions.append(submit);
    }
    actions.hidden=false;return;
  }
  if(!d.image){if(note && r.state!=='error')pane.append(node('p',note));return;}
  pane.append(node('p',frameStatus(r)+(r.id?' · #'+r.id:'')));
  if(r.revision && d.decision)pane.append(node('p','Bộ điểm chờ ghi là lựa chọn đã lưu của bạn. Bấm Bỏ chọn để xem đề xuất từ lượt chạy mới.'));
  const img=node('img'),caption=node('p'),views=node('div');views.className='actions';
  const view=(title,src)=>{img.src=src;img.alt=title+' · frame '+f;caption.textContent=title;};
  const nativeTitle=r.state==='saved'?'Ảnh khi vẽ · đã xác minh trên CVAT':'Bản nháp Draw skeleton · chờ duyệt';
  view(d.native?nativeTitle:'Đề xuất của AI',d.native||d.image);
  for(const [title,src] of [['Ảnh gốc',d.original],['Đề xuất của AI',d.image],[nativeTitle,d.native]]){
    if(src)views.append(button(title,()=>view(title,src)));
  }
  const figure=node('div'),canvas=node('canvas');figure.className='preview';figure.append(img,canvas);canvas.hidden=true;
  pane.append(figure,caption,views);
  const info=node('details'),summary=node('summary',(isFace()?'Đối chiếu từng điểm (':'Đối chiếu từng khớp (')+d.points.length+')');info.append(summary);pane.append(info);
  const table=node('table'),head=node('tr');for(const h of ['ID / khớp','Nhãn gốc','AI','Trạng thái để lưu','x','y'])head.append(node('th',isFace()&&h==='ID / khớp'?'ID / contour':h));table.append(head);
  const joints=['Mũi','Mắt','Tai','Vai','Khuỷu','Cổ tay','Hông','Gối','Cổ chân'];
  const fmt=p=>p?p.state+(p.state==='Outside'?'':' ('+[p.x,p.y].map(n=>Math.round(n*10)/10).join(', ')+')'):'—';
  const editable=!r.protected && ['proposal','review','matched','saved','ready'].includes(r.state);
  const fields=[],controls=new Map();
  const draftKey=draftId(r);
  const discard=button('Bỏ chỉnh sửa nháp',async()=>{drafts.delete(draftKey);await show(f);approvalControls();el('error').textContent='Đã bỏ chỉnh sửa nháp ở frame '+f+'.';});
  discard.hidden=!drafts.has(draftKey);
  for(const p of (drafts.get(draftKey)||d.decision?.points||d.points)){
    const tr=node('tr');const old=d.old?.find(x=>x.id===p.id);
    const candidate=d.prediction.points.find(k=>k.id===p.id);
    const side=p.id===1?'':p.id%2===0?' · phải ảnh':' · trái ảnh';
    const name=isFace()?data.groups.find(g=>p.id>=g.first&&p.id<g.first+g.count).name:joints[Math.floor(p.id/2)]+side;
    tr.append(node('td',p.id+' '+name),node('td',fmt(old)),node('td',fmt(candidate)));
    const state=node('select');for(const v of ['Visible','Occluded','Outside']){const o=node('option',v);state.add(o);}state.value=p.state;
    const coords=[p.x,p.y].map(v=>{const i=node('input');i.type='number';i.step='any';i.value=v??'';return i;});
    state.disabled=!editable;state.setAttribute('aria-label','Trạng thái khớp '+p.id);
    coords.forEach((c,i)=>c.setAttribute('aria-label',(i?'y':'x')+' khớp '+p.id));
    const sync=()=>coords.forEach(c=>{c.disabled=!editable||state.value==='Outside';});
    state.onchange=sync;sync();
    for(const control of [state,...coords]){const td=node('td');td.append(control);tr.append(td);}
    fields.push(()=>({id:p.id,state:state.value,x:state.value==='Outside'?null:coords[0].valueAsNumber,y:state.value==='Outside'?null:coords[1].valueAsNumber}));
    controls.set(p.id,point=>{state.value=point.state;coords[0].value=point.x??'';coords[1].value=point.y??'';sync();});
    for(const control of [state,...coords])control.addEventListener('input',remember);
    table.append(tr);
    if(candidate?.evidence){
      const note=node('tr'),cell=node('td',candidate.evidence);cell.colSpan=6;cell.className='muted';note.append(cell);table.append(note);
    }
  }
  info.append(table);
  const qcNote=node('p'),qcButton=button('Gợi ý sửa đường viền',async()=>{
    const submitted=fields.map(read=>read());
    const result=await call('suggestGeometry',{frame:f,points:submitted});
    if(version!==renderId||JSON.stringify(submitted)!==JSON.stringify(fields.map(read=>read())))return;
    if(result.edits?.length){
      for(const p of result.edits)controls.get(p.id)(p);
      remember();
      qcNote.textContent='Đã chỉnh điểm '+result.edits.map(p=>p.id).join(', ')+' trong bản nháp. Đối chiếu ảnh rồi bấm Chọn để phê duyệt.';
    }else if(result.issues.length){
      qcNote.textContent=result.issues.join(' ')+' Chỉnh tọa độ trong bảng Đối chiếu từng điểm.';
      info.open=true;
    }else qcNote.textContent='Bộ điểm đang xem đạt kiểm tra đường viền.';
  });
  if(isFace() && editable){
    qcNote.textContent=drafts.has(draftKey)?'':(d.geometryIssues||[]).join(' ');
    qcNote.setAttribute('role','status');
    pane.insertBefore(qcNote,figure);
  }
  function paint(){
    if(canvas.hidden||!img.complete||!img.naturalWidth)return;
    const planned=fields.map(fn=>fn());
    const visible=planned.filter(p=>p.state!=='Outside' && Number.isFinite(p.x)&&Number.isFinite(p.y));
    let x=0,y=0,w=img.naturalWidth,h=img.naturalHeight,scale=1;
    if(isFace() && visible.length){
      const xs=visible.map(p=>p.x),ys=visible.map(p=>p.y);
      x=Math.max(0,Math.min(...xs)-12);y=Math.max(0,Math.min(...ys)-12);
      w=Math.max(1,Math.min(w,Math.max(...xs)+12)-x);h=Math.max(1,Math.min(h,Math.max(...ys)+12)-y);
      scale=Math.min(680/w,420/h);
    }
    canvas.width=Math.ceil(w*scale);canvas.height=Math.ceil(h*scale);
    const ctx=canvas.getContext('2d'),size=isFace()?5/scale:Math.max(4,canvas.width/130);
    ctx.scale(scale,scale);ctx.translate(-x,-y);
    if(isFace()){
      ctx.drawImage(img,0,0);ctx.strokeStyle='#6de5bc';ctx.lineWidth=1.2/scale;
      const located=new Map(visible.map(p=>[p.id,p]));
      for(const g of data.groups){
        for(let i=0;i<(g.closed?g.count:g.count-1);i++){
          const a=located.get(g.first+i),b=located.get(g.first+(i+1)%g.count);
          if(a && b){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
        }
      }
    }
    ctx.font='bold '+(isFace()?12/scale:Math.round(size*2))+'px sans-serif';
    ctx.lineWidth=isFace()?2/scale:Math.max(1,size/3);
    for(const p of visible){
      ctx.fillStyle=p.state==='Visible'?'#79ff98':'#ffbd48';ctx.strokeStyle='#111';
      ctx.beginPath();ctx.arc(p.x,p.y,size/1.5,0,2*Math.PI);ctx.fill();ctx.stroke();
      ctx.strokeText(String(p.id),p.x+size,p.y);ctx.fillText(String(p.id),p.x+size,p.y);
    }
  }
  function remember(){
    drafts.set(draftKey,fields.map(fn=>fn()));previewEdits();
    qcNote.textContent='';
    discard.hidden=false;
    approvalControls();
    el('error').textContent='Đang xem điểm dự kiến của frame '+f+'. Bấm Chọn để phê duyệt để đưa bộ điểm này vào danh sách.';
  }
  function previewEdits(){view('Điểm dự kiến lưu',d.original);figure.classList.toggle('face-plan',isFace());canvas.hidden=false;paint();}
  img.addEventListener('load',paint);
  if(!editable||fields.length!==(isFace()?50:17))return;
  for(const b of views.children)b.addEventListener('click',()=>{canvas.hidden=true;figure.classList.remove('face-plan');});
  views.append(button('Điểm dự kiến lưu',previewEdits));
  if(isFace()||drafts.has(draftKey)||d.decision)previewEdits();
  const bar=node('div'),pair=node('select');bar.className='swapbar';pair.setAttribute('aria-label','Cặp khớp trái/phải');
  // Swap entire contours in their image traversal order, retaining the winding of both eyes.
  const facePairs=[Array.from({length:5},(_,i)=>[i,i+5]),Array.from({length:8},(_,i)=>[14+i,22+i])];
  if(isFace()){
    pair.setAttribute('aria-label','Đổi bên contour Face');
    for(const [i,label] of ['Mày và mắt','Hai lông mày','Hai mắt'].entries()){const o=node('option',label);o.value=i;pair.add(o);}
  }else for(const [i,name] of ['Cả 8 cặp',...joints.slice(1)].entries()){const o=node('option',i?name+' ('+i*2+' ↔ '+(i*2+1)+')':name);o.value=i*2;pair.add(o);}
  bar.append(pair,button('Đổi trái ↔ phải',()=>{
    const points=new Map(fields.map(fn=>{const p=fn();return [p.id,p];}));
    const id=Number(pair.value);
    if(isFace()){
      for(const [a,b] of (id?facePairs[id-1]:facePairs.flat())){controls.get(a)(points.get(b));controls.get(b)(points.get(a));}
    }else for(let k=2;k<=16;k+=2)if(!id||id===k){controls.get(k)(points.get(k+1));controls.get(k+1)(points.get(k));}
    remember();
  }));
  if(d.old.length===(isFace()?50:17))bar.append(button('Dùng điểm đang lưu trên CVAT',()=>{for(const p of d.old)controls.get(p.id)(p);remember();}));
  pane.insertBefore(bar,info);
  actions.hidden=false;
  if(isFace())actions.append(qcButton);
  actions.append(button('Chọn để phê duyệt',async()=>{
    const result=await call('choose',{frame:f,points:fields.map(fn=>fn())});
    drafts.delete(draftKey);await update();await show(f);
    if(result?.unchanged)el('error').textContent='Bộ điểm trùng với bản đang lưu trên CVAT. Có thể hoàn tất review trong tab Review.';
    else if(result?.issues?.length)el('error').textContent='Đã chọn frame '+frameNumber(f)+' chờ sửa. '+result.issues.join(' ')+' Bấm Gợi ý sửa đường viền.';
    else el('error').textContent='Đã chọn frame '+frameNumber(f)+'. Sau khi rà hết job, bấm Áp dụng lựa chọn để xác nhận lưu trên CVAT.';
  }));
  if(r.selected)actions.append(button('Bỏ chọn',async()=>{await call('unchoose',{frame:f});drafts.delete(draftKey);await update();await show(f);}));
  actions.append(discard);
}
el('mode').onchange=async()=>{
  const mode=el('mode').value;
  if(drafts.size||reviewDrafts.size){el('mode').value=data.mode;warn(Error('Lưu hoặc bỏ bản nháp trước khi chuyển job.'));return;}
  switching=true;el('mode').disabled=true;el('error').textContent='';
  try{await call('mode',{mode});}catch(e){warn(e);}
  finally{switching=false;await update().catch(warn);}
};
for(const mode of ['draw','review'])el(mode+'Tab').onclick=()=>{
  el('error').textContent='';
  tab=mode;for(const t of ['draw','review'])el(t+'Tab').setAttribute('aria-pressed',String(t===tab));
  if(selected!==null)show(selected).catch(warn);
};
async function startRun(scoped){
  if(starting||applying||data.running)return;
  const frames=[...picked].sort((a,b)=>a-b);
  if(scoped && !frames.length)return;
  if(scoped && data.rows.some(r=>picked.has(r.frame)&&drafts.has(draftId(r)))){
    const dirty=data.rows.filter(r=>picked.has(r.frame)&&drafts.has(draftId(r))).map(r=>frameNumber(r.frame));
    warn(Error('Frame '+dirty.join(', ')+' có điểm đang chỉnh. Chọn để phê duyệt hoặc Bỏ chỉnh sửa nháp trước khi chạy lại.'));return;
  }
  starting=true;el('start').disabled=true;runControls();approvalControls();el('error').textContent='';
  try{await call(scoped?'startSelected':'start',scoped?{frames}:undefined);}
  catch(error){warn(error);}
  finally{starting=false;await update();}
}
el('start').onclick=()=>startRun(false).catch(warn);
el('runPicked').onclick=()=>startRun(true).catch(warn);
el('clearPicked').onclick=()=>{picked.clear();for(const box of el('list').querySelectorAll('input'))box.checked=false;runControls();};
el('pause').onclick=()=>call('pause').catch(warn);
el('open').onclick=()=>call('open').catch(warn);el('filter').onchange=()=>update().catch(warn);
el('native').onclick=()=>call('preview',{frame:selected}).catch(warn);
el('apply').onclick=()=>{
  if(el('apply').disabled)return;
  confirmedFrames=data.rows.filter(r=>r.selected).map(r=>r.frame);
  el('confirmFrames').textContent='Studio sẽ lưu và xác minh '+confirmedFrames.length+' frame trên CVAT: '+confirmedFrames.map(frameNumber).join(', ')+'.';
  el('applyDialog').showModal();
};
el('cancelApply').onclick=()=>el('applyDialog').close();
el('confirmApply').onclick=async()=>{
  if(applying||!el('applyDialog').open)return;
  const frames=confirmedFrames.slice();
  el('applyDialog').close();applying=true;approvalControls();runControls();
  el('error').textContent='Đang gửi '+frames.length+' lựa chọn để lưu trên CVAT…';
  try{el('error').textContent=await call('apply',{frames});}
  catch(error){warn(error);}
  finally{applying=false;await update().catch(warn);}
};
update().catch(warn);setInterval(()=>update().catch(warn),1500);
