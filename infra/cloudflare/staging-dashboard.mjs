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

const LOGIN_JS = String.raw`(() => {
  const form=document.getElementById('icop-login-form');
  const result=document.getElementById('login-status');
  const submit=document.getElementById('login-submit');
  const show=document.getElementById('show-password');
  const password=document.getElementById('icop-password');
  show.addEventListener('click',()=>{
    password.type=password.type==='password'?'text':'password';
    show.setAttribute('aria-pressed',String(password.type==='text'));
    show.textContent=password.type==='text'?'Sembunyikan':'Lihat';
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(submit.disabled)return;
    const email=document.getElementById('icop-email').value.trim().toLowerCase();
    const value=password.value;
    submit.disabled=true;submit.textContent='Memverifikasi…';
    result.textContent='Menghubungkan ke ICOP…';result.setAttribute('role','status');
    try{
      const res=await fetch('/api/v1/auth/login',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({tenant:'DEIT',email,password:value})
      });
      const data=await res.json().catch(()=>({}));
      if(res.ok&&data.applicationAuthenticated===true&&data.mfaVerified===true&&
         data.user?.role==='super_admin'){
        password.value='';
        window.location.replace('/');
        return;
      }
      const messages={
        INVALID_CREDENTIALS:'Email atau password tidak sesuai.',
        ACCOUNT_TEMPORARILY_LOCKED:'Akun terkunci sementara. Coba lagi setelah 15 menit.',
        CLOUDFLARE_ACCESS_VERIFIED_IDENTITY_REQUIRED:'Verifikasi Cloudflare Access diperlukan.',
        STAGING_AUTH_GATES_PENDING:'Layanan autentikasi masih dalam validasi.'
      };
      result.textContent=messages[data.code]||'Login gagal. Periksa akses Cloudflare dan coba lagi.';
      result.setAttribute('role','alert');
    }catch{
      result.textContent='Koneksi terputus. Periksa jaringan, kemudian ulangi.';
      result.setAttribute('role','alert');
    }finally{
      submit.disabled=false;
      submit.textContent='Masuk ke ICOP';
    }
  });
})();`;
function loginPage(){
  const html=String.raw`<!doctype html>
<html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/><title>Masuk · ICOP CyberBusiness 360</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#192c48;background:#f4f6fa}
*{box-sizing:border-box}body{margin:0;min-height:100vh}.layout{min-height:100vh;display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,540px)}
.brand{background:linear-gradient(150deg,#142747,#263b6e 65%,#273a73);color:white;padding:clamp(32px,5vw,72px);display:flex;flex-direction:column;justify-content:space-between}
.logo{font-weight:800;font-size:24px;letter-spacing:-.5px}.logo small{display:block;font-size:10px;letter-spacing:2px;font-weight:600;color:#a8c6e9}
.brand-message{max-width:500px}.brand-message h1{font-size:clamp(29px,3vw,45px);font-weight:700;line-height:1.16;letter-spacing:-1.2px;margin-bottom:20px}.brand-message p{color:#c6d1e4;max-width:430px;line-height:1.65}
.brand-foot{font-size:12px;color:#aebdda}.side{display:flex;justify-content:center;align-items:center;padding:28px clamp(20px,4vw,62px)}
.card{width:100%;max-width:430px;background:white;border:1px solid #e5e8f0;border-radius:18px;padding:clamp(26px,3vw,40px);box-shadow:0 10px 45px #1326470c}
.tag{font-size:11px;font-weight:700;letter-spacing:1px;color:#355b9a;text-transform:uppercase}
h2{font-size:26px;letter-spacing:-.6px;margin:18px 0 10px}p{font-size:14px;line-height:1.6;color:#65748b;margin:0 0 22px}
label{display:block;font-size:13px;font-weight:700;margin:18px 0 9px}.field{width:100%;height:48px;border:1px solid #cfd9e7;border-radius:10px;padding:0 13px;font:inherit;font-size:15px;background:white;color:#1d304c}
.field:focus{outline:2px solid #5c8ed3;outline-offset:2px}.field[readonly]{background:#f6f8fb;color:#465b76}
.pw-wrap{display:flex;position:relative}.pw-wrap input{padding-right:100px}.show{position:absolute;right:8px;top:8px;background:transparent;border:0;font-weight:600;color:#345581;padding:6px;cursor:pointer}
button[type=submit]{background:#274b85;color:white;border:0;width:100%;height:49px;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;margin-top:24px}
button:disabled{opacity:.65;cursor:wait}.message{min-height:20px;color:#aa3544;margin-top:12px;font-size:13px}
.note{border-top:1px solid #edf0f5;padding-top:18px;color:#728099;font-size:12px;line-height:1.65;margin-top:10px}
@media(max-width:760px){.layout{grid-template-columns:1fr}.brand{padding:25px 24px 18px;min-height:132px}.brand-message,.brand-foot{display:none}.side{align-items:flex-start;padding:20px 16px 32px}.card{padding:26px 24px;border-radius:15px;box-shadow:0 8px 24px #1326470a}h2{font-size:24px}}
</style><script src="/__icop/login.js" defer></script></head>
<body><div class="layout"><section class="brand" aria-label="ICOP"><div class="logo">ICOP <small>CYBERBUSINESS 360</small></div>
<div class="brand-message"><h1>Selamat datang kembali di ICOP.</h1><p>Kelola pekerjaan cybersecurity, pelanggan, tender, dan layanan dalam satu workspace perusahaan.</p></div>
<div class="brand-foot">DEFENDIT360 · INTERNAL WORKSPACE</div></section>
<main class="side"><div class="card"><span class="tag">Staging · Cloudflare Access + MFA</span><h2>Masuk ke ICOP</h2>
<p>Akses hanya untuk administrator yang telah diverifikasi melalui Cloudflare Access.</p>
<form id="icop-login-form" autocomplete="on"><label for="icop-email">Alamat email</label>
<input class="field" id="icop-email" name="email" type="email" autocomplete="username" value="elang.haqeem@gmail.com" readonly required/>
<label for="icop-password">Kata sandi</label><div class="pw-wrap">
<input class="field" id="icop-password" name="password" type="password" autocomplete="current-password" placeholder="Masukkan password baru" required/>
<button type="button" class="show" id="show-password" aria-pressed="false">Lihat</button></div>
<button id="login-submit" type="submit">Masuk ke ICOP</button><div id="login-status" class="message" aria-live="polite"></div></form>
<div class="note">Akses ini dilindungi Cloudflare Access, MFA, dan sesi aman 30 menit. Modul bisnis staging yang belum dimigrasikan tidak akan menampilkan data tiruan.</div>
</div></main></div></body></html>`;
  return new Response(html,{status:200,headers:{'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store','x-frame-options':'DENY','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}

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
    return session?redirect('/'):loginPage();
  }
  if(path==='/__icop/login.js'&&request.method==='GET')return new Response(LOGIN_JS,{
    status:200,headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}
  });
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
