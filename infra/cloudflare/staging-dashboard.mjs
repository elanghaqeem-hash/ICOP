/**
 * ICOP staging UI → existing frontend Worker via a same-origin, Access-protected
 * Service Binding. This module never proxies identity or bearer credentials.
 *
 * The existing Cloudflare Access application must protect the ENTIRE staging
 * hostname. handleAuthV1 is the sole session authority (D1+Access+MFA+cookie).
 * Business modules are NOT migrated to D1 yet: they intentionally fail closed.
 */
const NAV_PERMISSIONS = Object.freeze([
  'dashboard.read','opportunity.read','customer.read','tender.read',
  'quotation.read','contract.read','project.read','flexguard.read',
  'documents.read','helpdesk.read','billing.read','template.read',
  'approval.read','ai.use','vendor.read','policy.read','audit.read','user.manage'
]);
const STATIC_PATH = /^\/(?:_next\/|favicon\.ico$|icon\.svg$|manifest\.webmanifest$|sw\.js$|robots\.txt$)/;
const BLOCKED_PATH = /(?:^|\/)(?:\.git|\.env|\.well-known\/private|admin-api|internal)(?:\/|$)/i;
const noCache={'cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(status,payload)=>new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json; charset=utf-8',...noCache}});
const redirect=(location)=>new Response(null,{status:303,headers:{location,...noCache}});
function isSameOriginMutation(request){
  if(request.headers.get('sec-fetch-site')==='cross-site')return false;
  return request.headers.get('origin')===new URL(request.url).origin;
}
async function appSession(request,env,ctx,handleAuthV1){
  const url=new URL(request.url);
  url.pathname='/api/v1/auth/me';
  url.search='';
  const check=await handleAuthV1(new Request(url,{method:'GET',headers:request.headers}),env,ctx);
  if(!check?.ok)return null;
  let obj;
  try {obj=await check.json();} catch{return null;}
  const u=obj?.user;
  if(obj.applicationAuthenticated!==true||obj.mfaVerified!==true||
    u?.role!=='super_admin'||!u?.id||u?.email!=='elang.haqeem@gmail.com')return null;
  const row=await env.DB.prepare(
    "SELECT u.full_name AS fullName,u.role,u.email_normalized AS email,t.code AS tenant,u.is_active AS active,u.mfa_enabled AS mfa,u.force_password_change AS passwordChange FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=? AND u.email_normalized=? LIMIT 1"
  ).bind(u.id,u.email).first();
  if(!row||row.tenant!=='DEIT'||row.active!==1||row.mfa!==1||
    row.passwordChange!==0||row.role!=='super_admin')return null;
  return {id:u.id,email:u.email,role:u.role,fullName:row.fullName||'ICOP Administrator',
    customerId:null,permissions:[...NAV_PERMISSIONS],mfaRequired:false,
    mfaEnrolled:true,mfaVerified:true,forcePasswordChange:false};
}
async function accessVerified(request,env,ctx,handleAuthV1){
  const url=new URL(request.url);
  url.pathname='/api/v1/auth/access-check';
  url.search='';
  const r=await handleAuthV1(new Request(url,{method:'GET',headers:request.headers}),env,ctx);
  return r?.status===200;
}
async function frontend(request,env){
  if(!env.ICOP_FRONTEND||typeof env.ICOP_FRONTEND.fetch!=='function')
    return json(503,{code:'STAGING_FRONTEND_BINDING_MISSING'});
  const incoming=new URL(request.url);
  const upstream=new URL('https://icop.elang-haqeem.workers.dev');
  upstream.pathname=incoming.pathname;
  upstream.search=incoming.search;
  // Never send staging session / Cloudflare Access cookies to the older
  // Next.js Worker. The backend session is checked independently in D1.
  const headers=new Headers();
  for(const name of ['accept','accept-language','rsc','next-router-state-tree',
                     'next-router-prefetch','next-url','user-agent']){
    const value=request.headers.get(name);
    if(value)headers.set(name,value);
  }
  let response;
  try{
    response=await env.ICOP_FRONTEND.fetch(new Request(upstream,{
      method:'GET',headers,redirect:'manual'
    }));
  }catch{
    return json(502,{code:'STAGING_FRONTEND_UNAVAILABLE'});
  }
  const h=new Headers(response.headers);
  for(const name of ['set-cookie','set-cookie2','authorization','www-authenticate',
                      'access-control-allow-origin','content-length','server']){
    h.delete(name);
  }
  const location=h.get('location');
  if(location){
    try{
      const to=new URL(location,upstream);
      if(to.origin!==upstream.origin)return json(502,{code:'UNTRUSTED_FRONTEND_REDIRECT'});
      h.set('location',to.pathname+to.search+to.hash);
    }catch{return json(502,{code:'INVALID_FRONTEND_REDIRECT'});}
  }
  h.set('x-content-type-options','nosniff');
  h.set('x-frame-options','DENY');
  h.set('referrer-policy','no-referrer');
  if(!incoming.pathname.startsWith('/_next/static/'))h.set('cache-control','no-store');
  // Response content is the real Next.js frontend, not a mock dashboard.
  return new Response(response.body,{status:response.status,headers:h});
}
export async function handleStagingDashboard(request,env,ctx,handleAuthV1){
  // Backwards compatible: API staging still works if the frontend service
  // binding has not yet been applied.
  if(!env.ICOP_FRONTEND)return null;
  const u=new URL(request.url),path=u.pathname;
  if(BLOCKED_PATH.test(path))return json(404,{code:'NOT_FOUND'});
  // The app's existing Next.js form sends JSON to this same origin.
  // handleAuthV1 returns the Secure, HttpOnly, __Host session cookie directly.
  if(path==='/api/v1/auth/login'&&request.method==='POST')
    return handleAuthV1(request,env,ctx);
  if(path==='/api/v1/auth/me'&&request.method==='GET'){
    const me=await appSession(request,env,ctx,handleAuthV1);
    return me?json(200,me):json(401,{code:'SESSION_REQUIRED'});
  }
  if(path==='/api/v1/auth/logout'&&request.method==='POST'){
    if(!isSameOriginMutation(request))return json(403,{code:'ORIGIN_REQUIRED'});
    const h=new Headers(request.headers);
    h.set('content-type','application/json');
    const normalized=new Request(request.url,{
      method:'POST',headers:h,body:'{}',redirect:'manual'
    });
    return handleAuthV1(normalized,env,ctx);
  }
  // Existing secure activation/reset routes are owned by handleAuthV1.
  if(path==='/activate'||path==='/reset-password'||
     path==='/api/v1/auth/access-check'||path==='/api/v1/auth/reset-password'||
     path==='/api/v1/auth/activate'||path==='/api/v1/auth/access-me'||
     path==='/health'||path==='/api/v1/system/readiness')return null;
  // Everything is denied before a verified Access identity; browser-provided
  // email, tenant and role headers have no authority.
  if(!await accessVerified(request,env,ctx,handleAuthV1))
    return json(403,{code:'CLOUDFLARE_ACCESS_VERIFIED_IDENTITY_REQUIRED'});
  if(path==='/login'&&request.method==='GET'){
    const session=await appSession(request,env,ctx,handleAuthV1);
    return session?redirect('/'):frontend(request,env);
  }
  if(STATIC_PATH.test(path)&&request.method==='GET')return frontend(request,env);
  if(path.startsWith('/api/v1/')){
    const session=await appSession(request,env,ctx,handleAuthV1);
    if(!session)return json(401,{code:'SESSION_REQUIRED'});
    return json(503,{code:'STAGING_BUSINESS_API_NOT_MIGRATED',
      message:'Login dan RBAC staging aktif. Data bisnis belum tersedia di D1 staging; tidak ada data dummy.'});
  }
  if(request.method!=='GET')return json(405,{code:'METHOD_NOT_ALLOWED'});
  const session=await appSession(request,env,ctx,handleAuthV1);
  if(!session)return redirect('/login');
  return frontend(request,env);
}
