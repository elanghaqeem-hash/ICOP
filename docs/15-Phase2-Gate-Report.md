# Phase 2 Gate Report — Advanced Pre-Sales & Tender

Tanggal uji: 2026-10-09 · Node 22, PostgreSQL 16, Next.js 14 production build, Chromium 390×844.

## 1. Keputusan owner yang dieksekusi

| Keputusan | Implementasi |
|---|---|
| Sahkan pricing BRD v2.0 (Tier S 1.4, coverage SOC 8x5 ×0.5) | `PRICING-BRD2 v2` **ACTIVE** (+ parameter CTI, ISO, PDP); v1 RETIRED |
| DoA master prompt (Manager ≤50 jt, VP ≤500 jt, Direktur di atas) | `DOA-MP-2026 v2` **ACTIVE** (+ aturan TENDER: VP Go/No-Go, Direktur > Rp1 M); v1 RETIRED; `DOA-BRD-2.0` tetap DRAFT sebagai alternatif |
| Tema navy/putih | Dipertahankan |
| Catatan pengesahan | Tercatat di `source_note` kebijakan: "Disahkan owner (Teguh Budiarto, VP Cybersecurity Strategic) 2026-10-09". Sign-off formal Direktur di aplikasi tetap direkomendasikan |

Aktivasi berjalan sebagai **data migration idempoten** — database yang sudah berjalan ikut ter-update saat `npm run migrate` (diuji pada DB dev).

## 2. Fitur Phase 2

| Modul (master prompt) | Yang berjalan |
|---|---|
| E1/E2 Tender discovery & intelligence | Input manual + impor JSON (export Cyber Tender Radar/SiRUP/portal) tanpa scraping yang melewati kontrol portal; skor relevansi & klasifikasi; deteksi duplikat (kode RUP & kemiripan judul); notifikasi tender relevan; filter deadline |
| E3 Bid/No-Bid | 13 kriteria berbobot (total 100), knockout (sertifikasi, otorisasi vendor, waktu, conflict of interest), GO/Conditional/No-Go → approval DoA berjenjang |
| E4 Preparation workspace | Unggah RKS/KAK/TOR/addendum/MoM (PDF, DOCX, TXT; deteksi tipe dari isi file, SHA-256 anti-duplikat), ekstraksi teks per halaman, deteksi PDF scan, ekstraksi persyaratan rule-based + AI dengan **verifikasi kutipan verbatim**, compliance matrix 4 kategori (status, tanggapan, bukti, PIC, risiko), ekspor CSV, analisis dampak addendum, draft pertanyaan aanwijzing oleh AI, readiness review |
| E5 Document generator | Checklist pengemasan dokumen; template surat legal menunggu template perusahaan yang disahkan |
| E6 Execution & award | 15 status dengan gate: registrasi wajib customer (otomatis membuat opportunity tender), internal review wajib persyaratan direview, approval dokumen VP/Direktur + SoD, submission wajib bukti, contracting wajib surat penunjukan; LOST menutup opportunity |
| J Proposal generator | 20 bagian (J2) dibangun hanya dari data sistem; penanda `[PERLU DILENGKAPI]` + daftar informasi yang belum ada; sumber per bagian; AI rewrite per bagian; **claim guard** menandai klaim sertifikasi/pengalaman/partner/jumlah klien yang tidak didukung fakta terverifikasi; reviewer teknis ≠ pembuat; ekspor Word (.docx) & HTML/PDF; versi + diff; edit setelah review → wajib review ulang |
| Company facts | Satu-satunya sumber klaim proposal; maker-checker verifikasi oleh Legal/Direktur dengan referensi bukti. Klaim BSSN dari company profile di-seed **UNVERIFIED** sampai bukti surat dilampirkan |
| I4 Vendor/distributor | Registrasi, status otorisasi berjangka, price list berversi (mata uang + kurs, masa berlaku, special bid) |
| I3 Solution/BOM builder | Biaya IDR dari harga vendor terbaru × qty × periode → harga pada target margin; peringatan harga kedaluwarsa/otorisasi tidak aktif |
| G4 Simulasi | Sensitivitas diskon, effort, indeks FX, tier, staffing mix, posisi vs harga kompetitor |
| F4/F5 Scoping CTI & GRC | Tier CTI (BRD §8.4 D), ISO (BRD Seksi 4), PDP/DPOaaS (Seksi 5) → pricing scenario |
| L2 Approval | Delegasi berjangka (≤30 hari, ≤ level sendiri, tercatat di bukti keputusan, dapat dicabut); eskalasi SLA otomatis ke level di atasnya; pengingat deadline tender H-3 (sekali/hari) — scheduler internal 15 menit + endpoint manual |

## 3. Hasil pengujian

| Suite | Hasil |
|---|---|
| Typecheck API & web | PASS |
| Unit (engine, DoA, bid scorecard, extractor, claim guard, CTI) | 25/25 PASS |
| E2E Phase 1 (regresi) | 22/22 PASS |
| E2E Phase 2 | 16/16 PASS |
| **Total otomatis** | **63/63 PASS** |
| UI smoke Phase 1 (regresi, 390px) | 11/11 PASS |
| UI smoke Phase 2 (390px) | 8/8 PASS — 10/10 persyaratan RKS terekstrak lewat UI |
| Build frontend | PASS (21 route) |

Acceptance criteria master prompt:

| # | Kriteria | Status |
|---|---|---|
| 11 | RKS diparsing menjadi checklist & compliance matrix | **PASS** — 10/10 persyaratan dengan kategori & sifat wajib/opsional benar; item AI yang kutipannya tidak ada di dokumen ditolak |
| 12 | Proposal tidak mengarang sertifikasi, pengalaman, atau compliance | **PASS** — hanya fakta VERIFIED; klaim karangan dari manusia maupun AI ditandai dan memblokir sign-off |
| 4, 6, 13, 16, 17, 19 | (diperluas ke tender & proposal) | **PASS** |

## 4. Keterbatasan yang jujur

1. **OCR belum aktif** — PDF hasil scan terdeteksi (`NEEDS_OCR`) tetapi belum dibaca; perlu worker Tesseract (Phase 2b).
2. **Discovery otomatis SiRUP/SPSE belum di-crawl** — sengaja: hanya impor dari sumber sah/ekspor Tender Radar. Konektor API resmi bila tersedia.
3. **Template surat legal** (surat penawaran, pernyataan, pakta integritas) belum dibuat — menunggu template perusahaan yang disahkan.
4. File tender disimpan di disk server (`UPLOAD_DIR`); pindah ke MinIO/S3 terenkripsi sebelum produksi.
5. AI live belum diuji — API key belum tersedia. Ekstraksi tetap berjalan rule-based bila AI tidak tersedia.
6. Claim guard berbasis pola; tetap wajib review manusia (sign-off reviewer teknis).
