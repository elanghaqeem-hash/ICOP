import test from 'node:test';
import assert from 'node:assert/strict';
import {handleStagingDashboard} from './staging-dashboard.mjs';
const base='https://icop-staging-api.elang-haqeem.workers.dev';
const owner='elang.haqeem@gmail.com';
const cookie='__Host-icop-staging-session=not-a-real-token';
const req=(path,options={})=>new Request(base+path,options);
function fixtures(){
  const calls=[];
  const env={
    ICOP_FRONTEND:{async fetch(r){
      calls.push({url:r.url,headers:Object.fromEntries(r.headers)});
      return new Response(r.url.includes('/login')?'<h1>Real frontend login</h1>':'<h1>Real ICOP dashboard</h1>',{
        status:200,headers:{'content-type':'text/html','set-cookie':'unsafe-bff-session=ignore; Path=/','cache-control':'public, max-age=8000'}
      });
    }},
    DB:{prepare(sql){
      assert.match(sql,/FROM users u JOIN tenants/);
      return {bind(id,email){
        assert.equal(id,'owner-id');
        assert.equal(email,owner);
        return {async first(){
          return {fullName:'ICOP System Administrator',role:'super_admin',
            email,tenant:'DEIT',active:1,mfa:1,passwordChange:0};
        }};
      }};
    }}
  };
  const ctx={access:{aud:'testing-audience',async getIdentity(){return {email:owner}}}};
  const auth=async(request,_env,context)=>{
    if(!context?.access)return new Response(JSON.stringify({code:'ACCESS_REQUIRED'}),{status:403});
    const path=new URL(request.url).pathname;
    if(path==='/api/v1/auth/access-check')return Response.json({status:'access_identity_verified'});
    if(path==='/api/v1/auth/login')
      return new Response(JSON.stringify({applicationAuthenticated:true,mfaVerified:true,
        user:{id:'owner-id',email:owner,role:'super_admin',forcePasswordChange:false}}),{
        status:200,headers:{'content-type':'application/json','set-cookie':cookie+'; Secure; HttpOnly; SameSite=Strict; Path=/'}
      });
    if(path==='/api/v1/auth/logout'){
      assert.equal(request.headers.get('content-type'),'application/json');
      assert.equal(await request.text(),'{}');
      return new Response('{"ok":true}',{status:200,headers:{'set-cookie':'__Host-icop-staging-session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'}});
    }
    if(path==='/api/v1/auth/me'){
      if(!request.headers.get('cookie')?.includes('__Host-icop-staging-session='))
        return Response.json({code:'SESSION_REQUIRED'},{status:401});
      return Response.json({applicationAuthenticated:true,mfaVerified:true,
        user:{id:'owner-id',email:owner,role:'super_admin',tenantId:'tenant-id'}});
    }
    return Response.json({code:'NO_ROUTE'},{status:404});
  };
  return {env,ctx,auth,calls};
}
test('unchanged API Worker behavior before frontend Service Binding is applied',async()=>{
  const f=fixtures();delete f.env.ICOP_FRONTEND;
  assert.equal(await handleStagingDashboard(req('/'),f.env,f.ctx,f.auth),null);
});
test('existing real login HTML served from frontend service, no auth cookie forwarded',async()=>{
  const f=fixtures();
  const r=await handleStagingDashboard(req('/login',{headers:{cookie:'sensitive=xyz',authorization:'Bearer hidden'}}),f.env,f.ctx,f.auth);
  assert.equal(r.status,200);assert.match(await r.text(),/Real frontend login/);
  assert.equal(r.headers.get('set-cookie'),null);
  assert.equal(f.calls[0].headers.cookie,undefined);
  assert.equal(f.calls[0].headers.authorization,undefined);
});
test('same-origin login writes Secure HttpOnly staging auth cookie, not browser token',async()=>{
  const f=fixtures();
  const r=await handleStagingDashboard(req('/api/v1/auth/login',{
    method:'POST',headers:{origin:base,'content-type':'application/json'},
    body:JSON.stringify({tenant:'DEIT',email:owner,password:'example-only'})}),f.env,f.ctx,f.auth);
  assert.equal(r.status,200);
  assert.match(r.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await r.json()).user.role,'super_admin');
});
test('server session response matches ICOP Next Shell contract and RBAC',async()=>{
  const f=fixtures();
  const r=await handleStagingDashboard(req('/api/v1/auth/me',{headers:{cookie}}),f.env,f.ctx,f.auth);
  assert.equal(r.status,200);
  const data=await r.json();
  assert.equal(data.email,owner);
  assert.equal(data.role,'super_admin');
  assert.equal(data.mfaVerified,true);
  assert.equal(data.customerId,null);
  assert.ok(data.permissions.includes('dashboard.read'));
  assert.ok(data.permissions.includes('user.manage'));
  assert.ok(!data.permissions.includes('approval.decide'),'preserve separation of duties');
  assert.ok(!data.permissions.includes('portal.access'),'internal admin is not customer user');
});
test('protected dashboard redirects to real frontend login until valid D1 session',async()=>{
  const f=fixtures();
  const deny=await handleStagingDashboard(req('/'),f.env,f.ctx,f.auth);
  assert.equal(deny.status,303);
  assert.equal(deny.headers.get('location'),'/login');
  assert.equal(f.calls.length,0);
  const ok=await handleStagingDashboard(req('/',{headers:{cookie}}),f.env,f.ctx,f.auth);
  assert.equal(ok.status,200);
  assert.match(await ok.text(),/Real ICOP dashboard/);
  assert.equal(ok.headers.get('set-cookie'),null);
  assert.equal(f.calls[0].headers.cookie,undefined);
});
test('static asset requests remain protected by Cloudflare Access but not app login',async()=>{
  const f=fixtures();
  const r=await handleStagingDashboard(req('/_next/static/chunks/sample.js'),f.env,f.ctx,f.auth);
  assert.equal(r.status,200);
  assert.equal(f.calls.length,1);
  const noAccess=await handleStagingDashboard(req('/_next/static/chunks/sample.js'),f.env,{},f.auth);
  assert.equal(noAccess.status,403);
});
test('unauthenticated business APIs rejected and authenticated unimplemented APIs fail closed',async()=>{
  const f=fixtures();
  const denied=await handleStagingDashboard(req('/api/v1/dashboard'),f.env,f.ctx,f.auth);
  assert.equal(denied.status,401);
  const notReady=await handleStagingDashboard(req('/api/v1/dashboard',{headers:{cookie}}),f.env,f.ctx,f.auth);
  assert.equal(notReady.status,503);
  assert.equal((await notReady.json()).code,'STAGING_BUSINESS_API_NOT_MIGRATED');
  assert.equal(f.calls.length,0);
});
test('logout revokes server-side session through auth module and never exposes credentials',async()=>{
  const f=fixtures();
  const response=await handleStagingDashboard(req('/api/v1/auth/logout',{
    method:'POST',headers:{cookie,origin:base}}),f.env,f.ctx,f.auth);
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  const reject=await handleStagingDashboard(req('/api/v1/auth/logout',{
    method:'POST',headers:{cookie,origin:'https://evil.example','sec-fetch-site':'cross-site'}}),f.env,f.ctx,f.auth);
  assert.equal(reject.status,403);
});
test('identity, methods and suspicious internal paths cannot bypass frontend gate',async()=>{
  const f=fixtures();
  assert.equal((await handleStagingDashboard(req('/',{headers:{cookie}}),f.env,{},f.auth)).status,403);
  assert.equal((await handleStagingDashboard(req('/.env',{headers:{cookie}}),f.env,f.ctx,f.auth)).status,404);
  assert.equal((await handleStagingDashboard(req('/',{method:'POST',headers:{cookie}}),f.env,f.ctx,f.auth)).status,405);
});
