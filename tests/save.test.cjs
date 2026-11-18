'use strict';
process.env.CVAT_POSE_URL='https://pose.example/tasks/17/jobs/505';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {intent,matches,allowedRequest,reconcileSave}=require('../app/native.cjs');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {changes,needsDrawing,sameShapes}=require('../app/job.cjs');
const {validateDecision,reviewRecord}=require('../app/review.cjs');
const frame=4,person={id:8934,sublabels:Array.from({length:17},(_,i)=>({id:8935+i,name:String(i+1)}))};
const points=person.sublabels.map((s,i)=>({id:i+1,x:100+i*2,y:220-i,state:'Visible'}));
points[7]={id:8,x:200,y:200,state:'Occluded'};points[16]={id:17,x:null,y:null,state:'Outside'};
const expected=intent(person,points);
test('server can reorder children while modified coordinates still invalidate a backup',()=>{
  const base={id:1,elements:[{id:21,points:[2,3]},{id:22,points:[8,9]}]};
  const live=structuredClone(base);live.elements.reverse();
  assert.ok(sameShapes([base],[live]));
  live.elements[0].points.reverse();assert.equal(sameShapes([base],[live]),false);
});
const shape={frame,label_id:person.id,type:'skeleton',elements:expected.map(e=>({...e,frame}))};
function request(body,action='create'){
  return {method:()=>'PATCH',url:()=>'https://pose.example/api/jobs/505/annotations?action='+action,postDataJSON:()=>body};
}
test('CVAT Save guard accepts only the intended native skeleton on this frame',()=>{
  const data={shapes:[structuredClone(shape)],tags:[],tracks:[]};
  const approve=()=>allowedRequest(request(data),'create',frame,person.id,expected,null);
  assert.ok(approve());
  data.shapes[0].elements[7].occluded=false;assert.equal(approve(),false);
  data.shapes[0]=structuredClone(shape);data.shapes[0].frame=2;assert.equal(approve(),false);
  data.shapes[0]=structuredClone(shape);data.shapes.push(shape);assert.equal(approve(),false);
  data.shapes.pop();data.tracks.push({});assert.equal(approve(),false);
});
test('existing IDs are preserved and unexpected updates are rejected',()=>{
  const existing={...shape,id:981};
  assert.ok(allowedRequest(request({shapes:[existing]},'update'),'update',frame,person.id,expected,existing));
  assert.equal(allowedRequest(request({shapes:[{...existing,id:982}]},'update'),'update',frame,person.id,expected,existing),false);
  assert.equal(matches(shape.elements.slice(1),expected,frame),false);
});
test('new Pose saves verify the parent and child sources, including after a retry',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pose-source-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const receipt={job:505,frame,label:person.id,baseID:null,expected};
  fs.writeFileSync(path.join(dir,'save-intent.json'),JSON.stringify(receipt));
  const draft=structuredClone(shape);
  const allowed=()=>allowedRequest(request({shapes:[draft]}),'create',frame,person.id,expected,null);
  const persisted=()=>reconcileSave(dir,frame,[{...draft,id:151}],null);
  for(const source of ['file','auto',undefined]){
    draft.source=source;
    assert.equal(allowed(),source===undefined);
    assert.equal(persisted(),null);
  }
  draft.source='manual';
  draft.elements.forEach(el=>{el.source='manual';});
  for(const source of ['auto','file',undefined]){
    draft.elements[0].source=source;
    assert.equal(allowed(),source===undefined);
    assert.equal(persisted(),null);
  }
  assert.ok(!fs.existsSync(path.join(dir,'verified.json')));
  draft.elements[0].source='manual';
  assert.ok(allowed());
  assert.equal(persisted(),151);
  for(const source of ['file','auto']){
    const original={...structuredClone(draft),id:152,source};
    const saveUpdate=body=>allowedRequest(request({shapes:[body]},'update'),'update',frame,person.id,expected,original);
    assert.ok(saveUpdate(original));
    assert.equal(saveUpdate({...original,source:'manual'}),false);
  }
});
test('native update rejects changed sublabel ids or attributes and keeps hidden metadata',()=>{
  const base={...structuredClone(shape),id:900,source:'manual',attributes:[]};
  base.elements.forEach((e,i)=>Object.assign(e,{id:1000+i,source:'manual',attributes:[]}));
  base.elements.at(-1).occluded=true;
  const planned=intent(person,points,base);
  const outgoing=structuredClone(base);
  const check=()=>allowedRequest(request({shapes:[outgoing]},'update'),'update',frame,person.id,planned,base);
  assert.ok(check());
  outgoing.elements[0].id++;assert.equal(check(),false);
  outgoing.elements[0].id--;outgoing.elements[1].attributes=[{spec_id:2,value:'x'}];assert.equal(check(),false);
  outgoing.elements[1].attributes=[];outgoing.group=4;assert.equal(check(),false);
});
test('a left/right swap is drawable independently of mentor review',()=>{
  const d={points:structuredClone(points),human_review:{}};
  validateDecision(d,{pending:false},960,540);
});
test('review lists specific changed joints and ignores outside placeholder coordinates',()=>{
  const edited=structuredClone(shape);
  edited.elements[7].points=[199,185];edited.elements[16].points=[22,55];
  assert.equal(changes(edited,points,person).length,0);
  edited.elements[0].points=[0,0];edited.elements[1].occluded=true;
  assert.deepEqual(changes(edited,points,person).map(x=>x.id),[1,2]);
});
test('QC completion requires a review record, while drawing requires valid coordinates',()=>{
  const d={points:structuredClone(points),human_review:{}};
  validateDecision(d,{pending:true},960,540);
  assert.throws(()=>reviewRecord({},true));
  assert.equal(reviewRecord({cvat_issue:'ghi chú'},false).cvat_issue,'ghi chú');
  d.human_review={team_vote:'2/3',cvat_issue:'Issue 3',mentor_decision:'Đã chốt'};
  validateDecision(d,{pending:true},960,540);
  d.points[9].x=960;assert.throws(()=>validateDecision(d,{pending:true},960,540));
});
test('resume creates legacy native drafts but preserves saved and existing shapes',()=>{
  const draft={state:'review',native:true,pending:true};
  assert.ok(needsDrawing(draft));
  for(const change of [{existing:12},{selected:true},{protected:true},{state:'saved'},{state:'proposal'}]){
    assert.ok(!needsDrawing({...draft,...change}));
  }
});
