import { describe, expect, it } from 'vitest';
import { renderQuotationHtml } from '../src/modules/quotations/render.js';

const quotation = {
  number: 'QT-TEST-001',
  revision: 0,
  title: 'Mobile & Internet Banking VAPT',
  status: 'DRAFT',
  customerName: 'Contoh Bank',
  subtotal: 85000000,
  discountPct: 0,
  discountAmount: 0,
  totalBeforeTax: 85000000,
  taxRate: 11,
  taxAmount: 9350000,
  grandTotal: 94350000,
  validityDays: 14,
  paymentTerms: 'Sesuai kesepakatan',
  createdAt: '2026-10-20T00:00:00.000Z',
  lines: [{
    lineNo: 1,
    description: 'Penetration Testing Mobile Banking (Android & iOS) Grey-Box',
    qty: 1,
    unit: 'Paket',
    unitPrice: 85000000,
    amount: 85000000,
  }],
};

describe('Quotation mobile document', () => {
  it('renders mobile line cards as well as the A4 print table with identical figures', () => {
    const html = renderQuotationHtml(quotation);
    expect(html).toContain('class="line-cards"');
    expect(html).toContain('class="line-table"');
    expect(html).toContain('class="line-card"');
    expect(html).toContain('@media print');
    expect(html).toContain('size:A4');
    expect(html).toContain('Penetration Testing Mobile Banking');
    expect(html.match(/Rp 85[.]000[.]000/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('Rp 94.350.000');
    expect(html).not.toMatch(/internalCost|grossMarginPct|floorPrice/);
  });

  it('HTML escapes customer-controlled quotation lines in both views', () => {
    const html = renderQuotationHtml({
      ...quotation,
      lines: [{ ...quotation.lines[0], description: '<script>alert("x")</script>' }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
