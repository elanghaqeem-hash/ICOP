# ICOP CyberBusiness 360

Enterprise Cybersecurity & IT Services Business Operating System — **DefendIT360 (PT Data Enkripsi Informasi Teknologi)**.

Status: **Phase 0 disahkan owner (2026-10-09) · Phase 1–4 functional gate PASS** — lihat [`docs/14`](docs/14-Test-Acceptance-and-Phase1-Gate.md), [`docs/15`](docs/15-Phase2-Gate-Report.md), [`docs/16`](docs/16-Phase3-Gate-Report.md), [`docs/17`](docs/17-Phase2b-Phase4-Gate-Report.md). Belum siap produksi. **Phase 5 hardening awal** sudah dimasukkan (fail-closed secrets, pembatasan port API, GitHub CI); lihat [`docs/18`](docs/18-Phase5-Security-and-Release-Checklist.md) untuk blocker UAT, security dan release gate.

## Isi Phase 1

| Modul | Kemampuan |
|---|---|
| Auth & keamanan | JWT + token revocation, RBAC 20 role, tenant isolation, wajib ganti password, lockout, audit append-only, idempotency |
| CRM | Customer master (dedup nama/NPWP), kontak & decision maker, aktivitas, Customer 360, pipeline kanban dengan exit criteria |
| Deal 360 workspace | Satu halaman per opportunity: stage, scoping, pricing, quotation, approval, AI |
| Smart Scoping | VAPT (web/mobile/API/network) & SOC (EPS) sesuai formula BRD v2.0, auto-save, kelengkapan, engineer review |
| Pricing engine | Kebijakan berversi, BoQ A–E, Floor/Standard/Premium, DAI, tier, margin vs markup, scenario immutable & compare |
| Quotation | Penomoran `NNN/DEIT-RCS/<bln romawi>/<tahun>`, revisi & snapshot, terbit hanya setelah approval versi yang sama, surat penawaran HTML/print-PDF |
| Approval engine | DoA konfigurabel, aturan paling ketat, rantai Manager→VP→Direktur, SoD, four-eyes, SLA, Decision Center mobile |
| Customer portal | Lihat penawaran, terima / minta revisi / tolak (acceptance komersial, bukan TTE) |
| AI gateway | Anthropic, OpenAI, Gemini, Mistral, Groq, OpenRouter + custom OpenAI-compatible; failover, circuit breaker, redaksi PII, log |
| Dashboard | KPI dari transaksi riil dengan definisi & drill-down |
| **Phase 2** Tender Center | Impor sumber sah, relevansi & dedup, workflow 15 status dengan gate, RKS → persyaratan (rule + AI terverifikasi), compliance matrix, readiness, aanwijzing |
| **Phase 2** Bid/No-Bid | Scorecard 13 kriteria + knockout → approval DoA (VP; Direktur > Rp1 M) |
| **Phase 2** Proposal generator | 20 bagian grounded, claim guard anti-fabrikasi, company facts terverifikasi, reviewer sign-off, Word/PDF, versi & diff |
| **Phase 2** Vendor & BOM | Price list berkurs & bermasa berlaku, BOM builder, simulasi sensitivitas harga |
| **Phase 2** Scoping CTI & GRC | Tier CTI, ISO, PDP/DPOaaS sesuai BRD |
| **Phase 2** Approval lanjutan | Delegasi berjangka, eskalasi SLA otomatis, pengingat deadline tender |
| **Phase 2b** Admin AI | Form registrasi API key (AES-256-GCM, masked), urutan failover ▲▼, uji koneksi, aktivasi AI global & per fitur (ditegakkan server) |
| **Phase 2b** Document Center | OCR Tesseract, kompresi PDF (Ghostscript/qpdf/raster), batas 300 halaman & 50 MB, analisis AI (ringkasan, risiko, ekstraksi, tanya-jawab) dengan kutipan + halaman terverifikasi |
| **Phase 3** FlexGuard | Kalkulator paket, wallet & ledger append-only (fund/reserve/consume/release/reversal/expire), service request MD×TDC + floor guard, timesheet, BAST, portal |
| **Phase 3** Kontrak & handover | Kontrak dari quotation/tender, checklist legal 10 item, DoA nilai kontrak, otorisasi internal + TTD customer terverifikasi, aktivasi → proyek handover & kickoff |
| **Phase 2b** Integrasi admin | SMTP, e-sign VIDA (VSP OpenAPI) & Privy (kredensial), object storage S3/MinIO, feed tender, API key ingest — semua rahasia terenkripsi |
| **Phase 2b** Template legal | Surat penawaran, pernyataan kesanggupan, pakta integritas, surat kuasa, NDA, BAST — status pengesahan Legal |
| **Phase 4** Delivery | WBS, timesheet proyek (maker-checker), change request via DoA → addendum, penutupan proyek |
| **Phase 4** Billing | BAST → invoice ber-PPN → pembayaran append-only → aging & dunning email bertingkat |
| **Phase 4** Helpdesk | Tiket portal/internal/ingest SOC-VAPT, target SLA per prioritas, eskalasi pelanggaran |
| **Phase 4** Renewal | Pengingat H-180/90/60/30 + opportunity renewal otomatis |

## Menjalankan lokal

Prasyarat: Node.js ≥ 20, PostgreSQL 16.

```bash
cp .env.example .env            # isi DB_PASSWORD, JWT_SECRET, SEED_PASSWORD, API key AI
cd apps/api && npm ci
npm run migrate:seed            # migrasi + seed tenant DEIT, 14 user, kebijakan, katalog, provider AI
npm run dev                     # API :3001 — dokumentasi OpenAPI di /api/docs
cd ../web && npm ci && npm run dev   # UI :3000
```

