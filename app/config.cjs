'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env');
const env = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
function setting(key) { return (process.env[key] ?? env[key] ?? '').trim(); }

function parseJob(raw, mode) {
  let url;
  try { url = new URL(raw); } catch { throw Error('Link CVAT không hợp lệ. Kiểm tra .env.'); }
  const match = /^\/tasks\/(\d+)\/jobs\/(\d+)\/?$/.exec(url.pathname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !match ||
      !match.slice(1).every(id => Number.isSafeInteger(+id) && +id > 0)) {
    throw Error('Link CVAT cần có dạng https://may-chu/tasks/<task>/jobs/<job>.');
  }
  const task = Number(match[1]), job = Number(match[2]);
  const jobURL = url.origin + '/tasks/' + task + '/jobs/' + job;
  const hostKey = createHash('sha256').update(url.origin).digest('hex').slice(0,24);
  return {origin:url.origin, jobURL, task, job, api:'/api/jobs/' + job,
    directory:path.join(root, '.local', 'jobs', hostKey, 'task-'+task, 'job-'+job, mode)};
}
const profiles = {};
for (const mode of ['pose','face']) {
  const value = setting('CVAT_'+mode.toUpperCase()+'_URL');
  if (value) profiles[mode] = parseJob(value, mode);
}
function modelEnvironment() {
  return Object.fromEntries(['AI_PROVIDER','AI_BASE_URL','AI_MODEL','AI_API_KEY','AI_MAX_TOKENS'].map(key=>[key,setting(key)]));
}
function validateSettings() {
  if (!Object.keys(profiles).length) throw Error('Điền CVAT_POSE_URL hoặc CVAT_FACE_URL trong .env.');
  const {AI_PROVIDER, AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_MAX_TOKENS} = modelEnvironment();
  if (!['openai','anthropic'].includes(AI_PROVIDER) || !AI_API_KEY || !AI_MODEL)
    throw Error('Kiểm tra AI_PROVIDER, AI_API_KEY và AI_MODEL trong .env.');
  let url;
  try { url = new URL(AI_BASE_URL); } catch { throw Error('AI_BASE_URL không hợp lệ.'); }
  const local = ['127.0.0.1','[::1]','localhost'].includes(url.hostname);
  if (!(url.protocol==='https:' || (local && url.protocol==='http:')) || url.username || url.password || url.search || url.hash)
    throw Error('AI_BASE_URL cần là địa chỉ HTTPS của API, hoặc HTTP localhost.');
  if (AI_MAX_TOKENS && (!/^\d+$/.test(AI_MAX_TOKENS) || !Number.isSafeInteger(+AI_MAX_TOKENS) || +AI_MAX_TOKENS<1))
    throw Error('AI_MAX_TOKENS cần là số nguyên dương.');
}
if (require.main===module) {
  try { validateSettings(); } catch (e) { console.error(e.message); process.exitCode=1; }
}
module.exports={root,profiles,parseJob,setting,modelEnvironment,validateSettings};
