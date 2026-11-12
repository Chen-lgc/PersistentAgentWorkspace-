import test from 'node:test';
import assert from 'node:assert/strict';
import {MemhubLoopbackClient} from './memhub-loopback.mjs';

test('forbids non-local destinations and missing token', () => {
  assert.throws(()=>new MemhubLoopbackClient({baseURL:'https://example.com',token:'x'}), /localhost/);
  assert.throws(()=>new MemhubLoopbackClient({baseURL:'http://127.0.0.1:8765',token:''}), /token/);
});
test('reads profile only and never treats text as an instruction', async () => {
  let call;
  const client=new MemhubLoopbackClient({token:'local-only',fetchFn:async(url,options)=>{
    call={url,options};
    return {ok:true,json:async()=>({memories:{profile:[{memory_id:'p1',content:'用户偏好中文答复'}],normal:[{memory_id:'other-project',content:'SECRET'}]},warnings:[]})};
  }});
  const result=await client.recallPersonal('中文');
  assert.equal(call.url,'http://127.0.0.1:8765/v1/hub/recall');
  assert.match(call.options.headers.Authorization,/^Bearer local-only$/);
  assert.deepEqual(JSON.parse(call.options.body),{query:'中文',limit:1,raw_limit:0,procedure_limit:0});
  assert.deepEqual(result,[{id:'p1',content:'用户偏好中文答复',source:'memhub-profile',trustedAsInstruction:false}]);
});
test('returns errors without leaking tokens', async () => {
  const c=new MemhubLoopbackClient({token:'very-private',fetchFn:async()=>({ok:false,status:403})});
  await assert.rejects(c.recallPersonal('test'),e=>e.message==='MemHub recall failed: HTTP 403');
});