Atau dengan Docker: `cp .env.example .env` → isi → `RUN_SEED=true docker compose up -d --build`.

User seed (password = `SEED_PASSWORD`, wajib diganti saat login pertama): `admin@`, `companyadmin@`, `direktur@`, `vp@`, `salesmanager@`, `sales@`, `presales@`, `architect@`, `finance@`, `legal@`, `tender@`, `pm@`, `product@`, `auditor@` — semua `@defendit360.com`.

## Mengaktifkan AI

Isi `SECRETS_MASTER_KEY` (`openssl rand -hex 32`) di `.env`, lalu login `companyadmin@` → **Kebijakan & AI → AI & API key**: tempel API key per provider → **Simpan key & uji**, atur urutan failover dengan ▲▼ → **Simpan urutan failover**, dan nyalakan/matikan AI per fitur → **Simpan aktivasi**. Key tersimpan terenkripsi AES-256-GCM dan tidak pernah ditampilkan ulang (hanya 4 karakter terakhir). Key di `.env` tetap didukung sebagai fallback.

## Integrasi (Pengaturan → Email (SMTP) / Integrasi, login `companyadmin@`)

- **Pengesahan FlexGuard**: tombol *Sahkan kebijakan FlexGuard* di halaman FlexGuard (Direktur atau Company Admin, catatan wajib).
- **E-sign VIDA**: isi Environment URL, email member workspace, Client ID/Secret dari VIDA → *Uji koneksi*. Kontrak: unggah PDF final (DRAFT/LEGAL REVIEW) → setelah approval pilih VIDA → status ditarik otomatis tiap 15 menit atau tombol *Cek status*.
- **Privy**: kredensial dapat disimpan; pengiriman aktif setelah spesifikasi API resmi dari Privy diterima. Alternatif sah: unggah kontrak bertanda tangan → verifikasi Legal.
- **MinIO/S3**: `docker compose --profile minio up -d`, buat bucket, isi endpoint/bucket/key → *Uji koneksi* → *Sinkronkan file lama*.
- **Ingest SOC/VAPT**: buat API key layanan, kirim `POST /api/v1/ingest/soc-alerts` atau `/vapt-findings` dengan header `x-api-key`.

## OCR & dokumen

Image Docker API memasang `tesseract-ocr` (ind+eng), `ghostscript`, `qpdf`, `poppler-utils`. Untuk dev lokal pasang paket yang sama (Debian/Ubuntu: `apt install tesseract-ocr tesseract-ocr-ind ghostscript qpdf poppler-utils`). Batas: `DOC_MAX_PAGES=300`, `DOC_MAX_MB=50`.

## Testing

```bash
cd apps/api && npm test                                   # laporan source mencatat 128 test; jalankan ulang untuk verifikasi: unit + E2E Phase 1–4 vs PostgreSQL (DB icop_test; uji S3 memakai moto_server bila terpasang)
cd apps/web && npm run build
python3 infra/smoke/ui_smoke.py http://localhost:3000 "$SEED_PASSWORD" ./shots   # UI mobile 390px
python3 infra/smoke/ui_smoke_phase2.py http://localhost:3000 "$SEED_PASSWORD" ./shots2 infra/smoke/RKS-demo.pdf
python3 infra/smoke/ui_smoke_phase3.py http://localhost:3000 "$SEED_PASSWORD" ./shots3 scan.pdf signed.pdf <email customer_user>
python3 infra/smoke/vida_mock.py 5056 vida-client vida-secret-123 signed.pdf &   # server VIDA tiruan sesuai VSP OpenAPI (UAT)
python3 infra/smoke/ui_smoke_phase4.py http://localhost:3000 "$SEED_PASSWORD" ./shots4 127.0.0.1 1025 http://127.0.0.1:5056 http://127.0.0.1:5055 signed.pdf
```

## Keputusan owner (2026-10-09)

Seluruh rekomendasi Phase 0 disetujui: `PRICING-BRD2 v2` dan `DOA-MP-2026 v2` aktif, tema navy/putih. Masih ditunggu: unggah *ICOP Pre-Development Decision Record v1.0* dan sign-off formal Direktur di aplikasi. Phase 3: `DOA-MP-2026 v3` aktif; `FLEXGUARD-PD1 v1` disahkan lewat tombol persetujuan oleh Direktur atau Company Admin.

## Dokumen

`docs/00` audit & gap · `04` role-permission & DoA · `05` ERD & proses · `06` formula pricing · `11` OpenAPI (179 path, `npm run openapi`) · `12` keamanan & AI · `13` backlog · `14` gate Phase 1 · `15` gate Phase 2 · `16` gate Phase 2b & 3 · `17` gate Phase 2b (lanjutan) & 4 · `screenshots/`

## GitHub CI dan hardening awal (Phase 5)

Workflow `.github/workflows/ci.yml` menjalankan typecheck, build, suite regresi API dengan PostgreSQL serta `npm audit --omit=dev --audit-level=high` setiap pull request. Status workflow terbaru harus dicek langsung di GitHub. Variabel produksi `DB_PASSWORD`/`DATABASE_URL`, `JWT_SECRET`, `SEED_PASSWORD` diwajibkan; Swagger UI nonaktif dan `TRUST_PROXY=false` secara default pada production. Panduan gate di [`docs/18`](docs/18-Phase5-Security-and-Release-Checklist.md).
