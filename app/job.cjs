'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const {randomUUID}=require('node:crypto');
const {obtain,runPython,withModelRetry,verifyFrame,hasPersonTrack}=require('./cvat.cjs');
const {profiles}=require('./config.cjs');
const profile=profiles.pose;
const dir=profile?.directory;
const json=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
function write(p,value){
  fs.writeFileSync(p+'.tmp',JSON.stringify(value,null,2),'utf8');
  fs.renameSync(p+'.tmp',p);
}
const annotations=profile && profile.api+'/annotations';
const frameDir=f=>path.join(dir,'frame-'+String(f).padStart(2,'0'));
function resultDir(frame,row){
  if(!row?.revision)return frameDir(frame);
  if(!/^run-[a-f0-9-]{36}$/.test(row.revision))throw Error('Thư mục kết quả frame không hợp lệ.');
  return path.join(frameDir(frame),row.revision);
}
function selectedFrames(input,job){
  if(!job)throw Error('Cần kết nối với job trước.');
  if(!Array.isArray(input)||!input.length||input.some(f=>!Number.isInteger(f)||f<job.start_frame||f>job.stop_frame))
    throw Error('Chọn ít nhất một frame trong phạm vi của job.');
  return [...new Set(input)].sort((a,b)=>a-b);
}
function canonicalShape(shape){
  const copy={...shape};
  if(shape.attributes)copy.attributes=[...shape.attributes].sort((a,b)=>a.spec_id-b.spec_id);
  if(shape.elements)copy.elements=shape.elements.map(canonicalShape).sort((a,b)=>a.id-b.id);
  return copy;
}
function sameShapes(left,right){
  const ordered=shapes=>shapes.map(canonicalShape).sort((a,b)=>a.id-b.id);
  return isDeepStrictEqual(ordered(left),ordered(right));
}
function changes(shape,points,label){
  const pairs=new Map(label.sublabels.map(s=>[Number(s.name),s.id]));
  return points.flatMap(p=>{
    const e=shape.elements?.find(e=>e.label_id===pairs.get(p.id));
    if(!e)return [{id:p.id,message:'Thiếu nhãn con'}];
    const prev=e.outside?'Outside':e.occluded?'Occluded':'Visible';
    const shift=p.state==='Outside'||prev==='Outside'?null:Math.hypot(p.x-e.points[0],p.y-e.points[1]);
    if(prev===p.state && (shift===null || shift<=(prev==='Occluded'?20:5)))return [];
    return [{id:p.id,from:prev,to:p.state,original:e.points,proposed:p.state==='Outside'?null:[p.x,p.y],px:shift===null?null:Math.round(shift)}];
  });
}
async function prepare(app,f,shapes,folder){
  fs.mkdirSync(folder,{recursive:true});
  const {person}=app.config;
  const bytes=await obtain(app.page,profile.api+'/data?type=frame&quality=original&number='+f,true);
  const image=path.join(folder,'frame-original'), labels=path.join(folder,'person.json');
  if(fs.existsSync(image) && (!bytes.equals(fs.readFileSync(image)) || JSON.stringify(json(labels))!==JSON.stringify(person)))throw Error('Ảnh hoặc cấu hình nhãn đã đổi.');
  write(labels,person);fs.writeFileSync(image,bytes);
  write(path.join(folder,'frame.json'),{job:profile.job,task:profile.task,frame:f});
  const backup=path.join(folder,'before.json');
  if(fs.existsSync(backup) && !sameShapes(json(backup),shapes))throw Error('Annotation đã đổi từ lần kiểm tra trước.');
  if(!fs.existsSync(backup))write(backup,shapes);
  const prediction=path.join(folder,'prediction.json');
  if(!fs.existsSync(prediction)){
    const finished=await withModelRetry(app,folder,f,async()=>{
      const args=[folder,'--frame',String(f)];
      if(fs.existsSync(path.join(folder,'first-pass.json')) && !fs.existsSync(path.join(folder,'model-review.json')))args.push('--resume-first');
      await runPython(args);
    });
    if(!finished)return null;
  }
  const predicted=json(prediction);
  return {folder,predicted,pending:predicted.needs_review};
}
async function scan(app,requested=null){
  if(app.running||!app.config)throw Error('Chờ Studio rảnh và kết nối với CVAT.');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'results.json');
  app.rows=fs.existsSync(file)?json(file):[];
  const {job,meta,person}=app.config;
  const fresh=requested!==null;
  const frames=fresh?selectedFrames(requested,job):Array.from({length:job.stop_frame-job.start_frame+1},(_,i)=>job.start_frame+i)
    .filter(f=>needsDrawing(app.rows.find(r=>r.frame===f)));
  const revision=fresh?'run-'+randomUUID():null;
  const report=app.scanReport={total:frames.length,finished:0,errors:[],unselected:[]};
  if(!frames.length){app.status='Đã rà toàn job. Tích frame để chạy lại AI.';return;}
  app.running=true;app.paused=false;app.status='Đang chuẩn bị '+frames.length+' frame';
  try{
    await app.navigation?.catch(()=>{});
    for(const [index,f] of frames.entries()){
      if(app.paused)break;
      const previous=app.rows.find(r=>r.frame===f);
      app.current=f;app.status='Đang xét 17 khớp';
      let row={frame:f,state:'error'};
      if(revision||previous?.revision)row.revision=revision||previous.revision;
      const folder=resultDir(f,row);
      let attemptedSave=false;
      try{
        if(meta.deleted_frames?.includes(f)||(meta.included_frames&&!meta.included_frames.includes(f))) row.state='unavailable';
        else{
          verifyFrame(job,meta,f);
          const snapshot=await obtain(app.page,annotations);
          const initial=snapshot.shapes.filter(s=>s.label_id===person.id && s.frame===f);
          const protectedInitially=initial.length>1 || hasPersonTrack(snapshot,person.id,f);
          const backup=path.join(folder,'before.json');
          if(!fresh && !protectedInitially && fs.existsSync(backup)){
            const id=require('./native.cjs').reconcileSave(folder,f,initial,json(backup)[0]);
            if(id){
              const predicted=json(path.join(folder,'prediction.json'));
              row={...previous,frame:f,state:'saved',id,native:true,count:17,pending:previous?.pending??predicted.needs_review,note:predicted.review_note};
              app.rows=app.rows.filter(r=>r.frame!==f).concat(row).sort((a,b)=>a.frame-b.frame);
              write(file,app.rows);report.finished++;continue;
            }
          }
          const prepared=protectedInitially?null:await prepare(app,f,initial,folder);
          if(!protectedInitially && !prepared){
            report.interrupted=f;report.deferred=frames.slice(index+1);
            break;
          }
          const live=await obtain(app.page,annotations);
          const shapes=live.shapes.filter(s=>s.label_id===person.id&&s.frame===f);
          if(hasPersonTrack(live,person.id,f)||shapes.length>1){
            fs.mkdirSync(folder,{recursive:true});
            const backup=path.join(folder,'protected-original.json');
            if(!fs.existsSync(backup))write(backup,{shapes,tracks:live.tracks.filter(t=>t.label_id===person.id&&t.frame<=f)});
            row.state='review';row.protected=true;row.note='Kiểm tra track hoặc nhiều skeleton trong CVAT.';
          }
          else {
            if(!prepared)throw Error('Annotation đã thay đổi trong lúc rà.');
            if(!sameShapes(shapes,initial))throw Error('Nhãn gốc đã thay đổi trong lúc suy luận.');
            const {predicted,pending}=prepared;
            row.note=predicted.review_note;row.count=predicted.points.length;row.existing=shapes[0]?.id;
            row.pending=pending;
            if(shapes.length){
              row.changes=changes(shapes[0],predicted.points,person);
              row.state=!predicted.driver_present?'review':row.changes.length?'proposal':pending?'review':'matched';
              if(shapes[0].id===(previous?.savedId??previous?.id))row.savedId=shapes[0].id;
              if(fresh && previous?.selected && predicted.driver_present){
                const decision=json(path.join(resultDir(f,previous),'decision.json'));
                if(decision.base && sameShapes([decision.base],shapes)){
                  write(path.join(folder,'decision.json'),decision);
                  row.selected=true;
                }
              }
            }else if(!predicted.driver_present){row.state=pending?'review':'no_driver';}
            else{
              app.status='Draw skeleton trên CVAT';

              try{
                attemptedSave=true;
                Object.assign(row,await require('./native.cjs').draw(app,f,folder,predicted));
              }catch(e){
                await app.page.screenshot({path:path.join(folder,'ui-error.png')}).catch(()=>{});
                app.paused=true;
                throw e;
              }
            }
          }
        }
        if(fresh && previous?.selected && !row.selected)report.unselected.push(f);
      }catch(e){
        row.state='error';row.note=e.message;report.errors.push({frame:f,message:e.message});
        if(fresh && previous && !attemptedSave)row=previous;
        if(['RATE_LIMIT','AUTH_REQUIRED','QUOTA_EXHAUSTED'].includes(e.modelCode)){
          report.deferred=frames.slice(index+1);
          if(previous && previous.state!=='error')row=previous;
          app.status='Đã dừng ở frame '+String(f).padStart(2,'0')+' · '+e.message;
        }
        console.error('Frame',f,e.message);
      }
      app.rows=app.rows.filter(r=>r.frame!==f).concat(row).sort((a,b)=>a.frame-b.frame);
      write(file,app.rows);
      console.log('FRAME_RESULT',f,row.state);
      report.finished++;
      if(report.deferred)return;
    }
    app.status=app.paused?'Đã tạm dừng':report.errors.length?'Có frame cần thử lại':fresh?'Đã chạy xong '+report.finished+' frame đã tích':'Đã rà toàn job';
  }finally{
    app.current=null;app.running=false;
    if(!app.dashboard.isClosed())await app.dashboard.bringToFront().catch(()=>{});
  }
}
function needsDrawing(row){
  return !row || ['error','drawing'].includes(row.state) ||
    (row.state==='review' && row.native && !row.existing && !row.selected && !row.protected);
}
async function dispatch(app,action,arg){
  if(action==='start'||action==='startSelected'){
    if(app.running||!app.config)throw Error('Chờ Studio rảnh và kết nối với CVAT.');
    const requested=action==='startSelected'?selectedFrames(arg?.frames,app.config.job):null;
    scan(app,requested).catch(e=>{app.status=e.message;console.error(e.message);});
    return;
  }
  if(action==='pause'){app.paused=true;app.retryWait?.abort();return;}
  if(action==='state'){
    const rows=app.rows??(fs.existsSync(path.join(dir,'results.json'))?json(path.join(dir,'results.json')):[]);
    return {frameSelection:true,status:app.status,running:app.running,connected:!!app.config,current:app.current,scanReport:app.scanReport,
      rows,reviewFrames:rows.filter(r=>require('./review.cjs').canReview(r,'pose')).map(r=>r.frame)};
  }
  return require('./review.cjs').action(app,action,arg);
}
module.exports={scan,dispatch,changes,frameDir,resultDir,selectedFrames,json,write,annotations,needsDrawing,sameShapes};
