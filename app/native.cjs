'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {target,obtain,hasPersonTrack}=require('./cvat.cjs');
const {json,write,sameShapes,annotations}=require('./job.cjs');
const frameInput='.cvat-player-frame-selector input, input.cvat-player-frame-selector, .cvat-annotation-header input.ant-input-number-input';
const items='.cvat-objects-sidebar-state-item';
const groups='.cvat_canvas_shape_skeleton';
const background='#cvat_canvas_background';
const {profiles}=require('./config.cjs');
const endpoint=annotations;

async function go(page,frame,job,mode='pose'){
  if(job?.id!==profiles[mode]?.job || job?.task_id!==profiles[mode]?.task)throw Error('Job khác cấu hình.');
  if(!Number.isInteger(frame)||frame<job.start_frame||frame>job.stop_frame)throw Error('Frame không thuộc job đang mở.');
  if(page.url()==='about:blank')await page.goto(target(frame,mode),{waitUntil:'domcontentloaded'});
  const url=new URL(page.url());
  if(url.origin!==profiles[mode].origin||url.pathname.replace(/\/$/,'')!==new URL(target(frame,mode)).pathname)throw Error('Tab CVAT đã rời job đang xử lý.');
  const input=page.locator(frameInput).first();
  await page.locator(background).waitFor({state:'visible',timeout:45000});
  if(await input.inputValue()!==String(frame)){
    const filename=await page.locator('.cvat-player-filename-wrapper').innerText();
    await input.fill(String(frame));await input.press('Enter');await input.evaluate(el=>el.blur());
    await page.waitForFunction(({filename,frame,frameInput})=>
      document.querySelector(frameInput)?.value===String(frame) &&
      document.querySelector('.cvat-player-filename-wrapper')?.innerText.trim()!==filename.trim(),
      {filename,frame,frameInput},{timeout:15000});
  }
  await page.locator(background).waitFor({state:'visible'});
}

