import { TemplateDef } from './catalog.js';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Rendered { html: string; missing: string[] }

/** Render template: nilai di-escape; field wajib yang kosong → penanda "PERLU DILENGKAPI" (tidak diisi karangan). */
export function renderTemplate(t: TemplateDef, values: Record<string, string | undefined>, approved: boolean, meta: { number?: string } = {}): Rendered {
  const missing: string[] = [];
  const sub = (key: string) => {
    const f = t.fields.find((x) => x.key === key);
    const v = values[key]?.trim();
    if (v) return esc(v).replace(/\n/g, '<br>');
    if (f?.required !== false) missing.push(f?.label ?? key);
    return `<mark class="missing">[PERLU DILENGKAPI: ${esc(f?.label ?? key)}]</mark>`;
  };
  const paras = t.body.split(/\n\s*\n/).map((p) => {
    const lines = p.split('\n').map((line) => line.replace(/\{\{(\w+)\}\}/g, (_m, k) => sub(k)));
    return `<p>${lines.join('<br>')}</p>`;
  });
  const banner = approved ? '' : `<div class="draft">DRAFT — BELUM DISAHKAN LEGAL. Jangan dipakai sebagai dokumen resmi sebelum disahkan Legal ICOP.</div>`;
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
body{font-family:"Times New Roman",serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.5;font-size:12.5pt}
h1{font-size:15pt;text-align:center;margin:8px 0 4px} .meta{text-align:center;font-size:10pt;color:#555;margin-bottom:18px}
p{margin:0 0 10px;text-align:justify} mark.missing{background:#fff3cd;color:#7a4b00;padding:0 3px;font-family:sans-serif;font-size:10pt}
.draft{border:2px solid #b42318;color:#b42318;padding:8px;text-align:center;font:600 10pt sans-serif;margin-bottom:16px}
.foot{margin-top:24px;font-size:9pt;color:#666;border-top:1px solid #ccc;padding-top:6px}
@media print{body{margin:0} .draft{print-color-adjust:exact}}
</style></head><body>
${banner}
<h1>${esc(t.title)}</h1>
<div class="meta">${meta.number ? esc(meta.number) : ''}</div>
${paras.join('\n')}
<div class="foot">Dasar hukum acuan: ${esc(t.legalBasis)} Dokumen ini disusun dari template standar DefendIT360 dan tidak merupakan nasihat hukum.</div>
</body></html>`;
  return { html, missing: [...new Set(missing)] };
}
