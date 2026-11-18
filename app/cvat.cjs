'use strict';
const fs=require('node:fs');
const path=require('node:path');
const timers=require('node:timers/promises');
const {spawn}=require('node:child_process');
const {profiles,modelEnvironment}=require('./config.cjs');
const target=(frame,mode='pose')=>profiles[mode].jobURL+(Number.isSafeInteger(frame)?'?frame='+frame:'');
function findPlaywright(){return require('playwright');}
function isJob(raw,mode='pose'){
  try{
    const url=new URL(raw);
    return profiles[mode]?.jobURL===url.origin+url.pathname.replace(/\/$/,'');
  }catch{return false;}
}
function isJobLogin(raw,mode='pose'){
  try{
    const url=new URL(raw);
    const next=url.searchParams.get('next');
    return url.origin===profiles[mode]?.origin && /^\/auth\/login\/?$/.test(url.pathname) && !!next && isJob(new URL(next,url.origin),mode);
  }catch{return false;}
}
function runPython(args,script='pose.py') {
  return new Promise((resolve, reject) => {
    const agent = script === 'face.py' ? 'Face' : 'Pose';
    const child = spawn(process.env.LANDMARK_PYTHON || 'python', ['-X','utf8','-B',path.join(__dirname,script),...args], {
      stdio:['inherit','inherit','pipe'], windowsHide:true, env:{...process.env,...modelEnvironment()},
    });
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-4096);
    });
    child.once('error', reject);
    child.once('close', (n, signal) => {
      if(n===0) return resolve();
      const last = tail.trimEnd().split(/\r?\n/).pop() || '';
      const detail = /^(?:[\w.]+Error|PendingReview): /.test(last) ? last.slice(0,400) : '';
      const error = Error(agent + ' · ' + (detail || (signal ? 'Dừng bởi '+signal : 'Python kết thúc với mã '+n)));
      error.modelCode = /^ModelError: \[([A-Z_]+)\]/.exec(last)?.[1];
      reject(error);
    });
  });
}
const retryDelays=[30,60];
async function waitForModel(app,frame,attempt){
  const remaining=app.modelRetryAt-Date.now();
  if(remaining>15*60*1000){
    throw Object.assign(Error('AI yêu cầu chờ thêm '+Math.ceil(remaining/1000)+' giây trước khi gửi yêu cầu.'),
      {modelCode:'RATE_LIMIT'});
  }
  if(remaining>0){
    const controller=new AbortController();
    app.retryWait=controller;
    app.scanReport.retry={frame,attempt,max:retryDelays.length,at:app.modelRetryAt};
    app.status='AI giới hạn tần suất · Đang chờ';
    try{
      await timers.setTimeout(remaining,undefined,{signal:controller.signal});
    }catch(e){
      if(!controller.signal.aborted)throw e;
      return false;
    }finally{
      delete app.scanReport.retry;
      delete app.retryWait;
    }
  }
  if(app.paused || !app.config)return false;
  delete app.modelRetryAt;
  return true;
}
async function withModelRetry(app,dir,frame,run){
  for(let attempt=0;;attempt++){
    if(app.modelRetryAt){
      if(!await waitForModel(app,frame,attempt))return false;
      app.status='AI đang rà frame '+String(frame).padStart(2,'0');
    }
    try{
      await run(attempt);
      return true;
    }catch(error){
      if(error.modelCode!=='RATE_LIMIT')throw error;
      const file=path.join(dir,'agent-error.json');
      const hint=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).retryAfterSeconds:null;
      const seconds=Math.max(retryDelays[Math.min(attempt,retryDelays.length-1)],Number.isFinite(hint)?hint:0);
      app.modelRetryAt=Date.now()+seconds*1000;
      if(app.paused)return false;
      if(attempt===retryDelays.length || hint>15*60){
        if(attempt===retryDelays.length)error.message+=' Đã thử lại '+attempt+' lần.';
        if(hint>0)error.message+=' Dịch vụ yêu cầu chờ ít nhất '+hint+' giây.';
        throw error;
      }
    }
  }
}
async function obtain(page, api, binary = false, mode='pose') {
  if(!isJob(page.url(),mode) || !api.startsWith('/api/'))throw Error('Editor chưa kết nối đúng job CVAT.');
  const {origin}=profiles[mode];
  const r = await page.request.get(origin + api, {maxRedirects:0,timeout:30000});
  if (!r.ok()) throw Error(api.split('?')[0]+' returned HTTP '+r.status());
  try { return binary ? await r.body() : await r.json(); } finally {await r.dispose();}
}
async function allLabels(page,id,origin,mode) {
  let api='/api/labels?job_id='+id+'&page_size=100';
  const labels=[];
  while (api) {
    const result = await obtain(page, api, false, mode);
    labels.push(...result.results);
    if (!result.next) break;
    const next = new URL(result.next,origin);
    if (next.origin!==origin || !['/api/labels','/api/labels/'].includes(next.pathname)) throw Error('Unexpected pagination URL');
    api=next.pathname+next.search;
  }
  return labels;
}
function hasPersonTrack(data, personId, frame) {
  return data.tracks.some(t=>t.label_id===personId && t.frame<=frame);
}
function verifyFrame(job, meta, frame) {
  if(job.id!==profiles.pose?.job || job.task_id!==profiles.pose?.task || !Number.isInteger(frame) || frame>job.stop_frame || job.start_frame>frame ||
     meta.deleted_frames?.includes(frame) || (meta.included_frames && !meta.included_frames.includes(frame))) throw Error('Frame không thuộc job Pose đã cấu hình.');
}
async function openJob({page},frame,mode='pose'){
  const profile=profiles[mode], jobPath='/api/jobs/'+profile.job;
  if(!isJob(page.url(),mode) && !isJobLogin(page.url(),mode))await page.goto(target(frame,mode),{waitUntil:'domcontentloaded'});
  await page.locator('.cvat-draw-skeleton-control').waitFor({state:'visible',timeout:600000});
  if(!isJob(page.url(),mode))throw Error('Tab CVAT chưa mở đúng job đã chọn.');
  const [job,meta,labels]=await Promise.all([obtain(page,jobPath,false,mode),obtain(page,jobPath+'/data/meta',false,mode),allLabels(page,profile.job,profile.origin,mode)]);
  if(job.id!==profile.job || job.task_id!==profile.task || (!Number.isSafeInteger(job.start_frame) || !Number.isSafeInteger(job.stop_frame) || job.start_frame<0 || job.stop_frame<job.start_frame))throw Error('Sai cấu hình job CVAT.');
  if(mode==='face')return {job,meta,labels:require('./face-native.cjs').faceLabels(labels)};
  const people=labels.filter(l=>['person','person_vf17'].includes(l.name) && l.type==='skeleton');
  if(people.length!==1 || people[0].sublabels?.length!==17 || !Array.from({length:17},(_,i)=>String(i+1)).every(id=>people[0].sublabels.some(s=>s.type==='points' && s.name===id)))throw Error('Cần một nhãn person với 17 khớp.');
  return {job,meta,person:people[0]};
}
module.exports={profiles,findPlaywright,openJob,target,isJob,isJobLogin,obtain,runPython,withModelRetry,hasPersonTrack,verifyFrame};
