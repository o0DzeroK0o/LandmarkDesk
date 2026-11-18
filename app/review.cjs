'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {frameDir,resultDir,selectedFrames,json,write}=require('./job.cjs');
const {draw,go,intent,reconcileSave}=require('./native.cjs');
const {obtain,hasPersonTrack}=require('./cvat.cjs');

function pointsOf(shape,person){
  const ids=new Map(person.sublabels.map(s=>[s.id,Number(s.name)]));
  return (shape?.elements||[]).map(e=>({id:ids.get(e.label_id),state:e.outside?'Outside':e.occluded?'Occluded':'Visible',
    x:e.outside?null:e.points[0],y:e.outside?null:e.points[1],xy:e.outside?null:e.points})).sort((a,b)=>a.id-b.id);
}
function detail(app,f){
  const row=app.rows?.find(r=>r.frame===f);
  const dir=resultDir(f,row);
  const record=path.join(frameDir(f),'review.json');
  if(!fs.existsSync(path.join(dir,'prediction.json')))return {review:fs.existsSync(record)?json(record):{}};
  const prediction=json(path.join(dir,'prediction.json'));
  const base=json(path.join(dir,'before.json'))[0];
  const label=app.config?.person||json(path.join(dir,'person.json'));
  const current=row?.state==='saved'?json(path.join(dir,'verified.json')):base;
  const old=pointsOf(current,label);
  const proposed=new Set(row?.changes?.map(p=>p.id));
  const points=row?.state==='saved'?old:prediction.points.map(p=>base && !proposed.has(p.id)?old.find(k=>k.id===p.id)||p:p);
  const decision=path.join(dir,'decision.json');
  const screenshot=path.join(dir,'native.png');
  const previous=fs.existsSync(decision)?json(decision):null;
  return {prediction,old,points,decision:row?.selected?previous:null,review:fs.existsSync(record)?json(record):previous?.human_review||{},
    native:row?.native && fs.existsSync(screenshot)?'data:image/png;base64,'+fs.readFileSync(screenshot).toString('base64'):null,
    image:'data:image/png;base64,'+fs.readFileSync(path.join(dir,'overlay.png')).toString('base64'),
    original:'data:image/png;base64,'+fs.readFileSync(path.join(dir,'input.png')).toString('base64')};
}
function validateDecision(d,row,width,height){
  if(!Array.isArray(d.points)||d.points.length!==17)throw Error('Cần đủ 17 khớp.');
  const seen=new Set(),visible=new Set();
  for(const p of d.points){
    if(!Number.isInteger(p.id)||p.id<1||p.id>17||seen.has(p.id))throw Error('ID khớp không hợp lệ.');
    seen.add(p.id);
    if(p.state==='Outside'){if(p.x!==null||p.y!==null)throw Error('Outside cần bỏ trống tọa độ.');continue;}
    if(!['Visible','Occluded'].includes(p.state)||![p.x,p.y].every(Number.isFinite)||p.x<0||p.x>=width||p.y<0||p.y>=height)throw Error('Kiểm tra tọa độ khớp '+p.id);
    if(p.state==='Visible'){const xy=[p.x,p.y].join(',');if(visible.has(xy))throw Error('Hai điểm Visible trùng nhau.');visible.add(xy);}
  }
}
const editableStates=['proposal','review','matched','saved'];
function canReview(row,mode){
  if(!row || row.selected || row.protected || row.saveUnverified || !editableStates.includes(row.state))return false;
  if(mode==='face'){
    if(!row.checkedTwice || row.count!==50)return false;
    return row.savedIds?.length===7 || !!row.keepExisting || (row.state==='matched' && row.existing!=null);
  }
  return row.state==='saved' || row.savedId!=null || (row.state==='matched' && row.existing!=null);
}
function reviewRecord(fields,complete){
  const record={};
  for(const key of ['team_vote','cvat_issue','mentor_decision']){
    record[key]=String(fields?.[key]??'').trim();
    if(complete&&!record[key])throw Error('Điền đủ biểu quyết, Issue/comment và kết luận để hoàn tất review.');
  }
  return record;
}
function saveRows(app){write(path.join(path.dirname(frameDir(0)),'results.json'),app.rows);}
async function applySelected(app,frames){
  if(!app.config||app.running)throw Error('Chờ Studio rảnh và kết nối với CVAT.');
  if(app.rows?.length!==app.config.job.stop_frame-app.config.job.start_frame+1 || app.rows.some(r=>r.state==='error'))throw Error('Cần rà xong toàn bộ job.');
  const selected=app.rows.filter(r=>r.selected && !r.protected && editableStates.includes(r.state));
  if(!selected.length)throw Error('Chưa chọn đề xuất.');
  const confirmed=selectedFrames(frames,app.config.job);
  if(confirmed.length!==selected.length || selected.some(r=>!confirmed.includes(r.frame)))
    throw Error('Danh sách phê duyệt đã đổi. Hãy xác nhận lại các frame.');
  app.running=true;
  let saved=0;
  try{
    await app.navigation?.catch(()=>{});
    for(const row of selected){
      app.current=row.frame;app.status='Đã xác minh '+saved+'/'+selected.length+' · Đang lưu';
      const dir=resultDir(row.frame,row),d=json(path.join(dir,'decision.json')),png=fs.readFileSync(path.join(dir,'input.png'));
      validateDecision(d,row,png.readUInt32BE(16),png.readUInt32BE(20));
      const before=Object.hasOwn(d,'base')?d.base:json(path.join(dir,'before.json'))[0];
      const file=path.join(dir,'save-intent.json');
      if(fs.existsSync(file) && JSON.stringify(json(file).expected)===JSON.stringify(intent(app.config.person,d.points,before))){
        const live=await obtain(app.page,require('./job.cjs').annotations);
        const shapes=live.shapes.filter(s=>s.frame===row.frame && s.label_id===app.config.person.id);
        const id=!hasPersonTrack(live,app.config.person.id,row.frame) && reconcileSave(dir,row.frame,shapes,before);
        if(id){
          Object.assign(row,{state:'saved',id,native:true,selected:false,pending:true,reviewDone:false});saveRows(app);saved++;continue;
        }
      }
      const result=await draw(app,row.frame,dir,{points:d.points},before);
      Object.assign(row,result,{selected:false,pending:true,reviewDone:false});saveRows(app);saved++;
    }
    app.status='Đã lưu và xác minh '+saved+'/'+selected.length+' frame trên CVAT.';
    return app.status;
  }catch(error){
    app.status='Đã xác minh '+saved+'/'+selected.length+' frame. Dừng ở frame '+app.current+'. '+error.message;
    throw Error(app.status);
  }finally{
    app.current=null;app.running=false;
    if(!app.dashboard.isClosed())await app.dashboard.bringToFront().catch(()=>{});
  }
}
async function action(app,type,arg){
  if(type==='open'){await app.openEditor();return;}
  if(!app.rows)app.rows=fs.existsSync(path.join(path.dirname(frameDir(0)),'results.json'))?json(path.join(path.dirname(frameDir(0)),'results.json')):[];
  if(type==='apply')return applySelected(app,arg?.frames);
  const f=arg?.frame;
  if(!Number.isSafeInteger(f)||f<0||(app.config && (f<app.config.job.start_frame||f>app.config.job.stop_frame)))throw Error('Sai frame');
  const row=app.rows.find(r=>r.frame===f);
  if(type==='detail')return detail(app,f);
  if(type==='preview'||type==='navigate'){
    if(app.running || !app.config)throw Error('Chờ CVAT sẵn sàng.');
    const request=Symbol();
    app.requestedNavigation=request;
    const previous=app.navigation||Promise.resolve();
    app.navigation=previous.catch(()=>{}).then(async()=>{
      if(app.requestedNavigation!==request || app.running)return;
      if(type==='preview')await app.page.bringToFront();
      await go(app.page,f,app.config.job,app.mode);
    });
    return app.navigation;
  }
  if(!row)throw Error('Chưa có kết quả cho frame này.');
  if(type==='review'){
    if(app.running)throw Error('Chờ kết thúc lượt xử lý.');
    if(!canReview(row,'pose'))throw Error('Review mở sau khi bản vẽ được xác minh trên CVAT.');
    const record=reviewRecord(arg.fields,arg.complete===true);
    fs.mkdirSync(frameDir(f),{recursive:true});
    write(path.join(frameDir(f),'review.json'),record);
    row.reviewDone=arg.complete===true;row.pending=!row.reviewDone;saveRows(app);return;
  }
  if(type==='choose'||type==='unchoose'){
    if(app.running || !app.config)throw Error('Chờ kết nối và kết thúc lượt xử lý trước khi chọn.');
    if(row.protected||!editableStates.includes(row.state))throw Error('Frame không có đề xuất có thể áp dụng.');
    if(type==='choose'){
      const dir=resultDir(f,row);
      const image=fs.readFileSync(path.join(dir,'input.png'));
      validateDecision(arg,row,image.readUInt32BE(16),image.readUInt32BE(20));
      const base=row.state==='saved'?json(path.join(dir,'verified.json')):json(path.join(dir,'before.json'))[0]||null;
      if(base && require('./native.cjs').matches(base.elements,intent(app.config.person,arg.points,base),f))throw Error('Các điểm đã khớp bản đang lưu.');
      write(path.join(dir,'decision.json'),{points:arg.points,base});
    }
    row.selected=type==='choose';saveRows(app);return;
  }
  throw Error('Thao tác không được hỗ trợ.');
}
module.exports={action,validateDecision,pointsOf,reviewRecord,canReview};
