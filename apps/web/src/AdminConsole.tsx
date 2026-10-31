import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, ShieldCheck, Users, Settings, LockKeyhole } from "lucide-react";

const API_URL = (import.meta.env.VITE_API_BASE_URL || "https://flowpay-backend-qz79.onrender.com").replace(/\/$/, "");
const AUTH_URL = (import.meta.env.VITE_NEON_AUTH_URL || "").replace(/\/$/, "");

type Tier = {
  tier_key: "tier_1" | "tier_2" | "tier_3";
  display_name: string;
  max_balance_minor: string | null;
  daily_transaction_limit_minor: string | null;
  per_transaction_limit_minor: string | null;
  requires_bvn: boolean;
  requires_nin: boolean;
  requires_proof_of_address: boolean;
  automatic_upgrade: boolean;
};
type Role = { role_code: string; display_name: string; description: string; is_assignable: boolean; assigned_users: number };
type AdminUser = {
  id: string; email: string | null; status: string; legacy_role: string;
  assigned_role_code: string | null; assigned_role_name: string | null; created_at: string;
};

async function accessToken(): Promise<string | null> {
  if (!AUTH_URL) return null;
  try {
    const response = await fetch(`${AUTH_URL}/token`, { credentials: "include", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    const session = typeof body.session === "object" && body.session !== null ? body.session as Record<string, unknown> : {};
    return [body.access_token, body.token, session.access_token].find((v): v is string => typeof v === "string" && v.split(".").length === 3) ?? null;
  } catch { return null; }
}

function minorToMajor(value: string | null): string {
  if (value === null) return "";
  try { return (Number(BigInt(value)) / 100).toFixed(2); } catch { return ""; }
}
function majorToMinor(value: string): string | null {
  if (!value.trim()) return null;
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(value.trim())) throw new Error("Enter a valid NGN amount with up to two decimal places, or leave blank for unlimited/not set.");
  const [whole, fraction = ""] = value.trim().split(".");
  return (BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2))).toString();
}
function naira(value: string | null): string {
  if (value === null) return "Unlimited / not set";
  return `₦${minorToMajor(value)}`;
}

