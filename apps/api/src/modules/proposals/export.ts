import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, Packer, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow,
  TextRun, WidthType,
} from 'docx';

const PURPLE = '3D1C6B';
const VIOLET = '5B2C9D';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ProposalDoc {
  number: string; title: string; version: number; status: string; language: string; customerName: string; reviewerName?: string | null; reviewedAt?: string | null;
  sections: { seq: number; key: string; title: string; content: string; sources: { label: string }[] }[];
}

type Block = { kind: 'p' | 'bullet' | 'num' | 'h3'; text: string } | { kind: 'table'; rows: string[][] };

/** Parser markdown sederhana: paragraf, "- " bullet, "1. " numbering, "### " sub-judul, tabel pipa. */
export function parseBlocks(content: string): Block[] {
  const out: Block[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (!l.trim()) continue;
    if (/^\s*\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      out.push({ kind: 'table', rows });
    } else if (/^\s*[-*•]\s+/.test(l)) out.push({ kind: 'bullet', text: l.replace(/^\s*[-*•]\s+/, '') });
    else if (/^\s*\d+[.)]\s+/.test(l)) out.push({ kind: 'num', text: l.trim() });
    else if (/^#{2,4}\s+/.test(l)) out.push({ kind: 'h3', text: l.replace(/^#+\s+/, '') });
    else out.push({ kind: 'p', text: l.trim() });
  }
  return out;
}

const runs = (text: string, size = 21) => text.split(/(\*\*[^*]+\*\*|\[PERLU DILENGKAPI\])/g).filter(Boolean).map((t) =>
  t === '[PERLU DILENGKAPI]' ? new TextRun({ text: t, bold: true, color: 'B45309', size, font: 'Calibri', highlight: 'yellow' })
    : t.startsWith('**') ? new TextRun({ text: t.slice(2, -2), bold: true, size, font: 'Calibri' }) : new TextRun({ text: t, size, font: 'Calibri' }));

