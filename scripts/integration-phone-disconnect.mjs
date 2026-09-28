import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
const stub = '/tmp/traducere-phone-fetch-' + process.pid + '.mjs';
const log = '/tmp/traducere-phone-log-' + process.pid;
writeFileSync(stub, `import {appendFileSync} from 'node:fs';\nglobalThis.fetch=async (url,options={})=>{if(String(url).endsWith('/call_control_applications?page[size]=100'))return new Response(JSON.stringify({data:[{id:'conn-1',application_name:'Traducere Live'}]}),{status:200});appendFileSync(${JSON.stringify(log)}, String(url)+'\\n');return new Response(JSON.stringify({data:{call_control_id:'call-1'}}),{status:200});};`);
const port = 23000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, ['--import', stub, 'server.js'], {
  env: {...process.env, PORT: String(port), PHONE_TRANSLATION_ENABLED: 'true', OPENAI_API_KEY: 'test', TELNYX_API_KEY: 'test', TELNYX_FROM_NUMBER: '+4512345678', APP_PIN: 'test-pin', PUBLIC_BASE_URL: 'https://example.test'},
  stdio: 'ignore'
});
try {
  let ready = false;
  for(let i=0;i<40;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/api/phone-translation-availability`); if(r.ok){ready=true;break} } catch{} await delay(100); }
  assert.ok(ready, 'server started');
  const availability = await (await fetch(`http://127.0.0.1:${port}/api/phone-translation-availability`)).json();
  assert.equal(availability.enabled, true);
  const response = await fetch(`http://127.0.0.1:${port}/api/call`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:'test-pin',to:'+4552520302',providerConsent:true})});
  assert.equal(response.status, 200, await response.text());
  await delay(16000);
  assert.match(readFileSync(log,'utf8'), /\/calls\/call-1\/actions\/hangup/, 'unattended call is hung up');
  console.log('Phone call session disconnect integration passed.');
} finally { child.kill(); unlinkSync(stub); try{unlinkSync(log)}catch{} }
