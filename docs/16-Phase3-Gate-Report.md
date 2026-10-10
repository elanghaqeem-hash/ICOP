# Phase 2b + Phase 3 Gate Report — AI Admin, Document Center, FlexGuard, Contract & Handover

Tanggal uji: 2026-10-10 · Node 22, PostgreSQL 16, Tesseract 5 (OCR nyata), Next.js 14 production build, Chromium 390×844.

## 1. Permintaan owner yang dieksekusi

| Permintaan | Implementasi |
|---|---|
| Form registrasi API key AI di user admin | **Kebijakan & AI → tab "AI & API key"** (role `company_admin`/`super_admin`, perm `ai.admin`). Input password-masked per provider, **Simpan key & uji** (test call langsung), model, base URL (HTTPS, provider custom), timeout, aktif/nonaktif, hapus key. Key dienkripsi **AES-256-GCM** (`SECRETS_MASTER_KEY`), tidak pernah dikembalikan ke UI/log — hanya `••••last4` + fingerprint. Key `.env` tetap didukung sebagai fallback (`keySource: environment`) |
| Urutan penggunaan AI | Tombol ▲▼ per provider → **Simpan urutan failover** (prioritas 10, 20, …). Gateway mencoba sesuai urutan; provider tanpa key dilewati dengan alasan "API key belum diregistrasi"; circuit breaker direset saat key/urutan berubah |
| Aktivasi AI pada form yang ada | Master switch + toggle per fitur (12 fitur: opportunity brief, scoping gap, quotation cover, RKS summary/extraction, aanwijzing, proposal section, document summary/risks/extract/QA, chat). **Ditegakkan di server** (HTTP 409 `AI_DISABLED`), bukan hanya disembunyikan; AI Assistant & tombol analisis otomatis menyembunyikan fitur yang nonaktif |
| OCR | Tesseract (TSV + confidence per halaman), otomatis untuk halaman tanpa teks, opsi paksa/nonaktif; worker job DB (`FOR UPDATE SKIP LOCKED`, retry); RKS tender hasil scan otomatis di-OCR (`OCR_QUEUED → DONE`) lalu bisa diekstraksi persyaratannya |
| Kompres file | Ghostscript `/ebook` → qpdf lossless → raster JPEG 150 dpi (mode agresif, hanya untuk scan); hasil hanya dipakai bila lebih kecil; rasio & metode tercatat; unduh asli/terkompresi |
| Batas 300 halaman & 50 MB | Ditolak di server (413/422) dan dicek di browser sebelum unggah; dapat diatur `DOC_MAX_PAGES` / `DOC_MAX_MB` |
| Analisa data dokumen berbasis AI | Ringkasan (map-reduce per 12k karakter, maks 60 potongan), risiko, ekstraksi field terstruktur, tanya-jawab — setiap temuan wajib **kutipan verbatim + nomor halaman** yang diverifikasi terhadap teks dokumen; kutipan yang tidak ditemukan ditolak/ditandai. Dokumen **RESTRICTED tidak pernah dikirim ke AI** |
| Lanjutkan Phase 3 | Lihat §2 |

## 2. Fitur Phase 3

| Modul | Yang berjalan |
|---|---|
| FlexGuard kalkulator (H1) | Ladder paket Starter→Strategic, harga khusus (bukan rate card global), floor guard per token, bonus/booster, rollover, complimentary, membership, rencana pemakaian per layanan → token/tahun, bulan habis, rekomendasi top-up, risiko hangus |
| Wallet & ledger | Dibuat otomatis saat kontrak FLEXGUARD aktif (FUND + BONUS). Ledger **append-only** (trigger DB menolak UPDATE/DELETE), idempotency key, reversal 1×, invariant `credited = available + reserved + consumed + expired` + rekonsiliasi, saldo tidak bisa negatif (CHECK). Metrik utilisasi, burn rate, perkiraan habis, berisiko hangus; statement bulanan; job harian expiry |
| Perubahan saldo | Top-up, rollover, adjustment, reversal → **approval DoA** (`FLEXGUARD_VALUE`, `BELOW_FLOOR` → Direktur) sebelum ledger berubah |
| Service request (H2) | Portal/internal → estimasi MD × TDC × pengali (overseas ×2, rush ×1,25, bulat ke atas 0,5; TDC tidak boleh di bawah tabel = no under-debit) → floor check (di bawah floor → approval Direktur) → persetujuan customer = **RESERVE** → PM mulai → timesheet (maks 1,5 MD/hari, maker-checker) → serah hasil (aktual dari timesheet disetujui) → BAST customer = **CONSUME** (selisih dikembalikan) / sengketa → penyelesaian tidak boleh menaikkan realisasi; pembatalan = RELEASE (biaya scoping ≤ 1 token) |
| Contract lifecycle | Dari quotation ACCEPTED (tombol **Buat kontrak**) atau tender AWARDED/CONTRACTING (≤ HPS); nomor `NNN/DEIT-PKS/<romawi>/<tahun>`; jadwal pembayaran dari termin (DP/progress/BAST, MRC bulanan, FlexGuard 100% di muka), kewajiban deliverable & renewal H-90; edit → kembali DRAFT & reset legal |
| Legal review | Checklist 10 item (identitas, scope, nilai & pajak, termin, SLA & denda, NDA, **UU PDP**, HKI, force majeure, sengketa); SoD pembuat ≠ reviewer; kembalikan wajib catatan; lengkap → approval DoA `CONTRACT_VALUE` (≤50 jt Manager, ≤250 jt VP, di atas Direktur; harga token di bawah floor → Direktur) |
| Tanda tangan | Otorisasi internal (pejabat level ≥ level approval, bukan pembuat, hash SHA-256 isi kontrak dikunci); TTD customer via unggah portal/internal → verifikasi Legal (maker-checker); provider e-sign abstraction + webhook HMAC; aktivasi menolak bila isi berubah setelah otorisasi |
| Aktivasi & handover | Kontrak ACTIVE → opportunity WON, proyek `PRJ-YYYY-NNNN` status HANDOVER dengan budget dari BoQ, milestone dari kewajiban, checklist handover 6 item → kickoff hanya bila PM ditetapkan & checklist lengkap |
| Portal customer | Kontrak (lihat, unggah TTD), FlexGuard (saldo, mutasi, ajukan layanan, setujui estimasi, terima BAST/ajukan keberatan) |

