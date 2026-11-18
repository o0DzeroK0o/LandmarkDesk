'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');
const { profiles, findPlaywright, openJob, isJob, isJobLogin } = require('./cvat.cjs');

const {root,validateSettings,setting}=require('./config.cjs');
const panelFile = path.join(__dirname, 'studio.html');
const panelURL = pathToFileURL(panelFile).href;
function isPanel(raw) {
  try { return path.resolve(fileURLToPath(raw)).toLowerCase() === panelFile.toLowerCase(); }
  catch { return false; }
}
function blank(page) {
  return ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/'].includes(page.url());
}

// Reserve both matching tabs before assigning any spare to a missing role.
function pickTabs(pages, current = {}) {
  const open = pages.filter(p => !p.isClosed());
  const restored = open.filter(p => p.url() !== 'about:blank');
  const pool = !current.dashboard && !current.page && restored.length >= 2 ? restored : open;
  const active = (p, matches) => pool.includes(p) && matches(p.url());
  let dashboard = active(current.dashboard, isPanel) ? current.dashboard : pool.find(p => isPanel(p.url()));
  const jobMatch = url => isJob(url,current.mode||'pose');
  let editor = active(current.page, jobMatch) ? current.page : pool.find(p => jobMatch(p.url()));
  editor ??= pool.find(p => isJobLogin(p.url(),current.mode||'pose'));
  const spare = p => p !== dashboard && p !== editor;
  if (!editor) editor = pool.find(p => spare(p) && p.url().startsWith(profiles[current.mode]?.origin+'/'));
  if (!dashboard && pool.includes(current.dashboard) && spare(current.dashboard)) dashboard = current.dashboard;
  if (!editor && pool.includes(current.page) && spare(current.page)) editor = current.page;
  const take = () => pool.find(p => spare(p) && blank(p)) || pool.find(spare);
  dashboard ??= take();
  editor ??= take();
  return { dashboard, editor };
}