async function parts(page,item){
  const collapse=item.getByRole('button',{name:/\bparts\b/i});
  if(await collapse.getAttribute('aria-expanded')!=='true')await collapse.click();
  await item.locator('[id^="cvat-objects-sidebar-state-item-element-"]').first().waitFor();
  return item.evaluate(root=>{
    const img=document.querySelector('#cvat_canvas_background'), box=img.getBoundingClientRect();
    const transform=new DOMMatrix(getComputedStyle(img).transform);
    if(transform.a<=0||transform.d<=0||Math.abs(transform.b)+Math.abs(transform.c)>0.0001)throw Error('Đặt góc xoay canvas về 0°.');
    return [...root.querySelectorAll('[id^="cvat-objects-sidebar-state-item-element-"]')].map(row=>{
      const client=row.id.split('-').at(-1), circle=document.getElementById('cvat_canvas_shape_'+client);
      const id=Number(row.innerText.trim().match(/^(\d+)\s+\[POINTS\]/i)?.[1]);
      const outside=!!row.querySelector('.cvat-object-item-button-outside-enabled');
      const occluded=!!row.querySelector('.cvat-object-item-button-occluded-enabled');
      if(!circle || !id)throw Error('Không nhận được đủ các điểm trong mục Parts.');
      const center=new DOMPoint(circle.cx.baseVal.value,circle.cy.baseVal.value).matrixTransform(circle.getScreenCTM());
      const coord=(v)=>Math.round(v*1000)/1000;
      return {id,client,label:Number(circle.dataset.labelId),occluded,state:outside?'Outside':occluded?'Occluded':'Visible',
        x:outside?null:coord((center.x-box.left)*img.width/box.width),y:outside?null:coord((center.y-box.top)*img.height/box.height)};
    }).sort((a,b)=>a.id-b.id);
  });
}
async function snapshot(page,frame,config){
  await go(page,frame,config.job);
  const info=await page.locator(background).evaluate(img=>({width:img.width,height:img.height}));
  const list=page.locator(items),count=await list.count();
  if(!count){
    if(await page.locator(groups).count())throw Error('Danh sách Objects và canvas chưa đồng bộ.');
    return {...info,points:[],empty:true};
  }
  const item=list.first();
  if(count!==1||!(await item.innerText()).includes('SKELETON SHAPE')||!(await item.innerText()).includes(config.person.name)||await page.locator(groups).count()!==1)
    return {...info,protected:true,points:[]};
  const points=await parts(page,item);
  if(points.length!==17||points.some((p,i)=>p.id!==i+1))throw Error('Mẫu person_vf17 cần đủ các ID 1–17.');
  return {...info,points,empty:false};
}
function agree(a,b,tolerance=.06){
  if(a.length!==b.length)return false;
  return a.every(p=>{
    const q=b.find(k=>k.id===p.id);
    return q && q.state===p.state && (q.state==='Outside'||Math.hypot(p.x-q.x,p.y-q.y)<=tolerance);
  });
}
function intent(person,points,base){
  const count=person.sublabels.length;
  const labels=new Map(person.sublabels.map(s=>[Number(s.name),s.id]));
  if(points.length!==count || new Set(points.map(p=>p.id)).size!==count)throw Error('Sai số lượng hoặc trùng ID điểm');
  return points.map(p=>{
    const label=labels.get(p.id);
    if(!label)throw Error('Không khớp sublabel '+p.id);
    const old=base?.elements.find(e=>e.label_id===label);
    return {label_id:label,outside:p.state==='Outside',occluded:p.state==='Occluded'||!!(p.state==='Outside'&&old?.outside&&old.occluded),
      points:p.state==='Outside'?(old?.points||[0,0]):[p.x,p.y]};
  });
}
function matches(elements,expected,frame){
  return expected.length>0 && elements?.length===expected.length && expected.every(k=>{
    const found=elements.filter(e=>e.label_id===k.label_id);
    if(found.length!==1)return false;
    const e=found[0];
    return e.frame===frame && !!e.occluded===k.occluded && !!e.outside===k.outside &&
      (k.outside || (e.points?.length===2 && e.points.every((v,i)=>Number.isFinite(v)&&Math.abs(v-k.points[i])<0.02)));
  });
}
function metadataMatches(shape,base) {
  const defaults={group:0,rotation:0,z_order:0,score:1,attributes:[]};
  return ['id','type','label_id','frame','source',...Object.keys(defaults)].every(key=>
    JSON.stringify(shape[key]??defaults[key])===JSON.stringify(base[key]??defaults[key]));
}
function preservesOriginal(shape,base) {
  if(!metadataMatches(shape,base) || JSON.stringify(shape.points??[])!==JSON.stringify(base.points??[]))return false;
  for(const key of ['outside','occluded']){
    const aggregate=shape.elements.every(el=>!!el[key]);
    if(!!shape[key]!==!!base[key] && !!shape[key]!==aggregate)return false;
  }
  return shape.elements.every(el=>{
    const old=base.elements.find(e=>e.label_id===el.label_id);
    return old && metadataMatches(el,old) && (!el.outside || !old.outside || JSON.stringify(el.points)===JSON.stringify(old.points));
  });
}
function hasManualSource(shape, allowOmitted = false) {
  // A native Save may omit default fields. The persisted shape must confirm every source.
  return [shape, ...shape.elements].every(({source}) =>
    source === 'manual' || (allowOmitted && source === undefined));
}
function allowedRequest(req,mode,frame,label,expected,base,profile=profiles.pose){
  const url=new URL(req.url());
  if(req.method()!=='PATCH' || !profile || url.origin!==profile.origin || url.pathname.replace(/\/$/,'')!==profile.api+'/annotations' ||
     [...url.searchParams.keys()].some(k=>k!=='org'&&k!=='action') || url.searchParams.getAll('action').length!==1 || url.searchParams.get('action')!==mode)return false;
  const body=req.postDataJSON(),s=body?.shapes?.[0];
  return body?.shapes?.length===1 && !(body.tags?.length||body.tracks?.length) && s.type==='skeleton' && s.frame===frame && s.label_id===label &&
    matches(s.elements,expected,frame) && (base?preservesOriginal(s,base):!s.id && hasManualSource(s,true));
}
function reconcileSave(folder,frame,shapes,base) {
  const file=path.join(folder,'save-intent.json');
  if(shapes.length!==1 || !fs.existsSync(file))return null;
  const receipt=json(file),shape=shapes[0];
  if(receipt.frame!==frame || receipt.job!==profiles.pose.job || receipt.label!==shape.label_id ||
    receipt.baseID!==(base?.id??null) || !matches(shape.elements,receipt.expected,frame) ||
    !(base ? preservesOriginal(shape,base) : hasManualSource(shape)))return null;
  write(path.join(folder,'verified.json'),shape);
  return shape.id;
}