export default function AdminConsole() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { display_name: string; max: string; daily: string; per: string; bvn: boolean; nin: boolean; address: boolean; automatic: boolean }>>({});
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading Super Admin settings…");
  const [denied, setDenied] = useState(false);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const token = await accessToken();
    if (!token) throw new Error("Please sign in through FlowPay before opening the administration console.");
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}`, ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (HTTP ${response.status})`);
    return body as T;
  }, []);

  const load = useCallback(async () => {
    setBusy(true); setDenied(false); setMessage("Loading current configuration…");
    try {
      const [tierData, roleData, userData] = await Promise.all([
        request<{ tiers: Tier[] }>("/v1/admin/tiers"),
        request<{ roles: Role[] }>("/v1/admin/roles"),
        request<{ users: AdminUser[] }>("/v1/admin/users?limit=150")
      ]);
      setTiers(tierData.tiers); setRoles(roleData.roles); setUsers(userData.users);
      setDrafts(Object.fromEntries(tierData.tiers.map((t) => [t.tier_key, {
        display_name: t.display_name, max: minorToMajor(t.max_balance_minor), daily: minorToMajor(t.daily_transaction_limit_minor),
        per: minorToMajor(t.per_transaction_limit_minor), bvn: t.requires_bvn, nin: t.requires_nin,
        address: t.requires_proof_of_address, automatic: t.automatic_upgrade
      }])));
      setAssignments(Object.fromEntries(userData.users.map((u) => [u.id, u.assigned_role_code ?? ""])));
      setMessage("Live Super Admin configuration loaded from the authenticated API.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ADMIN_CONFIGURATION_UNAVAILABLE";
      setDenied(reason === "SUPER_ADMIN_REQUIRED");
      setMessage(reason);
      setTiers([]); setRoles([]); setUsers([]);
    } finally { setBusy(false); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  async function saveTier(tier: Tier) {
    const draft = drafts[tier.tier_key];
    if (!draft) return;
    setBusy(true); setMessage(`Saving ${draft.display_name}…`);
    try {
      await request(`/v1/admin/tiers/${tier.tier_key}`, { method: "PUT", body: JSON.stringify({
        displayName: draft.display_name,
        maxBalanceMinor: majorToMinor(draft.max),
        dailyTransactionLimitMinor: majorToMinor(draft.daily),
        perTransactionLimitMinor: majorToMinor(draft.per),
        requiresBvn: draft.bvn, requiresNin: draft.nin,
        requiresProofOfAddress: draft.address, automaticUpgrade: draft.automatic
      }) });
      setMessage(`${draft.display_name} configuration saved and audit-recorded.`);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save tier configuration."); setBusy(false); }
  }

  async function assignRole(user: AdminUser) {
    const roleCode = assignments[user.id] ?? "";
    if (!roleCode) { setMessage("Select a staff role first."); return; }
    setBusy(true); setMessage("Saving staff assignment…");
    try {
      await request(`/v1/admin/users/${user.id}/role`, { method: "POST", body: JSON.stringify({ roleCode }) });
      setMessage("Staff role assigned and audit-recorded."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to assign staff role."); setBusy(false); }
  }

  async function removeRole(user: AdminUser) {
    if (!window.confirm(`Remove the assigned staff role for ${user.email ?? user.id}?`)) return;
    setBusy(true); setMessage("Removing staff assignment…");
    try {
      await request(`/v1/admin/users/${user.id}/role`, { method: "DELETE" });
      setMessage("Staff role removed and audit-recorded."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to remove staff role."); setBusy(false); }
  }

  const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, border: "1px solid #deded8", borderRadius: 8, padding: "10px 11px", font: "inherit", fontSize: 13, background: "#fff" };
  const labelStyle: React.CSSProperties = { display: "grid", gap: 6, color: "#64655f", fontSize: 11, fontWeight: 600 };

  return <main style={{ minHeight: "100vh", background: "#f6f6f3", color: "#222321", padding: "24px clamp(14px, 4vw, 48px) 48px", fontFamily: '"DM Sans", sans-serif' }}>
    <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gap: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="/app" aria-label="Back to FlowPay" style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 10, background: "#fff", border: "1px solid #e6e6e0", color: "#333" }}><ArrowLeft size={18} /></a>
          <div><div style={{ color: "#ff7a18", fontSize: 10, fontWeight: 800, letterSpacing: 1.6 }}>FLOWPAY BANKING</div><h1 style={{ fontSize: 25, margin: "4px 0 0" }}>Super Admin console</h1></div>
        </div>
        <button onClick={() => void load()} disabled={busy} style={{ border: "1px solid #e2e2dc", borderRadius: 9, background: "#fff", padding: "10px 13px", display: "flex", gap: 8, alignItems: "center" }}><RefreshCw size={15} /> Refresh</button>
      </header>

      <section style={{ background: "#fff7f0", border: "1px solid #ffe3cc", borderRadius: 12, padding: 16, display: "flex", gap: 12 }}>
        <ShieldCheck color="#ff7a18" size={21} />
        <div><strong style={{ fontSize: 13 }}>Restricted administration</strong><p style={{ color: "#806c5c", fontSize: 12, lineHeight: 1.6, marginTop: 5 }}>Every request is checked by the backend against the active Super Admin account. Changes are audit-recorded. This console does not approve payments, move money, or verify identity documents.</p></div>
      </section>

      <p role="status" style={{ fontSize: 12, color: denied ? "#b23d35" : "#6b6c65" }}>{message}</p>
      {denied ? <section style={{ background: "#fff", border: "1px solid #e8e8e2", borderRadius: 12, padding: 22, display: "grid", justifyItems: "start", gap: 10 }}><LockKeyhole color="#bb5148" size={26} /><h2 style={{ margin: 0, fontSize: 18 }}>Super Admin access required</h2><p style={{ fontSize: 13, color: "#777", lineHeight: 1.6 }}>This account is not currently authorized to manage FlowPay tiers or staff roles. No controls have been enabled.</p><a href="/login" style={{ color: "#c45d10", fontSize: 13 }}>Return to sign in</a></section> : <>
        <section style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Settings size={19} color="#ff7a18" /><h2 style={{ fontSize: 17, margin: 0 }}>Customer tier limits</h2></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 310px), 1fr))", gap: 14 }}>
            {tiers.map((tier) => {
              const d = drafts[tier.tier_key];
              if (!d) return null;
              return <article key={tier.tier_key} style={{ background: "#fff", border: "1px solid #e8e8e2", borderRadius: 12, padding: 17, display: "grid", gap: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><strong>{tier.tier_key.replace("_", " ").toUpperCase()}</strong><span style={{ color: "#9a6a42", fontSize: 11 }}>{tier.display_name}</span></div>
                <label style={labelStyle}>Display name<input style={inputStyle} value={d.display_name} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], display_name: e.target.value } }))} /></label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                  <label style={labelStyle}>Maximum balance (₦)<input style={inputStyle} inputMode="decimal" placeholder="Blank = unlimited" value={d.max} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], max: e.target.value } }))} /></label>
                  <label style={labelStyle}>Daily limit (₦)<input style={inputStyle} inputMode="decimal" placeholder="Blank = unlimited" value={d.daily} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], daily: e.target.value } }))} /></label>
                </div>
                <label style={labelStyle}>Per-transaction limit (₦)<input style={inputStyle} inputMode="decimal" placeholder="Blank = not set" value={d.per} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], per: e.target.value } }))} /></label>
                <div style={{ display: "grid", gap: 9, fontSize: 12 }}>
                  <label><input type="checkbox" checked={d.bvn} disabled onChange={() => undefined} /> BVN required (cannot be disabled)</label>
                  <label><input type="checkbox" checked={d.nin} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], nin: e.target.checked } }))} /> NIN required</label>
                  <label><input type="checkbox" checked={d.address} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], address: e.target.checked } }))} /> Proof of address required</label>
                  <label><input type="checkbox" checked={d.automatic} onChange={e => setDrafts(p => ({ ...p, [tier.tier_key]: { ...p[tier.tier_key], automatic: e.target.checked } }))} /> Automatic upgrade when requirements are verified</label>
                </div>
                <div style={{ borderTop: "1px solid #eee", paddingTop: 11, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#858780", fontSize: 10 }}>Balance: {naira(tier.max_balance_minor)}</span>
                  <button disabled={busy} onClick={() => void saveTier(tier)} style={{ border: 0, borderRadius: 8, background: "#ff7a18", color: "#fff", padding: "10px 13px", fontWeight: 700, fontSize: 11 }}>Save tier</button>
                </div>
              </article>;
            })}
          </div>
        </section>

        <section style={{ background: "#fff", border: "1px solid #e8e8e2", borderRadius: 12, padding: 18, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Users size={19} color="#ff7a18" /><div><h2 style={{ fontSize: 17, margin: 0 }}>Customer and staff directory</h2><p style={{ color: "#858780", fontSize: 11, marginTop: 4 }}>Up to 150 most recently created accounts; sensitive identity numbers are not shown.</p></div></div>
          {users.length ? <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, textAlign: "left" }}><thead><tr>{["Account","Status","Current staff role","Assign role","Action"].map(h => <th key={h} style={{ padding: "10px 8px", borderBottom: "1px solid #e9e9e3", color: "#858780" }}>{h}</th>)}</tr></thead><tbody>
            {users.map(user => <tr key={user.id}><td style={{ padding: "12px 8px", borderBottom: "1px solid #f0f0ec", minWidth: 180 }}><strong>{user.email ?? "Email unavailable"}</strong><div style={{ color: "#999", marginTop: 4 }}>{user.id}</div></td><td style={{ padding: 8 }}>{user.status}</td><td style={{ padding: 8 }}>{user.legacy_role === "admin" ? "Super Admin" : user.assigned_role_name ?? "Customer (no staff role)"}</td><td style={{ padding: 8, minWidth: 180 }}><select style={inputStyle} value={assignments[user.id] ?? ""} onChange={e => setAssignments(p => ({ ...p, [user.id]: e.target.value }))}><option value="">Select role…</option>{roles.filter(r => r.is_assignable).map(r => <option key={r.role_code} value={r.role_code}>{r.display_name}</option>)}</select></td><td style={{ padding: 8, whiteSpace: "nowrap" }}><button disabled={busy || user.legacy_role === "admin"} onClick={() => void assignRole(user)} style={{ border: 0, background: "#fff0e4", color: "#a54b08", padding: "8px 9px", borderRadius: 7, marginRight: 5 }}>Assign</button>{user.assigned_role_code && <button disabled={busy || user.legacy_role === "admin"} onClick={() => void removeRole(user)} style={{ border: "1px solid #e5e5df", background: "#fff", color: "#555", padding: "8px 9px", borderRadius: 7 }}>Remove</button>}</td></tr>)}
          </tbody></table></div> : <p style={{ color: "#858780", fontSize: 12 }}>No user records returned.</p>}
        </section>

        <section style={{ background: "#fff", border: "1px solid #e8e8e2", borderRadius: 12, padding: 18 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Role catalogue</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>{roles.map(role => <article key={role.role_code} style={{ border: "1px solid #eee", borderRadius: 9, padding: 12 }}><strong style={{ fontSize: 12 }}>{role.display_name}</strong><p style={{ color: "#858780", fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>{role.description}</p><span style={{ color: "#9a6a42", fontSize: 10 }}>{role.assigned_users} assigned</span></article>)}</div>
        </section>
      </>}
      <footer style={{ borderTop: "1px solid #e6e6e0", paddingTop: 15, color: "#999", fontSize: 10 }}>FlowPay administration · Financial actions and KYC decisions are not performed in this console.</footer>
    </div>
  </main>;
}
