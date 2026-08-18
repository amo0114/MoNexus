# ValuePolicy D-02 / D-03 Decision Record Index

| Field | Value |
| --- | --- |
| Record set | `VALUE-POLICY-OWNER-DIRECTIVE-20260818` |
| Decision date | 2026-08-18 |
| Decision authority | `github:amo0114` (`githubAccountId=108148125`), repository-owner directive |
| Implementation baseline | `c52c4a87e664f1930d857035566cbd8869e6ad3d` |
| Production mode | `off` |

The signed source files are stored outside Git in the controlled archive. This
index exposes only immutable references, hashes, scope, and limitations needed
by the governance API and reviewers. It does not claim independent legal
identity verification or invent separate product, finance, legal, and technical
signers.

## D-02

```text
D-02 STATUS: APPROVED — PRELAUNCH NO-REPRESENTATIVE-DATA EXCEPTION
100 PTS = 1 CNY
referenceAtomicPerPointNumerator = 1
referenceAtomicPerPointDenominator = 1
roundingMode = HALF_EVEN
```

- record ref: `controlled-archive://value-policy-decisions/20260818-owner-directive/d02-100pts-per-cny-v1.json`
- record SHA-256: `02a0d6642fec6cf542805d20970eb9d489dae8180775bc719349d1153867a998`
- source-discovery SHA-256: `06d58ef1263f934b5b7d203810c8081dd6cf006a74b7a8f300c757ef6a934851`
- effective not before: `2026-08-26T00:00:00Z`
- authorized scope: staging shadow, staging enforce, and a later separately
  gated production shadow
- not authorized: production enforce
- mandatory superseding review: representative real-data backtest before
  production enforce, or as soon as eligible representative data exists

Synthetic fixtures were not used as decision evidence. The exception exists
because source discovery found no eligible representative production data.

## D-03

```text
D-03 STATUS: APPROVED
disclosureVersion = zh-CN-v1
积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。
```

- record ref: `controlled-archive://value-policy-decisions/20260818-owner-directive/d03-disclosure-zh-cn-v1.json`
- record SHA-256: `72c148a645f9aaff6deb656757d6637e5688c1a987a76830badf6786464a2971`
- approved surfaces: current-policy API disclosure and future authenticated
  product/order value displays
- prohibited claims remain: cash redemption, reserve backing, accounting
  liability, or guaranteed exchangeability

## Archive Manifest

- manifest ref: `controlled-archive://value-policy-decisions/20260818-owner-directive/manifest.json`
- manifest SHA-256: `ca10951739de77401a620aaa1bc348a75df82a1b11ff48b300c1cbee54b3327a`
- local operator path: intentionally omitted from Git

These approvals do not create, schedule, or activate a ValuePolicy. Production
must remain `POINT_VALUE_POLICY_MODE=off` until the independent rollout gates
are completed.