async function createShape(page,expected,labelName){
  const previousCount=await page.locator(groups).count();
  const button=page.locator('.cvat-draw-skeleton-control');
  await button.hover();
  const shape=page.locator('.ant-popover:visible').getByRole('button',{name:'Shape',exact:true}).last();
  if(!await shape.isVisible())await button.click();
  if(labelName){
    const menu=page.locator('.ant-popover:visible').filter({has:page.getByRole('button',{name:'Shape',exact:true})}).last();
    await menu.locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').getByText(labelName,{exact:true}).click();
  }
  try {
    await shape.click({timeout:6000});
  } catch (error) {
    const menus=await page.locator('.ant-popover:visible, [class*="draw-skeleton-popover"]:visible').allTextContents();
    throw Error('Draw skeleton · menu '+JSON.stringify(menus)+' · '+error.message);
  }
  // CVAT creates its own skeleton through the draw handler. Populate its native event
  // before the editor constructs the 17 ObjectState children.
  await page.evaluate(data=>{
    window.__poseDrawResult=null;
    const onDraw=e=>{
      const state=e.detail?.state;
      if(state?.shapeType!=='skeleton')return;
      document.removeEventListener('canvas.drawn',onDraw,true);
      const list=state.elements||[];
      if(list.length!==data.length || list.some(el=>!data.find(k=>k.label_id===el.labelID))){
        window.__poseDrawResult='Mẫu skeleton không khớp sublabel · '+list.length+' · '+JSON.stringify(list[0]);e.stopImmediatePropagation();return;
      }
      for(const el of list){
        const k=data.find(k=>k.label_id===el.labelID);
        Object.assign(el,{points:k.points,occluded:k.occluded,outside:k.outside});
      }
      window.__poseDrawResult='ok';
    };
    document.addEventListener('canvas.drawn',onDraw,true);
  },expected);
  const box=await page.locator('#cvat_canvas_background').boundingBox();
  if(!box)throw Error('Ảnh gốc chưa hiển thị');
  await page.mouse.click(box.x+box.width*.2,box.y+box.height*.15);
  await page.mouse.move(box.x+box.width*.78,box.y+box.height*.84,{steps:5});
  await page.mouse.click(box.x+box.width*.78,box.y+box.height*.84);
  await page.waitForFunction(()=>window.__poseDrawResult!==null,null,{timeout:8000});
  const result=await page.evaluate(()=>window.__poseDrawResult);
  if(result!=='ok')throw Error(result);
  await page.waitForFunction(({selector,count})=>document.querySelectorAll(selector).length>count,
    {selector:groups,count:previousCount},{timeout:8000});
}
async function selectNative(page,frame,label,id=null,multiple=false){
  // A real pointer movement exposes CVAT's editable objects in its canvas event.
  await page.evaluate(({frame,label,id})=>{
    window.__poseSelected=null;
    const capture=e=>{
      const states=e.detail?.states||[e.detail?.state];
      const s=states.find(s=>s?.shapeType==='skeleton' && s.frame===frame && s.label.id===label && (id===null||s.serverID===id));
      if(s){
        window.__poseSelected=s;
        document.removeEventListener('canvas.activated',capture,true);
        document.removeEventListener('canvas.moved',capture,true);
      }
    };
    document.addEventListener('canvas.activated',capture,true);
    document.addEventListener('canvas.moved',capture,true);
  },{frame,label,id});
  const group=page.locator('.cvat_canvas_shape_skeleton');
  if(!multiple && await group.count()!==1)throw Error('Cần một skeleton hiện có để sửa.');
  const circle=group.locator('circle:visible').first();
  await page.mouse.move(5,5);
  if(multiple){
    const box=await page.locator(background).boundingBox();
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
  }else await circle.hover({force:true});
  await page.waitForFunction(()=>!!window.__poseSelected,null,{timeout:5000});
  return page.evaluate(()=>window.__poseSelected.elements.map(e=>({label_id:e.label.id,frame:e.frame,points:e.points,occluded:e.occluded,outside:e.outside})));
}
async function editShape(page,expected,base,multiple=false){
  await selectNative(page,base.frame,base.label_id,base.id,multiple);
  await page.evaluate(({id,expected})=>{
    const parent=window.__poseSelected;
    if(parent.serverID!==id || parent.elements.length!==expected.length)throw Error('Sai ID annotation gốc');
    const changed=[];
    for(const el of parent.elements){
      const k=expected.find(x=>x.label_id===el.label.id);
      if(!k)throw Error('Sai nhãn con');
      if(el.outside!==k.outside || el.occluded!==k.occluded || (!k.outside && el.points.some((v,i)=>Math.abs(v-k.points[i])>.01))){
        el.outside=k.outside;el.occluded=k.occluded;el.points=k.points;changed.push(el);
      }
    }
    window.__poseEdit=(async()=>{for(const el of changed)await el.save();return true;})();
  },{id:base.id,expected});
  await page.evaluate(()=>window.__poseEdit);
}
async function liveShapes(app,frame){
  const data=await obtain(app.page,annotations);
  if(hasPersonTrack(data,app.config.person.id,frame))throw Error('Frame có track cần kiểm tra.');
  return data.shapes.filter(s=>s.frame===frame && s.label_id===app.config.person.id);
}
async function draw(app,frame,folder,prediction,base=null,inspect=false){
  const {page}=app;
  const original=base?[base]:[];
  const verifyBase=async()=>{
    if(!sameShapes(await liveShapes(app,frame),original))throw Error('Annotation đã đổi. Cần rà lại trước khi ghi.');
  };
  app.permitWrite=null;
  await verifyBase();
  const current=await snapshot(page,frame,app.config);
  const old=require('./review.cjs').pointsOf(base,app.config.person);
  if(current.protected || !agree(current.points,old))throw Error('Skeleton trên canvas khác bản đang lưu.');
  await page.bringToFront();
  const expected=intent(app.config.person,prediction.points,base);
  if(current.empty)await createShape(page,expected,app.config.person.name);
  else await editShape(page,expected,base);
  const actual=await selectNative(page,frame,app.config.person.id,base?.id??null);
  if(!matches(actual,expected,frame))throw Error('Vị trí hoặc trạng thái trong canvas chưa khớp. Kiểm tra bản vẽ.');
  await page.screenshot({path:path.join(folder,'native.png')});
  if(inspect)return;
  await verifyBase();
  write(path.join(folder,'save-intent.json'),{job:profiles.pose.job,frame,label:app.config.person.id,baseID:base?.id??null,expected});
  app.permitWrite=req=>allowedRequest(req,base?'update':'create',frame,app.config.person.id,expected,base);
  try{
    const [response]=await Promise.all([
      page.waitForResponse(r=>r.request().method()==='PATCH' && new URL(r.url()).pathname.replace(/\/$/,'')===endpoint,{timeout:20000}),
      page.keyboard.press('Control+s')
    ]);
    if(!response.ok())throw Error('CVAT Save trả về '+response.status());
    const id=reconcileSave(folder,frame,await liveShapes(app,frame),base);
    if(!id)throw Error(base?'Dữ liệu đọc lại sau Save chưa khớp skeleton.':'CVAT chưa xác nhận skeleton mới đúng điểm và nguồn MANUAL.');
    return {state:'saved',native:true,id};
  }finally{app.permitWrite=null;}
}
module.exports={createShape,editShape,selectNative,preservesOriginal,hasManualSource,go,snapshot,parts,draw,agree,intent,matches,allowedRequest,reconcileSave};
