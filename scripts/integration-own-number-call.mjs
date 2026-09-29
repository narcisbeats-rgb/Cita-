import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";

const stub = "/tmp/traducere-own-number-stub-" + process.pid + ".mjs";
const log = "/tmp/traducere-own-number-log-" + process.pid;
const number = "+4512345678";
const fake = "import { appendFileSync } from \"node:fs\";\nconst logFile = __LOG__;\nglobalThis.fetch = async (url, options={}) => {\n  const u = String(url);\n  const body = options.body ? JSON.parse(options.body) : {};\n  const verifiedNumber = {data:{phone_number:\"+4512345678\",record_type:\"verified_number\",verified_at:\"2026-09-29T12:00:00Z\"}};\n  const reply = (data, status=200) => new Response(JSON.stringify(data),{status,headers:{\"content-type\":\"application/json\"}});\n  if (u.endsWith(\"/call_control_applications?page[size]=100\")) return reply({data:[{id:\"conn-1\",application_name:\"Traducere Live\"}]});\n  if (u.includes(\"/verified_numbers/\") && u.endsWith(\"/actions/verify\") && options.method===\"POST\")\n    return reply(body.verification_code===\"123456\" ? verifiedNumber : {errors:[{detail:\"Invalid code\"}]},body.verification_code===\"123456\"?200:400);\n  if (u.includes(\"/verified_numbers/\") && options.method===\"GET\") return reply(verifiedNumber);\n  if (u.endsWith(\"/verified_numbers\") && options.method===\"POST\") {\n    appendFileSync(logFile,\"verify-start \"+body.phone_number+\"\\n\");\n    return reply({phone_number:body.phone_number,verification_method:body.verification_method});\n  }\n  if (u.endsWith(\"/calls\") && options.method===\"POST\") {\n    appendFileSync(logFile,\"dial \"+body.from+\" -> \"+body.to+\"\\n\");\n    return reply({data:{call_control_id:\"call-1\"}});\n  }\n  if (u.includes(\"/calls/call-1/actions/hangup\")) {\n    appendFileSync(logFile,\"hangup\\n\");\n    return reply({data:{}});\n  }\n  throw new Error(\"Unexpected stubbed fetch \"+u);\n};".replace("__LOG__",JSON.stringify(log));
writeFileSync(stub,fake);
const port = 23000 + Math.floor(Math.random()*10000);
const base = "http://127.0.0.1:"+port;
const child = spawn(process.execPath, ["--import",stub,"server.js"],{
  env:{...process.env,PORT:String(port),PHONE_TRANSLATION_ENABLED:"true",PUBLIC_CALLER_ACCOUNTS_ENABLED:"true",
    SESSION_SECRET:"local-testing-only-very-long-session-secret-12345",
    SIGNUP_INVITE_CODE:"local-testing-only-very-long-invite-code-12345",
    OPENAI_API_KEY:"test",TELNYX_API_KEY:"test",TELNYX_FROM_NUMBER:"",
    APP_PIN:"test-pin",PUBLIC_BASE_URL:"https://example.test"},
  stdio:"ignore"
});
async function post(path,data,cookie="") {
 const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{})},
   body:JSON.stringify(data)});
 return {status:r.status,data:await r.json(),cookie:r.headers.get("set-cookie")};
}
try {
  let ready=false;
  for(let i=0;i<80;i++){
    try { const r=await fetch(base+"/api/account/availability");if((await r.json()).enabled){ready=true;break} } catch {}
    await delay(100);
  }
  assert.ok(ready,"Account storage started with test Postgres.");
  const unauthed=await post("/api/call",{to:"+4552520302",providerConsent:true});
  assert.equal(unauthed.status,401,"Unregistered callers cannot dial.");
  const signup=await post("/api/account/register",{email:"pilot@example.test",password:"correct horse battery staple",invite:"local-testing-only-very-long-invite-code-12345"});
  assert.equal(signup.status,201,JSON.stringify(signup.data));
  const cookie=signup.cookie?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-traducere_session="));
  const unverified=await post("/api/call",{to:"+4552520302",providerConsent:true},cookie);
  assert.equal(unverified.status,409,"No paid calls without own-number verification.");
  const initiated=await post("/api/account/number/start",{phoneNumber:number,method:"sms",verificationConsent:true},cookie);
  assert.equal(initiated.status,202,JSON.stringify(initiated.data));
  const confirmed=await post("/api/account/number/confirm",{verificationCode:"123456"},cookie);
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.phoneNumber,number);
  const spoofed=await post("/api/call",{to:"+4552520302",from:"+4599999999",providerConsent:true},cookie);
  assert.equal(spoofed.status,400,"Client-supplied caller ID is rejected.");
  const attempt=await post("/api/call",{to:"+4552520302",providerConsent:true},cookie);
  assert.equal(attempt.status,200,JSON.stringify(attempt.data));
  assert.equal(attempt.data.callerId,number);
  let logs=readFileSync(log,"utf8");
  assert.match(logs,/verify-start \+4512345678/);
  assert.match(logs,/dial \+4512345678 -> \+4552520302/);
  assert.doesNotMatch(logs,/dial \+4599999999/);
  await delay(16000);
  logs=readFileSync(log,"utf8");
  assert.match(logs,/hangup/,"Unattended test call is hung up.");
  const signedOut=await post("/api/account/logout",{},cookie);
  assert.equal(signedOut.status,200);
  const afterLogout=await post("/api/call",{to:"+4552520302",providerConsent:true},cookie);
  assert.equal(afterLogout.status,401,"Logged-out caller cannot dial.");
  console.log("Own-number signup, verified-number binding, anti-spoofing, mock call and unattended hangup passed.");
} finally {
  child.kill();
  unlinkSync(stub);
  try { unlinkSync(log); } catch {}
}
