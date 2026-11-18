'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const groups=require('./face50.json');
const {obtain,hasPersonTrack}=require('./cvat.cjs');
const {json,write,sameShapes}=require('./job.cjs');
const {pointsOf}=require('./review.cjs');
const {go,intent,matches,allowedRequest,preservesOriginal,hasManualSource,selectNative,editShape,createShape}=require('./native.cjs');

const profile=require('./config.cjs').profiles.face;
const api=profile && profile.api+'/annotations';
function faceLabels(labels){
  const used=new Set();
  return groups.map(g=>{
    const found=labels.filter(l=>l.name===g.name && l.type==='skeleton');
    const label=found[0];
    const children=[...(label?.sublabels||[])].sort((a,b)=>Number(a.name)-Number(b.name));
    if(found.length!==1 || children.length!==g.count || children.some((s,i)=>s.name!==String(g.first+i)||s.type!=='points'||used.has(s.id)))
      throw Error('Cấu hình CVAT không khớp '+g.name+' ('+g.first+'–'+(g.first+g.count-1)+').');
    children.forEach(s=>used.add(s.id));
    if(new Set(children.map(s=>s.id)).size!==g.count)throw Error('Trùng ID sublabel trong '+g.name);
    return {...label,sublabels:children};
  });
}
function frameShapes(data,frame,labels){
  const shapes=data.shapes.filter(s=>s.frame===frame && labels.some(l=>l.id===s.label_id));
  for(const label of labels){
    const found=shapes.filter(s=>s.label_id===label.id);
    if(hasPersonTrack(data,label.id,frame)||found.length>1)throw Error('Cần review track hoặc nhãn trùng '+label.name+'.');
    if(found.length && (found[0].type!=='skeleton'||!label.sublabels.every(s=>found[0].elements?.filter(e=>e.label_id===s.id && e.frame===frame).length===1)||found[0].elements.length!==label.sublabels.length))
      throw Error('Cần review cấu trúc pre-label '+label.name+'.');
  }
  return shapes;
}
function flatten(shapes,labels){
  return labels.flatMap(l=>pointsOf(shapes.find(s=>s.label_id===l.id),l));
}
async function saveFace(app,frame,folder,points,base){
  const {page,config:{labels,job}}=app;
  const read=async()=>frameShapes(await obtain(page,api,false,'face'),frame,labels);
  const receiptFile=path.join(folder,'face-save-intent.json');
  const plan=labels.map((l,i)=>intent(l,points.slice(groups[i].first,groups[i].first+groups[i].count),base.find(s=>s.label_id===l.id)));
  const receipt={job:job.id,frame,base,plan};
  const resume=fs.existsSync(receiptFile) && isDeepStrictEqual(json(receiptFile),receipt);
  let live=await read();
  if(!resume && !sameShapes(live,base))throw Error('Pre-label Face đã đổi. Chạy lại frame để đối chiếu.');
  function stateOf(all,i,mayHaveSaved){
    const id=labels[i].id,old=base.find(s=>s.label_id===id),now=all.find(s=>s.label_id===id);
    const original=sameShapes(old?[old]:[],now?[now]:[]);
    if(now && !old && mayHaveSaved && !hasManualSource(now))
      throw Error('CVAT chưa xác nhận nguồn MANUAL cho skeleton mới '+labels[i].name+'. Kiểm tra đối tượng trên frame '+frame+'.');
    const done=now && matches(now.elements,plan[i],frame) && (!old||preservesOriginal(now,old));
    if(!original && !(mayHaveSaved && done))throw Error('Pre-label '+labels[i].name+' đã đổi. Cần rà lại.');
    return done?'done':'pending';
  }
  labels.forEach((_,i)=>stateOf(live,i,resume));
  await go(page,frame,job,'face');
  await page.bringToFront();
  write(receiptFile,receipt);
  for(const [i,label] of labels.entries()){
    live=await read();
    if(stateOf(live,i,true)==='done')continue;
    const old=base.find(s=>s.label_id===label.id);
    if(old){
      const current=await selectNative(page,frame,label.id,old.id,true);
      if(!matches(current,intent(label,pointsOf(old,label),old),frame))throw Error('Canvas khác bản gốc của '+label.name+'.');
      await editShape(page,plan[i],old,true);
    }else await createShape(page,plan[i],label.name);
    const draft=await selectNative(page,frame,label.id,old?.id??null,true);
    if(!matches(draft,plan[i],frame))throw Error('Bản vẽ chưa khớp '+label.name+'.');
    if(!sameShapes(await read(),live))throw Error('Annotation Face đã đổi trong lúc vẽ.');
    app.status='Đang lưu '+label.name;
    app.permitWrite=req=>allowedRequest(req,old?'update':'create',frame,label.id,plan[i],old,profile);
    try{
      const [response]=await Promise.all([
        page.waitForResponse(r=>r.request().method()==='PATCH' && new URL(r.url()).pathname.replace(/\/$/,'')===api,{timeout:20000}),
        page.keyboard.press('Control+s')
      ]);
      if(!response.ok()||stateOf(await read(),i,true)!=='done')throw Error('Chưa xác minh được Save của '+label.name+'.');
    }finally{app.permitWrite=null;}
  }
  live=await read();
  if(!labels.every((_,i)=>stateOf(live,i,true)==='done'))throw Error('Chưa đủ bảy contour sau Save.');
  write(path.join(folder,'verified.json'),live);
  await page.screenshot({path:path.join(folder,'native.png')}).catch(()=>{});
  return live.map(s=>s.id);
}
module.exports={groups,api,faceLabels,frameShapes,flatten,saveFace};
