# Phase 0 — Requirement Audit & Gap Analysis

ICOP CyberBusiness 360 · DefendIT360 (PT Data Enkripsi Informasi Teknologi)
Status: DRAFT untuk review owner · Tanggal: 2026-10-09

## 1. Artefak yang diaudit

| Artefak | Sumber | Dipakai untuk |
|---|---|---|
| Master Development Prompt ICOP CyberBusiness 360 | Lampiran chat | Requirement utama (A–Z) |
| DefendIT360 BRD v2.0 Final Complete (80 hlm) | Project file | Rate card internal, tier multiplier, formula VAPT/SOC/CTI, DoA L1–L3, BoQ A–E, payment terms |
| Company Profile DefendIT360 | Project file | Struktur katalog layanan (Security Check-Up / Treatment / Assistant) |
| `README.md`, `docker-compose.yml`, `.env` ICOP lama | Project docs | Stack eksisting: Fastify + TypeScript + raw SQL (`postgres`), Next.js 14, PostgreSQL 16, Redis, MinIO |
| ICOP Pre-Development Decision Record v1.0 | **TIDAK TERSEDIA** | Disebut di master prompt; belum diunggah. Nilai DoA master prompt diasumsikan berasal dari dokumen ini |
| Repository `gitlab.com/icop-group1/icop` | **TIDAK DAPAT DIAKSES** dari workspace build (egress policy 403) | Gap analysis kode lama belum bisa dilakukan; lihat §4 |

## 2. Keputusan arsitektur (reuse vs. baru)

| Area | Keputusan | Alasan |
|---|---|---|
| Backend | **Reuse stack**: Node.js + Fastify 4 + TypeScript + raw SQL (`postgres` lib) | Selaras ICOP lama; larangan memasukkan NestJS/Prisma/GraphQL (learning internal) |
| Database | PostgreSQL 16, migrasi SQL berurutan, tanpa ORM | Single source of truth, kontrol penuh atas constraint & trigger audit |
| Arsitektur | Modular monolith (`src/modules/*`) | Sesuai master prompt §V |
| Frontend | Next.js 14 App Router, mobile-first | Selaras ICOP lama |
| Tema UI | **Navy/white/grey + aksen ungu DefendIT360/cyan** | Master prompt §T1 menggantikan tema cyberpunk ICOP lama — **perlu konfirmasi owner** |
| AI | Gateway multi-provider internal (6 provider, failover) | Permintaan user + §S3/§U |
| Object storage | MinIO/S3 (Phase 2+) | Infrastruktur eksisting |

## 3. Rekonsiliasi kebijakan (WAJIB disahkan owner sebelum produksi)

Lihat detail di `06-Pricing-Formula-Spec.md` dan `04-Role-Permission-DoA.md`.

| Parameter | BRD v2.0 | Master Prompt (≈ Decision Record v1.0) | Seed sistem |
|---|---|---|---|
| DoA quotation — level tengah | Head Sales s/d Rp250 jt | VP/Head >Rp50 jt s/d Rp500 jt | Dua versi kebijakan; aktif = `DOA-MP-2026.1` (status `PENDING_OWNER_APPROVAL`) |
| DoA level bawah | Sales tidak bisa approve | Manager s/d Rp50 jt | Ikut master prompt |
| Diskon Direktur | >15% | >15% | Sama |
| Floor price | Cost / (1−20%) | (tidak didefinisikan) | Cost / (1 − min_margin), min_margin = 20% |
| Standard price | Rate card × tier **atau** Cost/(1−35%) — dua definisi di BRD §8.1 vs §8.2F | Base × DAI × Tier | Cost/(1−target_margin) × DAI × Tier (konfigurabel) |
| Premium | Standard × 1.25 | (tidak didefinisikan) | Standard × 1.25 |
| Tier S | 1.3–1.5 (catatan internal: 1.4) | — | 1.4 (range diizinkan 1.3–1.5) |
| Warning margin | Merah jika < 25% | Min margin + DoA | Warning < 25%, hold finalisasi < 20% |
| Payment terms | 30/50/20 | — | 30/50/20 default |
| DAI weights | — | CPI 40 / FX 30 / Market 20 / Urgency 10 | Seed, index default 1.0000 (netral) |

## 4. Gap analysis terhadap ICOP lama (berbasis README, bukan kode)

| Kapabilitas | ICOP lama (README) | CyberBusiness 360 Phase 1 | Gap tersisa |
|---|---|---|---|
| Auth + force password change | Ada | Ada + lockout + JWT pendek | MFA (Phase 5) |
| Tenant isolation | Tidak disebut | `tenant_id` di semua tabel transaksi + filter server-side | — |
| CRM pipeline | Ada | Customer master + contact + opportunity + stage history | BANT/MEDDICC scoring → Phase 2 |
| Pricing wizard | VAPT/SOC/CTI | VAPT web/mobile/API/network, SOC EPS, BoQ A–E, versi kebijakan | CTI tier calculator → Phase 2 |
| Approval matrix | Ada | Engine DoA konfigurabel, aturan paling ketat, SoD, maker-checker, audit immutable | Delegasi & eskalasi SLA → Phase 2 |
| Quotation | PDF + email | Revisi, status machine, terbit hanya jika approved, HTML print/PDF via browser | Email SMTP → Phase 2 |
| AI | Anthropic saja | 6 provider + failover + redaksi + audit | RAG permission-aware → Phase 5 |

**Tindakan lanjutan:** setelah repo GitLab dapat diakses, jalankan diff modul (`icop-backend/src/routes/*`) terhadap `apps/api/src/modules/*` dan migrasikan data lewat skrip ETL, bukan overwrite.

## 5. Asumsi & informasi yang belum ada

1. Decision Record v1.0 belum diunggah — nilai DoA master prompt dipakai apa adanya.
2. DoA perusahaan terbaru belum diverifikasi (master prompt L1 mewajibkan).
3. Rate card adalah BIAYA internal (BRD §3.1), bukan harga jual.
4. Indeks CPI/FX/Market default 1.0 sampai ada sumber data resmi yang disahkan.
5. API key provider AI belum tersedia (`.env` hanya placeholder).