Kebijakan: `DOA-MP-2026 v3` **ACTIVE** (v2 + CONTRACT & FLEXGUARD); `FLEXGUARD-PD1 v1` **PENDING_OWNER_APPROVAL** — parameter dari dokumen FlexGuard_Token (TRV Rp3,5 jt, ladder, TDC, floor = biaya/0,8) dipakai untuk kalkulasi, UI menampilkan peringatan sampai Direktur/Finance mengesahkan di aplikasi.

## 3. Hasil pengujian

| Suite | Hasil |
|---|---|
| Typecheck API & web | PASS |
| Unit (engine, DoA, Phase 2, Phase 3: FlexGuard calc/TDC/floor/ladder, termin, secrets) | 36/36 PASS |
| E2E Phase 1 (regresi) | 22/22 PASS |
| E2E Phase 2 (regresi) | 16/16 PASS |
| E2E Phase 2b + 3 (OCR nyata, kompresi, batas, AI terverifikasi, wallet, kontrak, e-sign) | 14/14 PASS |
| **Total otomatis** | **88/88 PASS** |
| UI smoke Phase 1 / Phase 2 (regresi, 390px) | 11/11 · 8/8 PASS |
| UI smoke Phase 2b + 3 (390px) | **24/24 PASS** — `infra/smoke/ui_smoke_phase3.py`, screenshot `docs/screenshots/phase3/` |
| Build frontend | PASS (33 route) |

Alur UI yang diuji end-to-end: admin simpan API key (ter-masking) → ubah urutan failover → nonaktifkan fitur (terverifikasi di server) → unggah PDF scan → OCR membaca "NPWP" → quotation ACCEPTED di portal → **Buat kontrak** FlexGuard 162 token × Rp1,5 jt → legal review → DoA level 3 (di bawah floor) → otorisasi Direktur → customer unggah TTD di portal → verifikasi Legal → aktivasi (proyek + wallet 162 token) → PM, checklist, kickoff → wallet & kalkulator → customer ajukan VAPT → estimasi 6 token → approval Direktur → customer setujui → available 156 / reserved 6, rekonsiliasi OK, tanpa error JS dan tanpa overflow horizontal.

Acceptance criteria master prompt:

| # | Kriteria | Status |
|---|---|---|
| 8 | Quotation ACCEPTED masuk contracting dengan kontrol legal & approval | **PASS** |
| 9 | Kontrak aktif membuat proyek handover & wallet FlexGuard | **PASS** |
| 10 | Token tidak pernah negatif; setiap mutasi tercatat, tidak dapat diubah, dapat direkonsiliasi | **PASS** — UPDATE ledger & saldo negatif ditolak DB |
| Contoh dokumen FlexGuard | 162 MD × Rp1,5 jt = Rp243 jt ditandai **di bawah floor** (special deal, bukan rate card); contoh A = 23 token | **PASS** |

## 4. Keterbatasan yang jujur

1. **Parameter FlexGuard belum disahkan** (`PENDING_OWNER_APPROVAL`) — perlu keputusan Direktur/Finance atas TRV, ladder, TDC, overhead 1,0 dan floor; setelah disahkan cukup klik **Sahkan & aktifkan** di tab Kebijakan.
2. **E-sign tersertifikasi (Privy/VIDA) belum aktif** — adapter sengaja tidak dibuat tanpa spesifikasi API & kredensial resmi. Sandbox hanya untuk UAT, ditandai tidak mengikat hukum dan otomatis diblokir di production. Saat ini jalur sah = unggah dokumen bertanda tangan + verifikasi Legal.
3. **OCR Bahasa Indonesia** — lingkungan uji hanya punya model `eng`; image Docker produksi memasang `tesseract-ocr-data-ind` (`OCR_LANGS=ind+eng`). Ghostscript juga dipasang di image; di lingkungan uji kompresi memakai qpdf/raster.
4. **AI live belum diuji dengan key asli** — gateway & analisis diuji dengan mock deterministik; uji koneksi tersedia di form admin begitu key dimasukkan.
5. Dokumen disimpan di volume `api_storage`; MinIO/S3 terenkripsi direkomendasikan sebelum produksi.
6. Invoicing/collection, WBS & timesheet proyek umum, renewal otomatis → Phase 4.
7. Repositori GitLab tidak terjangkau dari lingkungan build — kirim via `infra/push-to-gitlab.sh` + git bundle.
