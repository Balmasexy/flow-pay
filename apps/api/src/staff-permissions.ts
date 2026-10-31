/**
 * FlowPay's canonical staff permission policy.
 *
 * This is policy metadata only. A permission is not effective at an API route
 * until that route explicitly calls requireStaffPermission before doing work.
 * Unknown roles and permissions fail closed.
 */
export const STAFF_PERMISSIONS = [
  "system.health.read",
  "system.configuration.read",
  "system.configuration.write",
  "kyc.queue.read",
  "kyc.review",
  "risk.cases.read",
  "risk.cases.manage",
  "finance.reports.read",
  "finance.reconciliation.read",
  "finance.reconciliation.manage",
  "finance.settlement.read",
  "finance.settlement.manage",
  "operations.transactions.read",
  "operations.exceptions.manage",
  "support.customer.read",
  "support.customer.notes.write",
  "audit.records.read"
] as const;

export type StaffPermission = typeof STAFF_PERMISSIONS[number];
export type StaffRole =
  | "system_administrator"
  | "compliance_kyc_officer"
  | "risk_fraud_analyst"
  | "finance_manager"
  | "operations_officer"
  | "customer_support"
  | "internal_auditor";

const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly StaffPermission[]>> = {
  system_administrator: [
    "system.health.read", "system.configuration.read", "system.configuration.write"
  ],
  compliance_kyc_officer: ["kyc.queue.read", "kyc.review"],
  risk_fraud_analyst: ["risk.cases.read", "risk.cases.manage", "operations.transactions.read"],
  finance_manager: [
    "finance.reports.read", "finance.reconciliation.read", "finance.reconciliation.manage",
    "finance.settlement.read", "finance.settlement.manage"
  ],
  operations_officer: ["operations.transactions.read", "operations.exceptions.manage"],
  customer_support: ["support.customer.read", "support.customer.notes.write"],
  internal_auditor: [
    "system.health.read", "system.configuration.read", "kyc.queue.read", "risk.cases.read",
    "finance.reports.read", "finance.reconciliation.read", "finance.settlement.read",
    "operations.transactions.read", "support.customer.read", "audit.records.read"
  ]
};

export function permissionsForRole(roleCode: string | null | undefined): readonly StaffPermission[] {
  if (!roleCode || !Object.hasOwn(ROLE_PERMISSIONS, roleCode)) return [];
  return ROLE_PERMISSIONS[roleCode as StaffRole];
}

export function hasStaffPermission(
  roleCodes: readonly string[],
  permission: StaffPermission
): boolean {
  return roleCodes.some((role) => permissionsForRole(role).includes(permission));
}

/** Financial execution is deliberately not granted to any staff role. */
export const FINANCIAL_EXECUTION_PERMISSIONS: readonly string[] = [
  "wallet.credit", "wallet.debit", "transfer.execute", "withdrawal.approve",
  "refund.execute", "card.issue", "card.charge", "payment.release"
];
