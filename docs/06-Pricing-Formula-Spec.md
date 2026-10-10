# Pricing Formula Specification (Phase 1)

Semua parameter disimpan di tabel `pricing_policies` (versi, effective date, status). Engine **tidak** memakai konstanta di kode; nilai di bawah adalah seed.

## 1. Rate card internal (cost to company, BRD v2.0 §3.1)

| Role | Domestik Rp/MD | Overseas Rp/MD |
|---|---|---|
| PM | 1.500.000 | 4.000.000 |
| Lead Pentester/Consultant | 2.000.000 | 4.000.000 |
| Senior Pentester/Analyst | 1.000.000 | 3.900.000 |
| Junior Pentester/Analyst | 500.000 | 1.500.000 |
| Forensic/Specialist | 2.000.000 | 5.000.000 |
| SOC L1 | 700.000 | 2.500.000 |
| SOC L2 | 1.200.000 | 3.500.000 |
| CTI Analyst | 1.500.000 | 4.000.000 |

## 2. Sizing VAPT (BRD §8.2)

- Web: `MD_app = Base[complexity] + 0.5·N_role + ceil(N_api/25)·1.0`; `MD_web = Σ MD_app × Box × Auth × Compliance`
  - Base: simple 3, medium 5, complex 8, critical 12 · Box: black 1.0, grey 1.2, white 1.5 · Auth: basic 1.0, sso 1.1, mfa 1.2, idam 1.3 · Compliance: owasp 1.0, owasp_formal 1.1, ojk 1.2, pci 1.3
- Mobile: `platforms(android 4 | ios 4 | dual 7) × Feature(1.0/1.3/1.4/1.5) × Backend(1.0/1.5)`
- API: `max(3, ceil(N/25)·1.5) × Auth × Doc(1.0/1.2/1.4)`
- Network: `ceil(ext_ip/50)·2 + ceil(int_host/100)·3 + AD 2 + WiFi 2/cluster + 1.5/firewall + 3/cloud account`
- Komposisi tim (dari MD teknis T): PM = max(2, 17.5%·T), Lead 27.5%, Senior 37.5%, Junior 17.5% (Junior opsional; jika dinonaktifkan dialihkan ke Senior). Dibulatkan ke 0.5 MD.
- **Hasil sizing adalah estimasi; status `ENGINEER_REVIEW_REQUIRED` sampai Pre-Sales Engineer mengesahkan.**

## 3. Sizing SOC (BRD §8.3)

- `Total_EPS = Σ N_asset × EPS_median`; `Effective_EPS = Total_EPS × 1.2`
- Metode default `simplified` (Server + VM + Network + 1 EDR terpadu) — pelajaran internal: metode per-workstation overestimate hingga ~76%. Metode `per_device` tersedia dan diberi flag.
- Band EPS → base monthly (midpoint): <500: 20 jt · ≤2000: 42,5 jt · ≤5000: 77,5 jt · ≤10000: 125 jt · >10000: custom (wajib manual)
- Coverage: 8x5 ×0.5, 16x7 ×0.7, 24x7 ×1.0
- Tier layanan: Essential ×1.0, Standard ×1.2, Advanced ×1.5
- Add-on: log source >15: Rp1,5 jt/source/bln; EDR Rp60rb (Tier S Rp120rb)/endpoint/bln; onboarding Rp25–50 jt OTC

## 4. Harga (reconciled)

```
TotalCost      = A_HR + B_Commission + C_Documents + D_ThirdParty + E_Travel + Overhead% + Contingency%
DAI            = wCPI·CPI + wFX·FX + wMKT·Market + wURG·Urgency         (default index 1.0 → DAI = 1.0)
Floor          = TotalCost / (1 − min_margin)                            (min_margin 20%)
Standard       = TotalCost / (1 − target_margin) × DAI × TierMultiplier  (target 35%)
Premium        = Standard × premium_factor                               (1.25)
SellingPrice   = pilihan (floor | standard | premium | manual) − diskon
GrossProfit    = SellingPrice − TotalCost
GrossMargin %  = GrossProfit / SellingPrice        ← dihitung dari HARGA JUAL
Markup %       = GrossProfit / TotalCost           ← dihitung dari BIAYA
PPN            = SellingPrice × 11% (konfigurabel; DPP nilai lain belum diterapkan)
```

Aturan:
- Tier S multiplier 1.4 (S 1.3–1.5), A 1.0, B 0.9, C 2.2, D 0.8, E 0.8. Tier C (overseas) juga memicu rate overseas pada HR.
- Urgency index masuk DAI dengan bobot 10% (normal 1.0, priority 1.1, rush 1.25 → DAI 1.025). BRD menyebut rush ×1.25; engine memunculkan rekomendasi memakai **Premium** (= Standard × 1.25) agar tidak dihitung ganda.
- Coverage SOC: base band diasumsikan 24x7; 8x5 = ×0.5, 16x7 = ×0.7 (rasio BRD 1.0/1.4/2.0). **Perlu konfirmasi owner.**
- Margin < `margin_warning` (25%) → warning; < `margin_hold` (20%) atau harga < Floor → quotation otomatis memerlukan approval `MARGIN_EXCEPTION`/`BELOW_FLOOR` level Direktur dan tidak dapat diterbitkan sebelum disetujui.
- Kalkulasi disimpan sebagai snapshot di `pricing_scenarios` beserta `policy_version` → reproducible.
- BoQ internal, cost, floor, margin **tidak pernah** dikirim ke endpoint/role customer (field-level filter + test #14).

## 5. Contoh validasi (unit test)

BPK Penabur (BRD §3.2): HR 81,5 jt + Dokumen 2 jt = 83,5 jt; harga aktual 100 jt → margin 16,5% → sistem harus memunculkan warning merah dan HOLD. Test `apps/api/tests/engine.unit.test.ts` mengecek angka ini.
