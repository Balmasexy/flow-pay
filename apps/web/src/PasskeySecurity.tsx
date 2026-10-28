import { useEffect, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

type Passkey = { id: string; name: string; device_type: string | null; backed_up: boolean; created_at: string; last_used_at: string | null };
type ApiOptions = { ceremonyId: string; options: Record<string, unknown> };

type Props = { apiUrl: string; getAccessToken: () => Promise<string | null> };

export default function PasskeySecurity({ apiUrl, getAccessToken }: Props) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Load your registered passkeys.");
  const [name, setName] = useState("My passkey");

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const token = await getAccessToken();
    if (!token) throw new Error("Please sign in again before managing passkeys.");
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store"
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
    return data as T;
  }

  async function refresh() {
    setBusy(true);
    try {
      const result = await request<{ passkeys: Passkey[] }>("/v1/me/passkeys");
      setPasskeys(result.passkeys);
      setMessage(result.passkeys.length ? "Passkeys loaded for this signed-in account." : "No passkeys registered yet.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load passkeys.");
    } finally { setBusy(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function register() {
    setBusy(true);
    setMessage("Starting secure passkey registration…");
    try {
      const start = await request<ApiOptions>("/v1/me/passkeys/register/options", "POST", {});
      const response = await startRegistration({ optionsJSON: start.options as never });
      await request("/v1/me/passkeys/register/verify", "POST", {
        ceremonyId: start.ceremonyId, response, name: name.trim() || "Passkey",
        transports: response.response.transports ?? []
      });
      setMessage("Passkey registered successfully for this account.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Passkey registration failed.");
    } finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true);
    setMessage("Verify with a registered passkey…");
    try {
      const start = await request<ApiOptions>("/v1/me/passkeys/auth/options", "POST", {});
      const response = await startAuthentication({ optionsJSON: start.options as never });
      const result = await request<{ verified: boolean; message?: string }>("/v1/me/passkeys/auth/verify", "POST", { ceremonyId: start.ceremonyId, response });
      setMessage(result.verified ? "Passkey verification succeeded. Payments and transfers remain disabled." : "Passkey verification was not accepted.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Passkey verification failed.");
    } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this passkey from your FlowPay account?")) return;
    setBusy(true);
    try {
      await request(`/v1/me/passkeys/${id}`, "DELETE");
      setMessage("Passkey revoked.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not revoke passkey.");
    } finally { setBusy(false); }
  }

  return (
    <section className="panel profile-summary-panel">
      <div className="panel-heading"><div><h2>Passkeys</h2><p>Register a device credential or verify with one you already enrolled.</p></div><KeyRound size={21} /></div>
      <div className="registration-unavailable">
        <label htmlFor="passkey-name">Passkey name</label>
        <input id="passkey-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} disabled={busy} />
        <p>Use your device's built-in screen lock, fingerprint, or face unlock when prompted. FlowPay stores the public credential, not your biometric sample or private key.</p>
      </div>
      <div className="history-footer">
        <button className="feature-button" onClick={() => void register()} disabled={busy}><KeyRound size={17} /> Register passkey</button>
        <button className="refresh-button" onClick={() => void verify()} disabled={busy || passkeys.length === 0}><ShieldCheck size={17} /> Verify passkey</button>
        <button className="refresh-button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={16} /> Refresh</button>
      </div>
      <p role="status" aria-live="polite">{message}</p>
      {passkeys.map((passkey) => (
        <div className="transaction-row" key={passkey.id}>
          <span className="transaction-symbol"><KeyRound size={18} /></span>
          <div className="transaction-copy"><strong>{passkey.name}</strong><span>Added {new Date(passkey.created_at).toLocaleString()} · {passkey.device_type ?? "Device type unavailable"}</span></div>
          <button className="icon-button" aria-label={`Revoke ${passkey.name}`} onClick={() => void revoke(passkey.id)} disabled={busy}><Trash2 size={17} /></button>
        </div>
      ))}
      <p className="muted-copy">Passkey verification currently applies only as an additional check inside an existing Neon Auth session. It does not create a new session or activate financial actions.</p>
    </section>
  );
}
