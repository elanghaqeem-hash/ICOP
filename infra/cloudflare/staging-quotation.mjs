/**
 * Staging-only quotation DRAFT capture, never a tax invoice, legal offer,
 * approved quotation, or migrated production quotation.
 * Tenanted identity comes exclusively from the D1-authenticated gateway.
 */
const err=(status,code,message)=>new Response(JSON.stringify({code,message}),{
  status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const esc=(x)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(n)=>'Rp '+Number(n||0).toLocaleString('id-ID');
const showDate=(x)=>String(x??'').replace('T',' ').slice(0,19);
const styles="\n:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:#f5f7fb;color:#1e2f4e}\n*{box-sizing:border-box}body{margin:0;min-height:100vh}header{background:#152b52;color:white;padding:16px max(20px,calc((100vw - 1100px)/2))}\nheader .brand{font-weight:800;letter-spacing:.3px}header small{display:block;font-size:11px;color:#b5c8e7;margin-top:3px}\nmain{width:min(100% - 32px,1000px);margin:24px auto 85px}nav{display:flex;flex-wrap:wrap;gap:15px;margin:0 0 24px;align-items:center}nav a{font-size:13px;text-decoration:none;color:#355c92;font-weight:700}\nh1{font-size:clamp(24px,3vw,30px);letter-spacing:-.6px;margin:0 0 7px}h2{font-size:18px;margin:0 0 17px}\n.muted{color:#65748e;font-size:14px;line-height:1.6}.muted.small{font-size:12px}\n.panel{background:white;border:1px solid #e0e6f0;border-radius:15px;padding:24px;margin:20px 0;box-shadow:0 5px 18px #152c5110}\n.notice{padding:14px 16px;background:#f2f5fa;border:1px solid #d8e2ef;border-radius:11px;font-size:13px;line-height:1.6;color:#466284;margin:15px 0}\n.list{display:grid;gap:11px;margin-top:20px}.list a{display:block;text-decoration:none;color:inherit;background:white;border:1px solid #dfe6ef;border-radius:12px;padding:17px}\n.list a:hover{border-color:#92add2}.list strong{display:block;margin-bottom:5px}.tag{display:inline-block;border-radius:30px;background:#eff3fa;padding:4px 11px;font-size:11px;font-weight:700;color:#355786}\n.actions{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;background:#28518e;color:#fff;text-decoration:none;font:inherit;font-size:14px;font-weight:700;border:0;border-radius:10px;padding:13px 18px;cursor:pointer;min-height:45px}\n.btn.secondary{background:#edf2f9;color:#31588b}.btn:disabled{opacity:.65;cursor:wait}\nlabel{display:block;font-size:13px;font-weight:700;color:#344a68;margin:0 0 15px}\ninput,select,textarea{display:block;width:100%;margin-top:8px;padding:12px;border:1px solid #cdd8e6;border-radius:9px;background:#fff;font:inherit;font-size:14px;color:#162d4b;min-height:45px;max-width:100%}\ntextarea{min-height:90px;resize:vertical}input:focus,textarea:focus,select:focus{outline:2px solid #6690cf;outline-offset:2px}\n.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.q-columns{display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:0 14px}\n.quotation-line{background:#f8fafe;border:1px solid #e0e7f1;border-radius:12px;padding:15px;margin:12px 0}\n.q-line-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}.remove-line{border:0;background:transparent;color:#ad4050;font-weight:600;cursor:pointer}\n.total{font-weight:700;text-align:right;padding:16px;background:#eff4fb;border-radius:10px;line-height:1.7}\n.error{min-height:20px;font-size:13px;color:#b53747;margin-top:12px}\n.summary{display:grid;grid-template-columns:1fr 1fr;gap:15px}.summary dt{font-size:12px;color:#6e809a}.summary dd{margin:5px 0 16px;font-size:15px;font-weight:600;overflow-wrap:anywhere}\ntable{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;border-bottom:1px solid #edf0f5;padding:12px 9px}th:last-child,td:last-child{text-align:right}\n.bottom{display:none}\n@media(max-width:680px){main{width:calc(100% - 26px);margin:20px auto 90px}.panel{padding:19px 16px;border-radius:13px}.cols,.q-columns,.summary{grid-template-columns:1fr}.actions .btn{width:100%}nav{gap:12px}.bottom{display:flex;position:fixed;bottom:0;left:0;right:0;justify-content:space-around;gap:8px;background:#fff;border-top:1px solid #dae1eb;padding:12px 8px env(safe-area-inset-bottom);z-index:10}.bottom a{font-size:12px;color:#506581;text-decoration:none}.total{text-align:left}}\n";
const quotationClient="(() => {\n  'use strict';\n  const form=document.getElementById('quotation-form');\n  if(!form)return;\n  const holder=document.getElementById('quotation-lines');\n  const total=document.getElementById('quotation-totals');\n  const notice=document.getElementById('quotation-notice');\n  const submit=document.getElementById('quotation-save');\n  const rupiah=n=>'Rp '+(Number.isFinite(n)?Math.round(n):0).toLocaleString('id-ID');\n  const row=()=>{\n    const div=document.createElement('div');\n    div.className='quotation-line';\n    div.innerHTML='<div class=\"q-line-top\"><b>Item layanan</b><button type=\"button\" class=\"remove-line\" aria-label=\"Hapus baris layanan\">Hapus</button></div>'+\n      '<label>Deskripsi layanan<input name=\"description\" maxlength=\"500\" required placeholder=\"Contoh: Assessment keamanan aplikasi\"></label>'+\n      '<div class=\"q-columns\"><label>Kuantitas<input name=\"quantity\" type=\"number\" min=\"0.01\" max=\"100000\" step=\"0.01\" value=\"1\" inputmode=\"decimal\" required></label>'+\n      '<label>Satuan<input name=\"unit\" maxlength=\"40\" value=\"paket\" required></label>'+\n      '<label>Harga satuan (Rp)<input name=\"unitPrice\" type=\"number\" min=\"0\" max=\"1000000000000\" step=\"1\" value=\"0\" inputmode=\"numeric\" required></label></div>';\n    div.querySelector('.remove-line').addEventListener('click',()=>{if(holder.children.length>1){div.remove();calculate();}});\n    div.querySelectorAll('input').forEach(input=>input.addEventListener('input',calculate));\n    holder.append(div);\n  };\n  const number=name=>Number(form.elements.namedItem(name)?.value||0);\n  function calculate(){\n    let sub=0;\n    holder.querySelectorAll('.quotation-line').forEach(line=>{\n      const qty=Number(line.querySelector('[name=quantity]').value||0);\n      const unit=Number(line.querySelector('[name=unitPrice]').value||0);\n      if(Number.isFinite(qty)&&Number.isFinite(unit))sub+=Math.round(qty*unit);\n    });\n    const disc=Math.max(0,Math.min(99,number('discountPercent')));\n    const tax=Math.max(0,Math.min(25,number('taxPercent')));\n    const discounted=Math.round(sub*disc/100), taxable=sub-discounted, vat=Math.round(taxable*tax/100);\n    total.textContent='Subtotal '+rupiah(sub)+' • Diskon '+rupiah(discounted)+' • Pajak '+rupiah(vat)+' • Total '+rupiah(taxable+vat);\n  }\n  document.getElementById('add-line').addEventListener('click',()=>{if(holder.children.length<30){row();calculate();}});\n  form.elements.namedItem('discountPercent').addEventListener('input',calculate);\n  form.elements.namedItem('taxPercent').addEventListener('input',calculate);\n  row();calculate();\n  const submissionKey=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);\n  form.addEventListener('submit',async(event)=>{\n    event.preventDefault();\n    if(submit.disabled)return;\n    notice.textContent='';\n    const lines=[...holder.querySelectorAll('.quotation-line')].map(el=>({\n      description:el.querySelector('[name=description]').value.trim(),\n      quantity:Number(el.querySelector('[name=quantity]').value),\n      unit:el.querySelector('[name=unit]').value.trim(),\n      unitPrice:Number(el.querySelector('[name=unitPrice]').value)\n    }));\n    const data={\n      submissionKey,customerName:form.elements.namedItem('customerName').value.trim(),\n      customerEmail:form.elements.namedItem('customerEmail').value.trim(),\n      opportunityRef:form.elements.namedItem('opportunityRef').value.trim(),\n      serviceCategory:form.elements.namedItem('serviceCategory').value,\n      title:form.elements.namedItem('title').value.trim(),\n      scopeSummary:form.elements.namedItem('scopeSummary').value.trim(),\n      discountPercent:number('discountPercent'),\n      taxPercent:number('taxPercent'),\n      validityDays:number('validityDays'),\n      paymentTerms:form.elements.namedItem('paymentTerms').value.trim(),\n      deliveryTerms:form.elements.namedItem('deliveryTerms').value.trim(),\n      exclusions:form.elements.namedItem('exclusions').value.trim(),\n      lines\n    };\n    submit.disabled=true;submit.textContent='Menyimpan draft…';\n    try{\n      const response=await fetch('/api/v1/quotation-drafts',{\n        method:'POST',credentials:'same-origin',cache:'no-store',\n        headers:{'content-type':'application/json','x-icop-request-id':submissionKey},\n        body:JSON.stringify(data)\n      });\n      const result=await response.json().catch(()=>({}));\n      if(!response.ok){\n        if(response.status===401){location.assign('/login');return;}\n        notice.textContent=result.message||'Penyimpanan gagal. Periksa isian dan coba lagi.';\n        notice.setAttribute('role','alert');return;\n      }\n      notice.textContent='Draft berhasil disimpan.';notice.setAttribute('role','status');\n      location.assign('/quotations/'+encodeURIComponent(result.id));\n    }catch{notice.textContent='Koneksi gagal. Periksa jaringan lalu coba lagi.';notice.setAttribute('role','alert');}\n    finally{submit.disabled=false;submit.textContent='Simpan Draft Quotation';}\n  });\n})();";
;
const layout=(title,content)=>new Response([
  '<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>',
  '<title>',esc(title),' · ICOP</title><style>',styles,'</style></head><body>',
  '<header><div class="brand">ICOP <small>CYBERBUSINESS 360 · STAGING</small></div></header>',
  '<main><nav><a href="/">Dashboard</a><a href="/pipeline">Pipeline</a><a href="/quotations">Quotation</a>',
  '<a href="/quotations/new">+ Buat Draft</a></nav>',content,
  '</main><div class="bottom"><a href="/">Dashboard</a><a href="/pipeline">Pipeline</a>',
  '<a href="/quotations">Quotation</a><a href="/quotations/new">+ Draft Baru</a></div></body></html>'
].join(''),{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
const services=['Cybersecurity Governance','Offensive Cybersecurity','Defense Cybersecurity','Cybersecurity Technology'];
const validText=(s,min,max)=>typeof s==='string'&&s.trim().length>=min&&s.trim().length<=max;
const optional=(s,max)=>s===undefined||s===null||(typeof s==='string'&&s.trim().length<=max);
const num=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
const moneySafe=(x)=>Number.isSafeInteger(x)&&x>=0&&x<=100000000000000;
function validate(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return 'Permintaan tidak valid.';
  if(!validText(data.submissionKey,8,80)||!/^[a-zA-Z0-9_-]{8,80}$/.test(data.submissionKey))return 'Identitas penyimpanan tidak valid.';
  if(!validText(data.customerName,2,160))return 'Nama pelanggan wajib diisi.';
  if(!optional(data.customerEmail,160)||data.customerEmail&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customerEmail)))return 'Email kontak pelanggan tidak valid.';
  if(!optional(data.opportunityRef,100)||!services.includes(data.serviceCategory))return 'Kategori layanan atau referensi tidak valid.';
  if(!validText(data.title,3,200)||!optional(data.scopeSummary,2000))return 'Judul atau ruang lingkup tidak valid.';
  if(!Array.isArray(data.lines)||data.lines.length<1||data.lines.length>30)return 'Isi minimal satu dan maksimal 30 baris layanan.';
  if(!num(data.discountPercent,0,99)||!num(data.taxPercent,0,25)||
    Math.abs(Math.round(data.discountPercent*100)-data.discountPercent*100)>1e-6||
    Math.abs(Math.round(data.taxPercent*100)-data.taxPercent*100)>1e-6)return 'Diskon dan pajak maksimum dua angka desimal.';
  if(!Number.isInteger(data.validityDays)||data.validityDays<7||data.validityDays>180)return 'Masa berlaku 7–180 hari.';
  if(!validText(data.paymentTerms,3,500)||!optional(data.deliveryTerms,1000)||!optional(data.exclusions,2000))
    return 'Termin atau ketentuan tambahan tidak valid.';
  let subtotal=0;
  const items=[];
  for(const line of data.lines){
    if(!line||!validText(line.description,2,500)||!validText(line.unit,1,40)||
       !num(line.quantity,0.01,100000)||!num(line.unitPrice,0,1000000000000)||
       !Number.isInteger(line.unitPrice)||Math.abs(Math.round(line.quantity*100)-line.quantity*100)>1e-6)
      return 'Uraian, kuantitas, satuan, atau harga baris tidak valid.';
    const amount=Math.round(line.quantity*line.unitPrice);
    if(!moneySafe(amount))return 'Harga item terlalu besar.';
    subtotal+=amount;
    if(!moneySafe(subtotal))return 'Total terlalu besar.';
    items.push({description:line.description.trim(),quantity:line.quantity,unit:line.unit.trim(),unitPrice:line.unitPrice,amount});
  }
  const discountAmount=Math.round(subtotal*data.discountPercent/100);
  const taxableAmount=subtotal-discountAmount;
  const taxAmount=Math.round(taxableAmount*data.taxPercent/100);
  const grandTotal=taxableAmount+taxAmount;
  if(![discountAmount,taxableAmount,taxAmount,grandTotal].every(moneySafe))return 'Total quotation tidak valid.';
  return {items,subtotal,discountAmount,taxableAmount,taxAmount,grandTotal};
}
const qsql='SELECT id,customer_name,title,service_category,grand_total,tax_percent,created_at,status,source FROM staging_quotation_drafts WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 100';
async function tenant(env){
  return env.DB.prepare("SELECT id FROM tenants WHERE code='DEIT' LIMIT 1").first();
}
async function renderList(env,me){
  const t=await tenant(env);if(!t)return err(503,'TENANT_NOT_READY','Tenant DEIT belum tersedia.');
  const result=await env.DB.prepare(qsql).bind(t.id).all();
  const records=result.results||[];
  const list=records.length?'<div class="list">'+records.map(r=>
    '<a href="/quotations/'+encodeURIComponent(r.id)+'"><div class="actions"><strong>'+esc(r.title)+'</strong><span class="tag">DRAFT</span></div>'+
    '<div class="muted">'+esc(r.customer_name)+' · '+esc(r.service_category)+' · '+money(r.grand_total)+' · '+esc(showDate(r.created_at))+'</div></a>'
  ).join('')+'</div>':'<div class="panel"><p class="muted">Belum ada draft quotation. Klik <b>+ Buat Quotation</b> untuk memulai.</p></div>';
  return layout('Quotation','<div class="actions"><div><h1>Quotation</h1><p class="muted">Draft penawaran yang tersimpan di database staging.</p></div>'+
    '<a class="btn" href="/quotations/new">+ Buat Quotation</a></div>'+
    '<div class="notice">Data pelanggan dan layanan pada modul ini diisi manual dan belum ditautkan ke master CRM atau pricing scenario. Draft tidak dapat diterbitkan atau di-approve sampai diverifikasi.</div>'+list);
}
function renderForm(){
  const categories=services.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
  return layout('Buat Quotation','<div class="actions"><div><h1>Form Quotation</h1>'+
    '<p class="muted">Buat quotation draft berdasarkan informasi pelanggan dan ruang lingkup asli.</p></div>'+
    '<a class="btn secondary" href="/quotations">Kembali ke daftar</a></div>'+
    '<div class="notice">Status otomatis <strong>DRAFT</strong>. Harga dan pajak perlu ditinjau; form ini tidak menerbitkan surat resmi dan belum terhubung ke approval.</div>'+
    '<form id="quotation-form"><section class="panel"><h2>1. Pelanggan dan pekerjaan</h2><div class="cols">'+
    '<label>Nama perusahaan / pelanggan *<input name="customerName" maxlength="160" placeholder="Masukkan nama pelanggan" required></label>'+
    '<label>Email kontak pelanggan (opsional)<input name="customerEmail" type="email" maxlength="160" placeholder="kontak@perusahaan.com"></label>'+
    '<label>Referensi deal / peluang (opsional)<input name="opportunityRef" maxlength="100" placeholder="Nomor peluang jika tersedia"></label>'+
    '<label>Pilar layanan *<select name="serviceCategory" required>'+categories+'</select></label></div>'+
    '<label>Judul quotation *<input name="title" maxlength="200" placeholder="Contoh: Assessment Keamanan Siber Tahunan" required></label>'+
    '<label>Ruang lingkup pekerjaan<textarea name="scopeSummary" maxlength="2000" placeholder="Uraian singkat layanan dan deliverables"></textarea></label></section>'+
    '<section class="panel"><h2>2. Item layanan dan harga (IDR)</h2>'+
    '<div id="quotation-lines"></div><button type="button" id="add-line" class="btn secondary">+ Tambah item layanan</button></section>'+
    '<section class="panel"><h2>3. Perhitungan dan ketentuan</h2><div class="cols">'+
    '<label>Diskon (%)<input type="number" name="discountPercent" min="0" max="99" step="0.01" value="0" required></label>'+
    '<label>Pajak (%) — isi sesuai ketentuan transaksi<input type="number" name="taxPercent" min="0" max="25" step="0.01" value="0" required></label>'+
    '<label>Masa berlaku (hari)<input type="number" name="validityDays" min="7" max="180" step="1" value="30" required></label>'+
    '<label>Termin pembayaran *<input name="paymentTerms" maxlength="500" value="Termin pembayaran akan disepakati" required></label></div>'+
    '<label>Ketentuan pelaksanaan<textarea name="deliveryTerms" maxlength="1000"></textarea></label>'+
    '<label>Pengecualian<textarea name="exclusions" maxlength="2000"></textarea></label>'+
    '<div id="quotation-totals" class="total" aria-live="polite"></div></section>'+
    '<div class="actions"><a href="/quotations" class="btn secondary">Batal</a>'+
    '<button class="btn" id="quotation-save" type="submit">Simpan Draft Quotation</button></div>'+
    '<div id="quotation-notice" class="error" aria-live="polite"></div></form>'+
    '<script src="/__icop/quotation.js" defer></script>');
}
async function renderDetail(env,id){
  const t=await tenant(env);if(!t)return err(503,'TENANT_NOT_READY','Tenant belum tersedia.');
  const q=await env.DB.prepare('SELECT * FROM staging_quotation_drafts WHERE id=? AND tenant_id=? LIMIT 1').bind(id,t.id).first();
  if(!q)return err(404,'NOT_FOUND','Draft quotation tidak ditemukan.');
  const lines=JSON.parse(q.lines_json);
  const rows=lines.map((line,i)=>'<tr><td>'+String(i+1)+'</td><td>'+esc(line.description)+'</td><td>'+
    esc(line.quantity)+' '+esc(line.unit)+'</td><td>'+money(line.unitPrice)+'</td><td>'+money(line.amount)+'</td></tr>').join('');
  return layout('Draft Quotation','<div class="actions"><div><h1>'+esc(q.title)+'</h1>'+
    '<p class="muted">Dibuat '+esc(showDate(q.created_at))+' · '+esc(q.service_category)+'</p></div>'+
    '<span class="tag">DRAFT · BELUM DIVERIFIKASI</span></div>'+
    '<div class="notice">Draft internal, bukan surat penawaran sah. Data pelanggan belum diverifikasi dengan CRM. Belum ada mekanisme approval, nomor penawaran, atau pengiriman pelanggan.</div>'+
    '<section class="panel"><div class="summary"><dl><dt>Pelanggan</dt><dd>'+esc(q.customer_name)+'</dd>'+
    '<dt>Email kontak</dt><dd>'+esc(q.customer_email||'—')+'</dd>'+
    '<dt>Referensi peluang</dt><dd>'+esc(q.opportunity_ref||'—')+'</dd></dl>'+
    '<dl><dt>Masa berlaku</dt><dd>'+esc(q.validity_days)+' hari</dd>'+
    '<dt>Kategori</dt><dd>'+esc(q.service_category)+'</dd>'+
    '<dt>Sumber</dt><dd>Input manual — perlu validasi</dd></dl></div>'+
    '<h2>Ruang lingkup</h2><p class="muted">'+esc(q.scope_summary||'Belum diisi')+'</p></section>'+
    '<section class="panel"><h2>Rincian layanan</h2><div style="overflow-x:auto"><table><thead>'+
    '<tr><th>#</th><th>Uraian</th><th>Kuantitas</th><th>Harga satuan</th><th>Total</th></tr>'+
    '</thead><tbody>'+rows+'</tbody></table></div>'+
    '<div class="total">Subtotal '+money(q.subtotal)+' · Diskon '+money(q.discount_amount)+' · Pajak '+money(q.tax_amount)+
    '<br>Total draft '+money(q.grand_total)+'</div></section>'+
    '<section class="panel"><h2>Ketentuan</h2><p class="muted">Pembayaran: '+esc(q.payment_terms)+'</p>'+
    '<p class="muted">Pelaksanaan: '+esc(q.delivery_terms||'—')+'</p>'+
    '<p class="muted">Pengecualian: '+esc(q.exclusions||'—')+'</p></section>'+
    '<a class="btn secondary" href="/quotations">Kembali ke daftar</a>');
}
async function create(env,request,me){
  const origin=new URL(request.url).origin;
  if(request.headers.get('origin')!==origin||request.headers.get('sec-fetch-site')==='cross-site')
    return err(403,'ORIGIN_REQUIRED','Asal permintaan tidak valid.');
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
    return err(415,'JSON_REQUIRED','Gunakan JSON.');
  if(Number(request.headers.get('content-length')||0)>50000)return err(413,'BODY_TOO_LARGE','Form terlalu besar.');
  let data;
  try{const str=await request.text();if(str.length>50000)throw Error('large');data=JSON.parse(str);}
  catch{return err(400,'INVALID_JSON','Payload tidak valid.');}
  const computed=validate(data);
  if(typeof computed==='string')return err(422,'VALIDATION_FAILED',computed);
  const t=await tenant(env);if(!t)return err(503,'TENANT_NOT_READY','Tenant belum tersedia.');
  // A verified authenticated owner and tenant are supplied only by the gateway.
  const id=crypto.randomUUID();
  const args=[id,t.id,me.id,data.submissionKey,data.customerName.trim(),
    data.customerEmail?.trim()||null,data.opportunityRef?.trim()||null,
    data.serviceCategory,data.title.trim(),data.scopeSummary?.trim()||null,
    JSON.stringify(computed.items),data.discountPercent,data.taxPercent,
    computed.subtotal,computed.discountAmount,computed.taxableAmount,computed.taxAmount,computed.grandTotal,
    data.validityDays,data.paymentTerms.trim(),data.deliveryTerms?.trim()||null,data.exclusions?.trim()||null];
  try{
    const result=await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO staging_quotation_drafts (id,tenant_id,owner_user_id,submission_key,customer_name,customer_email,opportunity_ref,service_category,title,scope_summary,lines_json,discount_percent,tax_percent,subtotal,discount_amount,taxable_amount,tax_amount,grand_total,validity_days,payment_terms,delivery_terms,exclusions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(...args),
      env.DB.prepare("INSERT INTO audit_events (tenant_id,actor_id,action,entity_type,entity_id,after_json) SELECT ?,?,'quotation.staging_draft_created','staging_quotation_draft',?,? WHERE EXISTS (SELECT 1 FROM staging_quotation_drafts WHERE id=? AND tenant_id=?)")
        .bind(t.id,me.id,id,JSON.stringify({source:'MANUAL_UNVERIFIED',status:'DRAFT',grandTotal:computed.grandTotal}),id,t.id)
    ]);
    if(result?.[0]?.meta?.changes===1&&result?.[1]?.meta?.changes===1)
      return new Response(JSON.stringify({id,status:'DRAFT',grandTotal:computed.grandTotal}),{
        status:201,headers:{'content-type':'application/json','cache-control':'no-store'}});
    // Idempotent retry: return the original draft only if it belongs to this actor.
    const prior=await env.DB.prepare('SELECT id,grand_total FROM staging_quotation_drafts WHERE tenant_id=? AND owner_user_id=? AND submission_key=? LIMIT 1')
      .bind(t.id,me.id,data.submissionKey).first();
    if(prior)return new Response(JSON.stringify({id:prior.id,status:'DRAFT',grandTotal:prior.grand_total}),{
      status:200,headers:{'content-type':'application/json','cache-control':'no-store'}});
    return err(503,'WRITE_UNCONFIRMED','Penyimpanan draft belum terkonfirmasi.');
  }catch{return err(503,'DRAFT_STORAGE_UNAVAILABLE','Penyimpanan draft sedang tidak tersedia.');}
}
export async function handleStagingQuotation(request,env,session){
  const path=new URL(request.url).pathname;
  const relevant=path==='/quotations'||path==='/quotations/new'||
    /^\/quotations\/[0-9a-f-]{36}$/.test(path)||path==='/__icop/quotation.js'||
    path==='/api/v1/quotation-drafts';
  if(!relevant)return null;
  const me=await session();
  const isApi=path.startsWith('/api/');
  if(!me||me.role!=='super_admin'||me.email!=='elang.haqeem@gmail.com'||
    !(me.permissions||[]).includes('quotation.read'))
    return isApi?err(401,'SESSION_REQUIRED','Login diperlukan.'):
      new Response(null,{status:303,headers:{location:'/login','cache-control':'no-store'}});
  if(path==='/__icop/quotation.js'&&request.method==='GET')
    return new Response(quotationClient,{status:200,headers:{'content-type':'application/javascript; charset=utf-8',
      'cache-control':'no-store','x-content-type-options':'nosniff'}});
  if(path==='/quotations'&&request.method==='GET'){
    try{return await renderList(env,me);}
    catch{return err(503,'DRAFT_SCHEMA_NOT_READY','Database draft quotation belum tersedia.');}
  }
  if(path==='/quotations/new'&&request.method==='GET')return renderForm();
  if(/^\/quotations\/[0-9a-f-]{36}$/.test(path)&&request.method==='GET'){
    try{return await renderDetail(env,path.slice('/quotations/'.length));}
    catch{return err(503,'DRAFT_STORAGE_UNAVAILABLE','Draft tidak dapat dibuka.');}
  }
  if(path==='/api/v1/quotation-drafts'&&request.method==='POST'){
    if(!(me.permissions||[]).includes('quotation.write'))return err(403,'PERMISSION_DENIED','Tidak berwenang.');
    return create(env,request,me);
  }
  return err(405,'METHOD_NOT_ALLOWED','Metode tidak diizinkan.');
}
