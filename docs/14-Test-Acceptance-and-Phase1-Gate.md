# Test & Acceptance Matrix — Phase 1 Gate Report

Tanggal uji: 2026-10-09 · Lingkungan: Node 22, PostgreSQL 16 (lokal), Next.js 14 production build, Chromium headless 390×844.

## 1. Hasil eksekusi nyata

| Suite | Perintah | Hasil |
|---|---|---|
| Typecheck API | `npm run typecheck -w apps/api` | PASS |
| Unit (engine VAPT/SOC/pricing/DoA/redaksi) | `vitest run tests/engine.unit.test.ts` | 16/16 PASS |
| Integration/E2E API vs PostgreSQL | `vitest run tests/e2e.phase1.test.ts` | 22/22 PASS |
| Build frontend | `next build` | PASS (17 route, first load ≈ 87–107 kB) |
| UI smoke mobile (alur penuh lewat UI) | `python3 infra/smoke/ui_smoke.py` | 11/11 PASS, 0 JS error, 0 horizontal overflow |

Screenshot bukti: `docs/screenshots/`.

## 2. Acceptance criteria master prompt §X

| # | Kriteria | Status Phase 1 | Bukti |
|---|---|---|---|
| 1 | Sales daftar customer & opportunity | **PASS** | E2E [#1], UI smoke 01–03 |
| 2 | Pre-sales assessment → effort estimate | **PASS** | E2E [#2], UI smoke 04 |
| 3 | Pricing engine BoQ/harga/margin benar | **PASS** | unit (kasus BPK Penabur), E2E [#3] |
| 4 | Diskon di luar wewenang → eskalasi | **PASS** | E2E [#4], UI smoke (Manager→VP) |
| 5 | Approved quotation → surat penawaran harga benar | **PASS** | E2E [#5], UI smoke 09 |
| 6 | Tidak bisa terbit tanpa approval lengkap | **PASS** | E2E [#6], re-approval setelah edit |
| 7 | Customer lihat & respons via portal | **PASS** | E2E [#7] |
| 8 | Accepted → proses contracting | **PARTIAL** | Status `PENDING_CONTRACT` + notifikasi Legal; modul kontrak Phase 3 |
| 9 | Kontrak aktif → project | NOT IN SCOPE | Phase 3–4 |
| 10 | FlexGuard reserve/utilisasi/reversal | NOT IN SCOPE | Phase 3 |
| 11 | RKS → checklist & compliance matrix | NOT IN SCOPE | Phase 2 (AI `rks_summary` tersedia sebagai draft) |
| 12 | Proposal tidak mengarang | PARTIAL | Guardrail AI terpasang; generator proposal Phase 2 |
| 13 | Data sesuai role & tenant | **PASS** | E2E [#13], [#14], 403 per role |
| 14 | BoQ internal tak terlihat customer | **PASS** | E2E [#14], UI smoke |
| 15 | Alur penting jalan di mobile | **PASS (Phase 1 flows)** | UI smoke 390px |
| 16 | Approval ber-audit trail | **PASS** | E2E [#16], trigger append-only |
| 17 | Duplicate request tidak menggandakan transaksi | **PASS** | E2E idempotency create/submit/decide |
| 18 | Backup & restore diuji | **NOT DONE** | Belum ada environment staging |
| 19 | AuthN/AuthZ diuji otomatis | **PASS** | E2E 401/403/lockout/force password |
| 20 | Production gate PASS berbasis hasil nyata | **NOT YET** | Lihat §3 |

AI multi-provider: failover 500→429→sukses, circuit breaker, 503 saat semua gagal, provider nonaktif dilewati, redaksi PII — **PASS dengan HTTP mock**. Koneksi live ke tiap provider **belum diuji** karena API key belum tersedia.

## 3. Status gate

**Phase 1 functional gate: PASS** (kriteria 1–7, 13–17, 19 untuk lingkup Phase 1).
**Production gate: BELUM** — syarat tersisa:
1. Owner mengesahkan `PRICING-BRD2 v1` dan memilih DoA (`DOA-MP-2026` atau `DOA-BRD-2.0`) di halaman *Kebijakan & AI* (Direktur, maker-checker).
2. API key provider AI diisi dan tombol **Uji** tiap provider hijau.
3. Deploy ke staging, uji backup/restore (#18), MFA privileged, SAST/DAST di CI.
4. UAT oleh Sales, Pre-Sales, Manager/VP/Direktur.

## 4. Known issues

- Pipeline desktop menampilkan semua kolom; di mobile satu kolom per tab (by design).
- Penomoran quotation memakai bulan Romawi & tahun saat dibuat; reset per tahun.
- Rate limit in-memory; perlu Redis saat >1 instance.
- Kontrak/project/tiket/invoice di Customer 360 masih placeholder (Phase 3–4).
