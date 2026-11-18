'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

test('isolates configured CVAT hosts and limits a native Save to one matching shape', () => {
  const { parseJob } = require('../app/config.cjs');
  const { allowedRequest } = require('../app/native.cjs');
  const profile = parseJob('https://review.example:8443/tasks/17/jobs/505?frame=82','pose');
  assert.notEqual(profile.directory,parseJob('https://other.example/tasks/17/jobs/505','pose').directory);
  assert.notEqual(profile.directory,parseJob(profile.jobURL,'face').directory);
  for(const url of ['https://u:p@review.example/tasks/17/jobs/505','file:///tasks/17/jobs/505','https://review.example/jobs/505'])
    assert.throws(()=>parseJob(url,'pose'));
  const expected=[{label_id:9,outside:false,occluded:false,points:[10,20]}];
  const shape={frame:82,label_id:6,type:'skeleton',source:'manual',elements:[{...expected[0],frame:82,source:'manual'}]};
  const url=profile.origin+profile.api+'/annotations?action=create';
  const request=(address,shapes=[shape])=>({url:()=>address,method:()=>'PATCH',postDataJSON:()=>({shapes})});
  const allowed=req=>allowedRequest(req,'create',82,6,expected,null,profile);
  assert.equal(allowed(request(url)),true);
  for(const bad of [url.replace('505','506'),url.replace('review.example','other.example'),url+'&format=JSON'])
    assert.equal(allowed(request(bad)),false);
  assert.equal(allowed(request(url,[shape,shape])),false);
  assert.equal(allowed(request(url,[{...shape,source:'file'}])),false);
});

test('runs both job types from the panel with a local CVAT fixture and a model HTTP server', {timeout:60000}, async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'landmarkdesk-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const appDir=path.join(tmp,'app');
  fs.cpSync(path.join(__dirname,'../app'),appDir,{recursive:true});
  const groups=require('../app/face50.json');
  const calls=[];
  let limited=false;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSwAAAABJRU5ErkJggg==','base64');
  const skeleton=(name,id,first,count)=>({name,id,type:'skeleton',sublabels:Array.from({length:count},(_,i)=>({id:1000+first+i,name:String(first+i),type:'points'}))});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/v1/chat/completions'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      const result={driver_present:false,needs_review:false,review_note:'',points:[],group_evidence:{}};
      calls.push({kind:'model',auth:req.headers.authorization==='Bearer fixture',model:body.model,images:body.messages[0].content.filter(v=>v.type==='image_url').length});
      if(!limited && calls.filter(c=>c.kind==='model').length===2){
        limited=true;res.writeHead(429,{'Retry-After':'45'});res.end('{}');return;
      }
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));return;
    }
    calls.push({kind:'cvat',method:req.method,path:url.pathname});
    if(url.pathname.startsWith('/tasks/')){res.setHeader('Content-Type','text/html');res.end('<button class="cvat-draw-skeleton-control">Draw skeleton</button>');return;}
    if(url.pathname==='/api/labels'){
      const results=url.searchParams.get('job_id')==='505'?[skeleton('person',9,1,17)]:
        groups.map((g,i)=>skeleton(g.name,20+i,g.first,g.count));
      res.end(JSON.stringify({results,next:null}));return;
    }
    if(url.pathname.endsWith('/annotations')){res.end('{"shapes":[],"tracks":[]}');return;}
    if(url.pathname.endsWith('/data/meta')){res.end('{}');return;}
    if(url.pathname.endsWith('/data')){res.end(png);return;}
    const match=/^\/api\/jobs\/(505|706)$/.exec(url.pathname);
    if(match){res.end(JSON.stringify({id:+match[1],task_id:17,start_frame:80,stop_frame:82}));return;}
    res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port;
  const settings={AI_PROVIDER:'openai',AI_API_KEY:'fixture',AI_MODEL:'fixture-vision',AI_BASE_URL:origin+'/v1',
    CVAT_POSE_URL:origin+'/tasks/17/jobs/505',CVAT_FACE_URL:origin+'/tasks/17/jobs/706'};
  for(const key of [...Object.keys(settings),'AI_MAX_TOKENS']){
    const prior=process.env[key];delete process.env[key];
    t.after(()=>{if(prior!==undefined)process.env[key]=prior;});
  }
  fs.writeFileSync(path.join(tmp,'.env'),Object.entries(settings).map(([k,v])=>k+'='+v).join('\n'));
  const {profiles,validateSettings}=require(path.join(appDir,'config.cjs'));
  validateSettings();
  const {openJob}=require(path.join(appDir,'cvat.cjs'));
  const timers=require('node:timers/promises'),delay=timers.setTimeout;
  t.mock.method(timers,'setTimeout',(ms,...args)=>{
    if(limited && ms>44000 && ms<=45000){calls.push({kind:'cooldown'});return Promise.resolve();}
    return delay(ms,...args);
  });
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage(), panel=await browser.newPage();
  for(const mode of ['pose','face']){
    const config=await openJob({page},null,mode);
    assert.equal(config.job.start_frame,80);
    const app={mode,page,config,rows:[],dashboard:panel};
    const workflow=require(path.join(appDir,mode==='pose'?'job.cjs':'face-job.cjs'));
    await assert.rejects(workflow.dispatch(app,'startSelected',{frames:[79]}));
    if(mode==='pose'){
      await panel.exposeBinding('landmarkDesk',async(_,action,arg)=>{
        const result=await workflow.dispatch(app,action,arg);
        return action==='state'?{...result,mode,modes:Object.keys(profiles),model:'fixture-vision',jobId:505,first:80,last:82}:result;
      });
      await panel.goto(pathToFileURL(path.join(appDir,'studio.html')).href);
      await panel.getByRole('checkbox',{name:'Chạy AI trên frame 82'}).check();
      await panel.locator('#runPicked').click();
      await panel.waitForFunction(()=>document.querySelector('#count').textContent==='1 / 3');
      assert.match(await panel.title(),/^LandmarkDesk.*505$/);
      await panel.goto('about:blank');
    }else{
      await workflow.scan(app,[82]);
    }
    assert.deepEqual(app.scanReport.errors,[]);
    assert.deepEqual(app.rows.map(r=>[r.frame,r.state]),[[82,'no_driver']]);
    assert.ok(fs.existsSync(path.join(profiles[mode].directory,'results.json')));
  }
  const model=calls.filter(c=>c.kind==='model');
  assert.deepEqual(model.map(c=>c.images),[2,3,3,2,3]);
  assert.deepEqual(calls.filter(c=>c.kind!=='cvat').map(c=>c.kind),['model','model','cooldown','model','model','model']);
  assert.ok(model.every(c=>c.auth && c.model==='fixture-vision'));
  assert.ok(calls.filter(c=>c.kind==='cvat').every(c=>c.method==='GET'));
});