export async function proposalDocx(p: ProposalDoc): Promise<Buffer> {
  const draft = p.status !== 'REVIEWED';
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D2E9' };
  const children: (Paragraph | Table)[] = [];
  const cover = p.sections.find((s) => s.key === 'cover');
  children.push(
    new Paragraph({ spacing: { before: 2400 }, children: [new TextRun({ text: 'DEFEND IT360', bold: true, color: PURPLE, size: 40, font: 'Calibri' })] }),
    new Paragraph({ children: [new TextRun({ text: 'PT Data Enkripsi Informasi Teknologi · member of XLSMART', color: VIOLET, size: 20, font: 'Calibri' })] }),
    new Paragraph({ spacing: { before: 1200 }, children: [new TextRun({ text: p.language === 'en' ? 'TECHNICAL PROPOSAL' : 'PROPOSAL TEKNIS', bold: true, size: 28, color: VIOLET, font: 'Calibri' })] }),
    new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: p.title, bold: true, size: 44, font: 'Georgia', color: '1D2433' })] }),
    ...(cover ? cover.content.split('\n').filter(Boolean).slice(1).map((l) => new Paragraph({ children: runs(l, 22) })) : []),
    new Paragraph({ spacing: { before: 600 }, children: [new TextRun({ text: `Nomor: ${p.number} · Versi ${p.version}`, size: 20, font: 'Calibri', color: '5D6576' })] }),
    new Paragraph({ children: [new TextRun({ text: draft ? 'STATUS: DRAFT — belum direview teknis' : `Direview oleh ${p.reviewerName ?? '-'} · ${p.reviewedAt ? new Date(p.reviewedAt).toLocaleDateString('id-ID') : ''}`, size: 20, bold: draft, color: draft ? 'B91C1C' : '15803D', font: 'Calibri' })] }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: p.language === 'en' ? 'Table of Contents' : 'Daftar Isi', color: PURPLE, font: 'Calibri' })] }),
    ...p.sections.filter((s) => s.key !== 'cover').map((s, i) => new Paragraph({ children: [new TextRun({ text: `${i + 1}.  ${s.title}`, size: 21, font: 'Calibri' })] })),
    new Paragraph({ children: [new PageBreak()] }),
  );
  p.sections.filter((s) => s.key !== 'cover').forEach((s, idx) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 120 }, children: [new TextRun({ text: `${idx + 1}. ${s.title}`, color: PURPLE, font: 'Calibri', bold: true, size: 28 })] }));
    for (const b of parseBlocks(s.content)) {
      if (b.kind === 'table') {
        const widthPct = Math.floor(100 / Math.max(1, b.rows[0]?.length ?? 1));
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r, ri) => new TableRow({ tableHeader: ri === 0, children: r.map((c) => new TableCell({
            width: { size: widthPct, type: WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border },
            shading: ri === 0 ? { type: ShadingType.CLEAR, fill: PURPLE, color: 'auto' } : undefined,
            children: [new Paragraph({ children: [new TextRun({ text: c, size: 17, font: 'Calibri', bold: ri === 0, color: ri === 0 ? 'FFFFFF' : '1D2433' })] })] })) })) }));
        children.push(new Paragraph({ text: '' }));
      } else if (b.kind === 'bullet') children.push(new Paragraph({ bullet: { level: 0 }, children: runs(b.text) }));
      else if (b.kind === 'h3') children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: b.text, bold: true, color: VIOLET, font: 'Calibri' })] }));
      else children.push(new Paragraph({ spacing: { after: 100 }, children: runs(b.text) }));
    }
    if (s.sources.length) children.push(new Paragraph({ spacing: { before: 80, after: 200 }, children: [new TextRun({ text: `Sumber: ${s.sources.map((x) => x.label).join('; ')}`, italics: true, size: 16, color: '7A8193', font: 'Calibri' })] }));
  });

  const doc = new Document({
    creator: 'ICOP CyberBusiness 360', title: p.title, description: `${p.number} v${p.version}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 1300, bottom: 1200, left: 1300, right: 1300 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
        new TextRun({ text: `DEFEND IT360 · ${p.number}${draft ? ' · DRAFT' : ''} · RAHASIA`, size: 16, color: draft ? 'B91C1C' : '7A8193', font: 'Calibri' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ children: ['Halaman ', PageNumber.CURRENT, ' dari ', PageNumber.TOTAL_PAGES], size: 16, color: '7A8193', font: 'Calibri' })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

export function proposalHtml(p: ProposalDoc): string {
  const draft = p.status !== 'REVIEWED';
  const block = (b: Block) => {
    if (b.kind === 'table') return `<table>${b.rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
    const t = esc(b.text).replace(/\[PERLU DILENGKAPI\]/g, '<mark>[PERLU DILENGKAPI]</mark>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    if (b.kind === 'bullet') return `<li>${t}</li>`;
    if (b.kind === 'h3') return `<h3>${t}</h3>`;
    return `<p>${t}</p>`;
  };
  const body = p.sections.filter((s) => s.key !== 'cover').map((s, i) => {
    const html = parseBlocks(s.content).map(block).join('').replace(/(<li>.*?<\/li>)+/g, (m) => `<ul>${m}</ul>`);
    return `<section><h2>${i + 1}. ${esc(s.title)}</h2>${html}${s.sources.length ? `<div class="src">Sumber: ${s.sources.map((x) => esc(x.label)).join('; ')}</div>` : ''}</section>`;
  }).join('');
  return `<!doctype html><html lang="${p.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.number)} — ${esc(p.title)}</title>
<style>@page{size:A4;margin:18mm 16mm}body{font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#1d2433;font-size:10.5pt;line-height:1.5;margin:0;padding:16px}
.page{max-width:780px;margin:0 auto}.cover{border-bottom:3px solid #3D1C6B;padding:40px 0 24px;margin-bottom:24px;page-break-after:always}
.brand{font-weight:700;color:#3D1C6B;font-size:18pt}.brand small{display:block;font-size:9pt;color:#5B2C9D;font-weight:400}
h1{font-family:Georgia,serif;font-size:22pt;margin:40px 0 8px}h2{color:#3D1C6B;font-size:13pt;border-bottom:1px solid #e3dcef;padding-bottom:4px;margin-top:22px}
h3{color:#5B2C9D;font-size:11pt}table{width:100%;border-collapse:collapse;font-size:8.5pt;margin:8px 0}th{background:#3D1C6B;color:#fff;text-align:left;padding:5px}
td{border-bottom:1px solid #e3dcef;padding:5px;vertical-align:top}mark{background:#fde68a;font-weight:700}.src{font-size:8pt;color:#7a8193;font-style:italic;margin-top:6px}
.st{font-weight:700;color:${draft ? '#b91c1c' : '#15803d'}}.wm{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:80pt;color:rgba(124,63,190,.08);transform:rotate(-24deg);pointer-events:none}
@media(max-width:600px){body{padding:8px}h1{font-size:16pt}}</style></head><body><div class="page">${draft ? '<div class="wm">DRAFT</div>' : ''}
<div class="cover"><div class="brand">DEFEND IT360<small>PT Data Enkripsi Informasi Teknologi · member of XLSMART</small></div>
<h1>${esc(p.title)}</h1><p>Diajukan kepada <b>${esc(p.customerName)}</b></p><p>Nomor ${esc(p.number)} · Versi ${p.version}</p>
<p class="st">${draft ? 'DRAFT — belum direview teknis' : `Direview oleh ${esc(p.reviewerName)} · ${p.reviewedAt ? new Date(p.reviewedAt).toLocaleDateString('id-ID') : ''}`}</p></div>${body}</div></body></html>`;
}
