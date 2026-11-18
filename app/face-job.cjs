'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {groups,api,frameShapes,flatten,saveFace}=require('./face-native.cjs');
const {validate,topology,suggest}=require('./face-qc.cjs');
const {json,write,sameShapes,changes,selectedFrames}=require('./job.cjs');
const {obtain,runPython,withModelRetry}=require('./cvat.cjs');
const review=require('./review.cjs');
const root=require('./config.cjs').profiles.face.directory,results=path.join(root,'results.json');
const frameDir=f=>path.join(root,'frame-'+String(f).padStart(2,'0'));
function folder(row){
  if(!/^run-[0-9a-f-]{36}$/.test(row.revision))throw Error('Thiếu thư mục kết quả Face.');
  return path.join(frameDir(row.frame),row.revision);
}
const image=file=>'data:image/png;base64,'+fs.readFileSync(file).toString('base64');
function put(app,row){
  fs.mkdirSync(root,{recursive:true});
  const rows=app.rows.filter(r=>r.frame!==row.frame).concat(row).sort((a,b)=>a.frame-b.frame);
  write(results,rows);
  app.rows=rows;
}
function complete(app){
  const job=app.config?.job;
  return job && Array.from({length:job.stop_frame-job.start_frame+1},(_,i)=>i+job.start_frame)
    .every(f=>app.rows.some(r=>r.frame===f && (r.checkedTwice||r.state==='unavailable') && r.state!=='error'));
}
function detail(app,row){
  const record=path.join(frameDir(row.frame),'review.json');
  const notes=fs.existsSync(record)?json(record):{};
  if(!row.checkedTwice||row.protected)return {review:notes};
  const dir=folder(row),prediction=json(path.join(dir,'prediction.json'));
  const labels=json(path.join(dir,'labels.json'));
  const base=json(path.join(dir,row.state==='saved'?'verified.json':'before.json'));
  const old=flatten(base,labels);
  const changed=new Set(row.changes?.map(c=>c.id));
  const points=row.state==='saved'?old:prediction.points.map(p=>changed.has(p.id)?p:(old.find(o=>o.id===p.id)||p));
  const decision=row.selected?json(path.join(dir,'decision.json')):null;
  const planned=decision?.points||points;
  return {prediction,old,points,review:notes,decision,geometryIssues:planned.length===50?topology(planned):[],
    original:image(path.join(dir,'input.png')),image:image(path.join(dir,'overlay.png')),
    native:row.state==='saved' && fs.existsSync(path.join(dir,'native.png'))?image(path.join(dir,'native.png')):null};
}
function decisionPoints(row,points){
  const png=fs.readFileSync(path.join(folder(row),'input.png'));
  return validate(points,png.readUInt32BE(16),png.readUInt32BE(20));
}
function checkedGeometry(row,points){
  const sorted=decisionPoints(row,points),issues=topology(sorted);
  if(issues.length)throw Error('Frame '+String(row.frame).padStart(2,'0')+' · '+issues.join(' '));
  return sorted;
}
async function inspectFrame(app,frame,previous){
  const {page,config:{job,meta,labels}}=app;
  if(meta.deleted_frames?.includes(frame)||(meta.included_frames&&!meta.included_frames.includes(frame)))return {frame,state:'unavailable'};
  const row={frame,revision:'run-'+randomUUID()},dir=folder(row);
  fs.mkdirSync(dir,{recursive:true});
  const snapshot=await obtain(page,api,false,'face');
  let base;
  try{base=frameShapes(snapshot,frame,labels);}catch(e){row.protected=true;row.note=e.message;}
  const bytes=await obtain(page,'/api/jobs/'+job.id+'/data?type=frame&quality=original&number='+frame,true,'face');
  fs.writeFileSync(path.join(dir,'frame-original'),bytes);
  write(path.join(dir,'labels.json'),labels);
  const finished=await withModelRetry(app,dir,frame,attempt=>runPython(attempt?[dir,'--resume-first']:[dir],'face.py'));
  if(!finished)return null;
  const prediction=json(path.join(dir,'prediction.json'));
  const png=fs.readFileSync(path.join(dir,'input.png'));
  const points=prediction.driver_present?validate(prediction.points,png.readUInt32BE(16),png.readUInt32BE(20)):[];
  const issues=points.length?topology(points):[];
  row.checkedTwice=true;
  row.count=points.length;
  row.pending=!!(prediction.needs_review||issues.length||row.protected);
  row.note=[row.note,prediction.review_note,...issues].filter(Boolean).join(' ');
  if(row.protected)return {...row,state:'review'};
  const current=frameShapes(await obtain(page,api,false,'face'),frame,labels);
  if(!sameShapes(current,base))throw Error('Annotation Face đã đổi trong lúc suy luận. Chạy lại frame.');
  write(path.join(dir,'before.json'),base);
  if(!points.length)return {...row,state:base.length||row.pending?'review':'no_driver',protected:!!base.length,
    pending:row.pending||!!base.length,note:base.length?'UNCERTAIN_SCOPE · AI không thấy mặt người lái nhưng có pre-label. '+row.note:row.note};
  row.existing=base.length?base[0].id:null;
  row.changes=labels.flatMap((label,i)=>{
    const pts=points.slice(groups[i].first,groups[i].first+groups[i].count),shape=base.find(s=>s.label_id===label.id);
    return shape?changes(shape,pts,label):pts.map(p=>({id:p.id,message:'Thiếu '+label.name}));
  });
  row.state=!base.length?(row.pending?'review':'ready'):row.changes.length?'proposal':row.pending?'review':'matched';
  if(previous?.selected){
    const decision=json(path.join(folder(previous),'decision.json'));
    if(sameShapes(decision.base,base)){
      write(path.join(dir,'decision.json'),decision);row.selected=true;
      if(topology(decision.points).length)row.pending=true;
    }
  }
  if(previous && (previous.savedIds?.length===groups.length || previous.keepExisting || previous.reviewDone)){
    const priorFile=path.join(folder(previous),previous.state==='saved'?'verified.json':'before.json');
    if(base.length===groups.length && fs.existsSync(priorFile) && sameShapes(json(priorFile),base)){
      if(previous.savedIds){row.savedIds=previous.savedIds;row.savedId=previous.savedIds[0];}
      if(previous.keepExisting)row.keepExisting=true;
      if(previous.reviewDone)row.reviewDone=true;
    }
  }
  return row;
}
async function saveRow(app,row,approved){
  const dir=folder(row);
  if(row.protected||!row.checkedTwice||!complete(app))throw Error('Cần rà hai lượt toàn job trước khi lưu Face.');
  const decision=approved?json(path.join(dir,'decision.json')):{points:json(path.join(dir,'prediction.json')).points,base:[]};
  if(!approved && (row.state!=='ready'||json(path.join(dir,'before.json')).length))throw Error('Pre-label Face cần phê duyệt.');
  const points=checkedGeometry(row,decision.points);
  put(app,{...row,saveUnverified:true});
  const savedIds=await saveFace(app,row.frame,dir,points,decision.base);
  put(app,{...row,state:'saved',savedId:savedIds[0],savedIds,selected:false,saveUnverified:false,reviewDone:false});
}
async function scan(app,requested){
  const {job}=app.config;
  const all=Array.from({length:job.stop_frame-job.start_frame+1},(_,i)=>job.start_frame+i);
  const frames=requested||all.filter(f=>!app.rows.some(r=>r.frame===f && (r.checkedTwice||r.state==='unavailable')));
  app.running=true;app.paused=false;
  const report=app.scanReport={total:frames.length,finished:0,errors:[],unselected:[]};
  try{
    await app.navigation?.catch(()=>{});
    for(const f of frames){
      if(app.paused)break;
      app.current=f;app.status='AI đang rà hai lượt 50 điểm Face';
      const previous=app.rows.find(r=>r.frame===f);
      try{
        const row=await inspectFrame(app,f,previous);
        if(!row){
          report.interrupted=f;
          report.deferred=frames.slice(report.finished+1);
          break;
        }
        put(app,row);
        if(previous?.selected&&!row.selected)report.unselected.push(f);
      }catch(e){
        report.errors.push({frame:f,message:e.message});
        if(!previous?.checkedTwice)put(app,{frame:f,state:'error',note:e.message});
        if(['RATE_LIMIT','QUOTA_EXHAUSTED','AUTH_REQUIRED'].includes(e.modelCode)){
          report.finished++;
          report.deferred=frames.slice(report.finished);
          app.status=e.modelCode==='RATE_LIMIT'?'Đã dừng ở frame '+String(f).padStart(2,'0')+' do AI vẫn giới hạn tần suất.':
            e.modelCode==='AUTH_REQUIRED'?'Kiểm tra API key trong .env rồi thử lại.':'Chờ tài khoản có lại hạn mức AI.';
          return;
        }
      }
      report.finished++;
    }
    if(complete(app) && !report.errors.length){
      const ready=app.rows.filter(r=>r.state==='ready' && !r.selected && (!requested||requested.includes(r.frame)));
      for(const row of ready){
        if(app.paused)break;
        app.current=row.frame;
        try{await saveRow(app,row,false);}
        catch(e){report.errors.push({frame:row.frame,message:e.message});break;}
      }
    }
    app.status=app.paused?'Đã tạm dừng':report.errors.length?'Có frame Face cần thử lại':complete(app)?'Đã rà hai lượt toàn job Face':'Đã rà '+report.finished+' frame. Rà đủ toàn job trước khi lưu Face.';
  }finally{app.current=null;app.running=false;if(!app.dashboard.isClosed())await app.dashboard.bringToFront().catch(()=>{});}
}
async function dispatch(app,action,arg){
  app.rows??=fs.existsSync(results)?json(results):[];
  if(action==='state')return {frameSelection:true,mode:'face',status:app.status,running:app.running,connected:!!app.config,
    current:app.current,rows:app.rows,reviewFrames:app.rows.filter(r=>review.canReview(r,'face')).map(r=>r.frame),
    scanReport:app.scanReport,groups,first:app.config?.job.start_frame??0,last:app.config?.job.stop_frame??-1};
  if(action==='open')return app.openEditor();
  if(action==='pause'){app.paused=true;app.retryWait?.abort();return;}
  if(action==='detail'){
    const row=app.rows.find(r=>r.frame===arg.frame);
    return row?detail(app,row):{};
  }
  if(app.running||!app.config)throw Error('Chờ Studio rảnh và kết nối đúng job Face.');
  if(action==='start'||action==='startSelected'){
    const frames=action==='startSelected'?selectedFrames(arg?.frames,app.config.job):null;
    scan(app,frames).catch(e=>{app.status=e.message;});return;
  }
  if(action==='apply'){
    const chosen=app.rows.filter(r=>r.selected),frames=selectedFrames(arg?.frames,app.config.job);
    if(!complete(app)||frames.length!==chosen.length||chosen.some(r=>!frames.includes(r.frame)))throw Error('Rà đủ job và xác nhận lại danh sách Face.');
    for(const row of chosen)checkedGeometry(row,json(path.join(folder(row),'decision.json')).points);
    app.running=true;let done=0;
    try{
      await app.navigation?.catch(()=>{});
      for(const row of chosen){app.current=row.frame;await saveRow(app,row,true);done++;}
      return app.status='Đã lưu và xác minh '+done+'/'+chosen.length+' frame Face trên CVAT. Mở tab Review để đánh giá bản đã lưu.';
    }catch(e){app.status='Đã xác minh '+done+'/'+chosen.length+' frame. Dừng ở frame '+app.current+'. '+e.message;throw Error(app.status);}
    finally{app.running=false;app.current=null;if(!app.dashboard.isClosed())await app.dashboard.bringToFront().catch(()=>{});}
  }
  if(['preview','navigate'].includes(action))return review.action(app,action,arg);
  const row=app.rows.find(r=>r.frame===arg?.frame);
  if(!row)throw Error('Chưa rà frame Face.');
  if(action==='review'){
    if(!review.canReview(row,'face'))throw Error('Review mở sau khi đủ bảy nhóm điểm được xác minh trên CVAT.');
    const record=review.reviewRecord(arg.fields,arg.complete===true);
    fs.mkdirSync(frameDir(row.frame),{recursive:true});write(path.join(frameDir(row.frame),'review.json'),record);
    put(app,{...row,reviewDone:arg.complete===true});return;
  }
  if(action==='unchoose'){put(app,{...row,selected:false});return;}
  if(['choose','suggestGeometry'].includes(action) && row.checkedTwice && !row.protected && row.count===50){
    const dir=folder(row),base=json(path.join(dir,row.state==='saved'?'verified.json':'before.json'));
    const points=decisionPoints(row,arg.points);
    const old=flatten(base,app.config.labels);
    const issues=topology(points);
    if(action==='suggestGeometry'){
      const predicted=json(path.join(dir,'prediction.json')).points;
      return {issues,edits:issues.length?suggest(points,predicted,old):null};
    }
    const coincides=list=>list.length===50 && list.every(p=>{
      const q=points[p.id];
      return q.state===p.state && (p.state==='Outside'||(p.x===q.x && p.y===q.y));
    });
    if(!issues.length && coincides(old)){
      if(row.saveUnverified)throw Error('Lần lưu trước chưa xác minh đủ bảy nhóm. Thử lại lựa chọn đã xác nhận hoặc rà lại frame để đối chiếu CVAT.');
      put(app,{...row,selected:false,keepExisting:true});
      return {unchanged:true,issues};
    }
    write(path.join(dir,'decision.json'),{base,points});
    const updated={...row,selected:true};
    if(issues.length)updated.pending=true;
    put(app,updated);
    return {issues};
  }
  throw Error('Thao tác không áp dụng cho frame Face này.');
}
module.exports={dispatch,scan,complete};
