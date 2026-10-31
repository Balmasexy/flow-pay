import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCIAL_EXECUTION_PERMISSIONS,
  hasStaffPermission,
  permissionsForRole
} from "./staff-permissions.js";

test("unknown and customer roles receive no staff permissions", () => {
  assert.deepEqual(permissionsForRole("unknown_role"), []);
  assert.deepEqual(permissionsForRole("customer"), []);
  assert.deepEqual(permissionsForRole("toString"), []);
  assert.deepEqual(permissionsForRole(null), []);
});

test("each staff role receives only its assigned functional permissions", () => {
  assert.equal(hasStaffPermission(["compliance_kyc_officer"], "kyc.review"), true);
  assert.equal(hasStaffPermission(["customer_support"], "kyc.review"), false);
  assert.equal(hasStaffPermission(["finance_manager"], "finance.settlement.manage"), true);
  assert.equal(hasStaffPermission(["internal_auditor"], "finance.settlement.manage"), false);
  assert.equal(hasStaffPermission(["system_administrator"], "finance.reconciliation.manage"), false);
});

test("no staff role receives financial execution permissions", () => {
  const roles = [
    "system_administrator", "compliance_kyc_officer", "risk_fraud_analyst",
    "finance_manager", "operations_officer", "customer_support", "internal_auditor"
  ];
  for (const role of roles) {
    const permissions = permissionsForRole(role);
    for (const forbidden of FINANCIAL_EXECUTION_PERMISSIONS) {
      assert.equal(permissions.includes(forbidden as never), false, `${role} must not receive ${forbidden}`);
    }
  }
});

test("multiple roles combine by explicit permission union only", () => {
  assert.equal(
    hasStaffPermission(["customer_support", "compliance_kyc_officer"], "kyc.review"),
    true
  );
  assert.equal(
    hasStaffPermission(["customer_support", "compliance_kyc_officer"], "wallet.credit" as never),
    false
  );
});
