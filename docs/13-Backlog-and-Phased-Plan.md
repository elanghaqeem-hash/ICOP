# Implementation Backlog & Phased Delivery Plan

| Phase | Isi | Status | Acceptance gate |
|---|---|---|---|
| 0 | Audit artefak, rekonsiliasi pricing & DoA, ERD, arsitektur, threat model | **Selesai — disahkan owner 2026-10-09** | — |
| 1 | Auth/RBAC, tenant, Customer master, CRM pipeline, Deal 360, katalog, Smart Scoping VAPT/SOC, Pricing engine + scenario, Quotation, Approval engine & Decision Center, Portal acceptance, Dashboard KPI, AI gateway 7 provider, PWA mobile-first | **Selesai — functional gate PASS** | `14-…` |
| 2 | Tender Center, Bid/No-Bid, RKS extraction + compliance matrix, Proposal Generator (DOCX/PDF, source traceability, claim guard), vendor price list & BOM, CTI & GRC scoping, simulasi, delegasi & eskalasi SLA | **Selesai — functional gate PASS** | #11, #12 → `15-…` |
| 2b | Form admin API key AI terenkripsi + urutan failover + aktivasi per fitur; Document Center: worker OCR (Tesseract), kompresi, batas 300 hal/50 MB, analisis AI terverifikasi | **Selesai — functional gate PASS** (+ SMTP, integrasi admin, MinIO/S3, feed tender, template legal di `17-…`) | `16-…`, `17-…` |
| 3 | FlexGuard calculator & wallet ledger (reserve/consume/reversal, immutable), service request, Contract lifecycle, e-sign abstraction, project handover | **Selesai — functional gate PASS** (+ VIDA tersertifikasi & tombol pengesahan FlexGuard di `17-…`; Privy menunggu spesifikasi API) | #8, #9, #10 → `16-…` |
| 4 | Project delivery (WBS, timesheet, BAST, change request), ingest VAPT/SOC via API key, Helpdesk & SLA, renewal H-180/90/60/30, invoicing, pembayaran, aging & dunning | **Selesai — functional gate PASS** | `17-…` |
| 5 | AI assistant RAG permission-aware, Tender assistant, customer chatbot, BI drill-down, MFA, BFF cookie, SAST/DAST, load test, backup/restore drill, UAT, go-live | Backlog | #15, #18, #20 |

## Backlog prioritas Phase 5 (berikutnya)

1. Adapter Privy setelah spesifikasi API resmi diterima; uji VIDA dengan kredensial sandbox VIDA yang asli.
2. Keamanan: MFA, BFF cookie httpOnly, SAST/DAST, rotasi `SECRETS_MASTER_KEY`, pembatasan egress per integrasi.
3. Operasional: backup/restore drill (DB + bucket), load test, monitoring & alerting, worker terpisah.
4. Helpdesk lanjutan: jam kerja/kalender libur & jeda SLA saat menunggu customer, SLA per kontrak.
5. Faktur pajak (e-Faktur/Coretax) & integrasi akuntansi; nota kredit/koreksi.
6. AI assistant RAG permission-aware, BI drill-down, UAT bersama tim DEIT, go-live.