async function launch(inspect, onReady) {
  validateSettings();
  const profile = path.join(root,'.local','browser-profile');
  const context = await findPlaywright().chromium.launchPersistentContext(profile, {
    headless: false, serviceWorkers:'block', viewport: null, args: ['--restore-last-session'],
  });
  const app = {context, page:null, dashboard:null, config:null, status:'Đang kết nối CVAT', running:false, paused:false, permitWrite:null};
  app.mode = Object.keys(profiles).find(mode=>context.pages().some(p=>isJob(p.url(),mode))) || Object.keys(profiles)[0];
  const bound = new WeakSet();
  const guarded = new WeakSet();
  let connecting;
  let tabs = Promise.resolve();
  async function installPanel(page) {
    if (!bound.has(page)) {
      await page.exposeBinding('landmarkDesk', async ({frame}, action, arg, panelMode) => {
        if (app.dashboard !== page || frame !== page.mainFrame() || !isPanel(frame.url())) throw Error('Unexpected panel origin.');
        if(action==='state'){
          const state=await workflow().dispatch(app,action,arg);
          return {...state,mode:app.mode,modes:Object.keys(profiles),jobId:profiles[app.mode].job,model:setting('AI_MODEL'),
            first:app.config?.job.start_frame??0,last:app.config?.job.stop_frame??-1,switching:!!app.switching};
        }
        if(app.switching || (panelMode||'pose')!==app.mode)throw Error('Job đang thay đổi. Chờ bảng điều khiển cập nhật.');
        if(action==='mode')return switchMode(arg?.mode);
        return workflow().dispatch(app,action,arg);
      });
      bound.add(page);
    }
    if (!isPanel(page.url())) await page.goto(panelURL);
  }
  async function installEditor(page) {
    if (guarded.has(page)) return;
    await page.route('**/api/jobs/*/annotations*', async route => {
      const req = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
      try {
        if (page !== app.page || !app.permitWrite?.(req)) return route.abort();
        app.permitWrite = null;
        return route.continue();
      } catch { return route.abort(); }
    });
    const disconnect = () => {
      if (app.page !== page) return;
      app.config = null;
      app.permitWrite = null;
      app.paused = true;
      app.retryWait?.abort();
      app.status = 'Chọn Mở CVAT để kết nối lại.';
    };
    page.once('close', disconnect);
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && app.config && !isJob(frame.url(),app.mode)) disconnect();
    });
    guarded.add(page);
  }
  function ensureTabs() {
    tabs = tabs.catch(() => {}).then(async () => {
      const {dashboard, editor} = pickTabs(context.pages(), app);
      app.dashboard = dashboard || await context.newPage();
      await installPanel(app.dashboard);
      const next = editor || await context.newPage();
      if (app.page !== next) { app.config = null; app.permitWrite = null; }
      app.page = next;
      await installEditor(next);
    });
    return tabs;
  }
  function connect() {
    if (app.config && isJob(app.page.url(),app.mode)) return Promise.resolve();
    if (!connecting) {
      const editor = app.page;
      app.status = 'Đang kết nối CVAT';
      connecting = openJob({page:editor}, null,app.mode).then(config => {
        if (app.page !== editor || editor.isClosed()) throw Error('Tab CVAT đã thay đổi.');
        app.config = config;
        app.status = app.rows?.length === config.job.stop_frame-config.job.start_frame+1 && !app.rows.some(r => r.state === 'error') ? 'Đã rà toàn job' : 'Đã kết nối';
      }).finally(() => { connecting = null; });
    }
    return connecting;
  }
  app.openEditor = async () => {
    if (app.running) throw Error('Chờ lượt xử lý dừng trước khi kết nối lại.');
    await ensureTabs();
    await app.page.bringToFront();
    await connect();
  };
  app.showPanel = async () => {
    await ensureTabs();
    await app.dashboard.bringToFront();
    return connect();
  };
  function workflow(){return app.mode==='face'?require('./face-job.cjs'):require('./job.cjs');}
  function loadRows(){
    const results=path.join(profiles[app.mode].directory,'results.json');
    app.rows=fs.existsSync(results)?JSON.parse(fs.readFileSync(results,'utf8')):[];
  }
  async function switchMode(mode){
    if(!Object.hasOwn(profiles,mode))throw Error('Job chưa được hỗ trợ.');
    if(app.running||connecting||app.switching)throw Error('Chờ thao tác hiện tại kết thúc trước khi chuyển job.');
    app.switching=true;
    try{
      await app.navigation?.catch(()=>{});
      app.mode=mode;app.config=null;app.permitWrite=null;app.scanReport=null;app.current=null;
      loadRows();await ensureTabs();await connect();
    }catch(e){app.status=e.message;throw e;}
    finally{app.switching=false;}
  }
  const closed = new Promise(resolve => context.once('close', resolve));
  try {
    loadRows();
    await ensureTabs();
    // Chrome can append an empty startup tab when it also restores both destinations.
    for (const page of context.pages()) {
      if (page !== app.dashboard && page !== app.page && page.url() === 'about:blank') await page.close();
    }
    onReady?.(app.showPanel);
    await app.page.bringToFront();
    try {
      await connect();
      console.log('CVAT_CONNECTED');
    } catch (error) {
      if (inspect) throw error;
      app.status = error.message;
      console.error(error.message);
    }
    if (!app.dashboard.isClosed()) await app.dashboard.bringToFront();
    if (inspect) { await inspect(app); return; }
    await closed;
  } finally {
    await context.close().catch(() => {});
  }
}

function panelPipe() {
  const key = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);
  return '\\\\.\\pipe\\LandmarkDesk-'+key;
}
async function run() {
  // Own the pipe before starting Chrome, including while the first launch is waiting for login.
  let focus;
  let pending = false;
  const listener = net.createServer(socket => {
    socket.end();
    if (focus) focus().catch(error => console.error(error.message));
    else pending = true;
  });
  const pipe = panelPipe();
  try {
    await new Promise((resolve, reject) => listener.once('error', reject).listen(pipe, resolve));
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    await new Promise((resolve, reject) => {
      const client = net.connect(pipe);
      client.once('connect', () => { client.end(); resolve(); });
      client.once('error', reject);
    });
    return;
  }
  try {
    await launch(undefined, show => {
      focus = show;
      if (pending) show().catch(error => console.error(error.message));
    });
  } finally { listener.close(); }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { launch, pickTabs, isPanel };
