const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const idr = (n: unknown) => 'Rp ' + Number(n ?? 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const dateId = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }) : '—');

interface QuotationDoc {
  number: string; revision: number; title: string; status: string; customerName: string; customerAddress?: string; customerCity?: string;
  subtotal: number; discountPct: number; discountAmount: number; totalBeforeTax: number; taxRate: number; taxAmount: number; grandTotal: number;
  validityDays: number; paymentTerms: string; deliveryTerms?: string; exclusions?: string; issuedAt?: string; createdAt: string;
  issuedByName?: string; lines: { lineNo: number; description: string; qty: number; unit: string; unitPrice: number; amount: number }[];
}

/** Surat penawaran eksternal. Tidak pernah menerima/menampilkan cost, floor, atau margin. */
export function renderQuotationHtml(q: QuotationDoc): string {
  const official = ['ISSUED', 'SENT', 'ACCEPTED'].includes(q.status);
  const number = `${q.number}${q.revision > 0 ? ` Rev.${q.revision}` : ''}`;
  const rows = q.lines.map((l) => `<tr><td class="c">${l.lineNo}</td><td>${esc(l.description)}</td><td class="r">${Number(l.qty).toLocaleString('id-ID')}</td>
      <td>${esc(l.unit)}</td><td class="r">${idr(l.unitPrice)}</td><td class="r">${idr(l.amount)}</td></tr>`).join('');
  const mobileRows = q.lines.map((l) => `<article class="line-card">
    <div class="line-card-heading"><span class="line-number">Item ${l.lineNo}</span><strong>${esc(l.description)}</strong></div>
    <dl><div><dt>Volume</dt><dd>${Number(l.qty).toLocaleString('id-ID')} ${esc(l.unit)}</dd></div>
    <div><dt>Harga satuan</dt><dd>${idr(l.unitPrice)}</dd></div></dl>
    <div class="line-card-total"><span>Total item</span><b>${idr(l.amount)}</b></div>
  </article>`).join('');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Penawaran ${esc(number)}</title>
<style>
@page{size:A4;margin:18mm 16mm}
*{box-sizing:border-box}body{font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#1d2433;font-size:10.5pt;line-height:1.45;margin:0;padding:16px;background:#fff}
.page{max-width:780px;margin:0 auto;position:relative}
.hdr{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #3D1C6B;padding-bottom:8px;margin-bottom:18px}
.brand{font-weight:700;font-size:15pt;color:#3D1C6B;letter-spacing:.5px}.brand small{display:block;font-weight:400;font-size:8pt;color:#5B2C9D}
.meta{text-align:right;font-size:9pt;color:#4a5263}
h1{font-size:13pt;color:#3D1C6B;margin:18px 0 6px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:9.5pt}th{background:#3D1C6B;color:#fff;text-align:left;padding:6px;font-weight:600}
td{padding:6px;border-bottom:1px solid #e3dcef;vertical-align:top}.r{text-align:right;white-space:nowrap}.c{text-align:center}
.tot td{border:none;padding:3px 6px}.tot .g td{font-weight:700;border-top:2px solid #3D1C6B;font-size:11pt}
.terms{background:#f6f2fc;border-left:3px solid #7C3FBE;padding:10px 12px;margin:14px 0;font-size:9.5pt}
.terms div{margin:3px 0}.sig{margin-top:36px;width:260px}.sig .line{border-top:1px solid #1d2433;margin-top:64px;padding-top:4px}
.wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:72pt;color:rgba(124,63,190,.10);transform:rotate(-24deg);font-weight:700;pointer-events:none}
.foot{margin-top:28px;font-size:8pt;color:#6b7180;border-top:1px solid #e3dcef;padding-top:6px}
@media (max-width:600px){body{padding:8px;font-size:10pt}.hdr{flex-direction:column;align-items:flex-start;gap:6px}.meta{text-align:left}table{font-size:8.5pt}}
/* Mobile-readable line items, without changing the formal A4 print layout. */
.line-cards{display:none}.line-table{width:100%}
.page,.hdr,.terms,.line-card{min-width:0;max-width:100%}
.page{overflow-wrap:anywhere}.line-table table{table-layout:auto}
.line-table td:nth-child(2){overflow-wrap:anywhere;word-break:normal}
.line-card{border:1px solid #e2e5ec;border-radius:10px;background:#fff;padding:12px;margin:0 0 10px;box-shadow:0 1px 2px rgba(20,33,61,.04)}
.line-card-heading{display:grid;gap:5px}.line-number{color:#5b2c9d;font-size:9pt;font-weight:700}
.line-card-heading strong{font-size:11pt;line-height:1.4;color:#1d2433}
.line-card dl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.line-card dt{font-size:9pt;color:#687386}.line-card dd{margin:2px 0 0;font-weight:600;overflow-wrap:anywhere}
.line-card-total{display:flex;justify-content:space-between;gap:12px;align-items:baseline;border-top:1px solid #e2e5ec;padding-top:10px}
.line-card-total span{font-size:9pt;color:#687386}.line-card-total b{color:#3D1C6B;white-space:nowrap}
@media screen and (max-width:640px){
 html,body{width:100%;max-width:100%;overflow-x:hidden}
 body{padding:12px 10px;font-size:10pt}
 .page{width:100%;margin:0 auto}
 .hdr{flex-direction:column;align-items:flex-start;gap:8px}
 .meta{text-align:left;max-width:100%;overflow-wrap:anywhere}
 .brand{font-size:14pt}.brand small{letter-spacing:0;line-height:1.5}
 h1{font-size:12pt;line-height:1.35;overflow-wrap:anywhere}
 .line-table{display:none}.line-cards{display:block;margin:12px 0 14px}
 .tot{width:100%;font-size:9pt;table-layout:auto}
 .tot td{padding:6px 3px}.tot td:first-child{white-space:normal;text-align:left!important}
 .tot td:last-child{text-align:right;white-space:nowrap}
 .terms{padding:10px}.sig{max-width:100%}.foot{overflow-wrap:anywhere}
}
@media print{
 body{padding:0!important;overflow:visible!important;font-size:10.5pt}
 .page{max-width:none;overflow:visible}
 .line-table{display:block!important}.line-cards{display:none!important}
 table{break-inside:auto}tr{break-inside:avoid}
 .terms,.hdr,.sig{break-inside:avoid}
}
</style></head><body><div class="page">
${official ? '' : `<div class="wm">DRAFT — ${esc(q.status)}</div>`}
<div class="hdr"><div class="brand">DEFEND IT360<small>PT Data Enkripsi Informasi Teknologi · member of XLSMART</small></div>
<div class="meta">No: <b>${esc(number)}</b><br>Jakarta, ${dateId(q.issuedAt ?? q.createdAt)}</div></div>
<div>Kepada Yth.<br><b>${esc(q.customerName)}</b><br>${esc(q.customerAddress ?? '')}${q.customerCity ? ', ' + esc(q.customerCity) : ''}</div>
<h1>Perihal: Penawaran Harga — ${esc(q.title)}</h1>
<p>Dengan hormat,<br>Bersama ini kami sampaikan penawaran harga untuk kebutuhan Bapak/Ibu dengan rincian sebagai berikut:</p>
<div class="line-table"><table><thead><tr><th class="c">No</th><th>Uraian</th><th class="r">Qty</th><th>Satuan</th><th class="r">Harga Satuan</th><th class="r">Jumlah</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="line-cards" aria-label="Rincian penawaran">${mobileRows}</div>
<table class="tot"><tbody>
<tr><td class="r" style="width:75%">Subtotal</td><td class="r">${idr(q.subtotal)}</td></tr>
${Number(q.discountPct) > 0 ? `<tr><td class="r">Diskon (${Number(q.discountPct).toLocaleString('id-ID')}%)</td><td class="r">− ${idr(q.discountAmount)}</td></tr>` : ''}
<tr><td class="r">Total sebelum PPN</td><td class="r">${idr(q.totalBeforeTax)}</td></tr>
<tr><td class="r">PPN ${Number(q.taxRate).toLocaleString('id-ID')}%</td><td class="r">${idr(q.taxAmount)}</td></tr>
<tr class="g"><td class="r">TOTAL</td><td class="r">${idr(q.grandTotal)}</td></tr></tbody></table>
<div class="terms"><div><b>Masa berlaku:</b> ${q.validityDays} hari sejak tanggal surat</div><div><b>Termin pembayaran:</b> ${esc(q.paymentTerms)}</div>
${q.deliveryTerms ? `<div><b>Ketentuan pelaksanaan:</b> ${esc(q.deliveryTerms)}</div>` : ''}
${q.exclusions ? `<div><b>Tidak termasuk:</b> ${esc(q.exclusions)}</div>` : ''}
<div><b>Penerimaan:</b> melalui Customer Portal, PO, atau surat penerimaan yang ditandatangani pejabat berwenang.</div></div>
<p>Demikian penawaran ini kami sampaikan. Atas perhatian dan kerja samanya kami ucapkan terima kasih.</p>
<div class="sig">Hormat kami,<br><b>PT Data Enkripsi Informasi Teknologi</b><div class="line">${esc(official ? q.issuedByName ?? 'Pejabat Berwenang' : '(belum diterbitkan)')}</div></div>
<div class="foot">Sudirman 78 Building Tower 01 Lt 27, Jl. Jenderal Sudirman No. 10, Jakarta Pusat 10220 · Dokumen dihasilkan oleh ICOP CyberBusiness 360 · ${esc(number)}</div>
</div></body></html>`;
}
