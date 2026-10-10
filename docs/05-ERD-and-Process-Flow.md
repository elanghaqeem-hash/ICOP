# ERD & Process Flow

## 1. ERD Phase 1 (terimplementasi)

```mermaid
erDiagram
  TENANT ||--o{ USER : has
  TENANT ||--o{ CUSTOMER : owns
  CUSTOMER ||--o{ CONTACT : has
  CUSTOMER ||--o{ OPPORTUNITY : has
  CUSTOMER ||--o{ ACTIVITY : logs
  CUSTOMER |o--o{ CUSTOMER : parent_of
  OPPORTUNITY ||--o{ OPPORTUNITY_STAGE_HISTORY : tracks
  OPPORTUNITY ||--o{ ASSESSMENT : scoped_by
  OPPORTUNITY ||--o{ PRICING_SCENARIO : priced_by
  ASSESSMENT |o--o{ PRICING_SCENARIO : feeds
  POLICY ||--o{ PRICING_SCENARIO : version_used
  OPPORTUNITY ||--o{ QUOTATION : has
  PRICING_SCENARIO |o--o{ QUOTATION : basis
  QUOTATION ||--|{ QUOTATION_LINE : contains
  QUOTATION ||--o{ QUOTATION_REVISION : snapshots
  CATALOG_ITEM |o--o{ QUOTATION_LINE : references
  QUOTATION ||--o{ APPROVAL_REQUEST : requires
  POLICY ||--o{ APPROVAL_REQUEST : evaluated_with
  APPROVAL_REQUEST ||--|{ APPROVAL_STEP : chain
  APPROVAL_STEP ||--o{ APPROVAL_DECISION : immutable
  USER ||--o{ NOTIFICATION : receives
  TENANT ||--o{ AUDIT_EVENT : append_only
  TENANT ||--o{ AI_PROVIDER : configures
  TENANT ||--o{ AI_CALL : logs
```

Semua tabel transaksi memiliki `tenant_id`, `created_at`, aktor, dan kunci UUID. Tabel bertanda append-only dijaga trigger `forbid_mutation()`: `audit_events`, `approval_decisions`, `quotation_revisions`, `pricing_scenarios`, `ai_calls`.

### Entitas Phase 2–5 (direncanakan, belum dibuat)
Tender, TenderRequirement, Vendor, PriceList, FlexGuardWallet, WalletTransaction (ledger immutable, reversal-only), ServiceRequest, Proposal, Document, Contract, Acceptance, Project, ResourceAllocation, Timesheet, Deliverable, Invoice, Payment, Partner, SupportTicket, Renewal.

## 2. Alur Phase 1 (end-to-end yang sudah berjalan)

```mermaid
flowchart LR
  A[Customer master<br/>dedup nama+NPWP] --> B[Opportunity LEAD]
  B --> C[QUALIFIED] --> D[SCOPING]
  D --> E[Assessment VAPT/SOC<br/>auto-save, completeness]
  E --> F[Kalkulasi MD / EPS<br/>ENGINEER_REVIEW_REQUIRED]
  F --> G[Review Pre-Sales<br/>REVIEWED]
  G --> H[Pricing scenario<br/>BoQ A–E, Floor/Std/Premium<br/>snapshot immutable]
  H --> I[Quotation DRAFT<br/>stage → PROPOSAL]
  I --> J[Submit → DoA engine<br/>most stringent, chain]
  J --> K{Manager → VP → Direktur<br/>SoD, four-eyes, versi}
  K -- revisi/tolak --> I
  K -- approved --> L[ISSUED<br/>surat penawaran]
  L --> M[SENT ke portal<br/>stage → NEGOTIATION]
  M --> N{Customer}
  N -- terima --> O[ACCEPTED → handover contracting<br/>WON diperbolehkan]
  N -- minta revisi --> I
```

| Tahap | Owner | Entry | Exit | Audit |
|---|---|---|---|---|
| Customer | Account Manager | — | Customer unik tersimpan | `customer.create` |
| Scoping | Pre-Sales | Opportunity SCOPING | Assessment REVIEWED | `assessment.calculate/review` |
| Pricing | Pre-Sales/Finance | Assessment REVIEWED | Scenario tersimpan (syarat stage PROPOSAL) | `pricing.scenario_saved` |
| Quotation | Account Manager | Scenario | Submit | `quotation.create/update/submit` |
| Approval | Manager/VP/Direktur | IN_APPROVAL | APPROVED/REJECTED/REVISION | `approval.*` + `approval_decisions` |
| Issue & send | Account Manager | APPROVED (versi sama) | SENT | `quotation.issue/sent` |
| Acceptance | Customer user | SENT, masih berlaku | ACCEPTED → contracting | `portal.quotation_*` |
