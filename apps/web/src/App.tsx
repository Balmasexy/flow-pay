import { useEffect, useState } from "react";
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell,
  CheckCircle2, CircleHelp, Clock3, CreditCard, Home,
  Menu, RefreshCw, ShieldCheck, Wallet, X
} from "lucide-react";

const API_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

type ApiStatus = "checking" | "connected" | "unavailable";
type Page = "Overview" | "Transfers" | "Cards" | "Activity";

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [apiMessage, setApiMessage] = useState("Checking API connection…");
  const [page, setPage] = useState<Page>("Overview");
  const [menuOpen, setMenuOpen] = useState(false);

  async function checkApi() {
    if (!API_URL) {
      setApiStatus("unavailable");
      setApiMessage("API URL not configured");
      return;
    }

    setApiStatus("checking");
    setApiMessage("Checking API connection…");

    try {
      const response = await fetch(`${API_URL}/health`, {
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: { status?: string } = await response.json();
      if (data.status !== "ok") throw new Error("Unexpected API response");

      setApiStatus("connected");
      setApiMessage("API connected");
    } catch {
      setApiStatus("unavailable");
      setApiMessage("API unavailable — check deployment and CORS");
    }
  }

  useEffect(() => {
    void checkApi();
  }, []);

  const nav = [
    { name: "Overview" as const, icon: Home },
    { name: "Transfers" as const, icon: ArrowLeftRight },
    { name: "Cards" as const, icon: CreditCard },
    { name: "Activity" as const, icon: Clock3 }
  ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>flow<span className="brand-accent">pay</span></span>
          <button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <div className="workspace-label">YOUR FINANCES</div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={`nav-item ${page === name ? "nav-active" : ""}`}
              onClick={() => {
                setPage(name);
                setMenuOpen(false);
              }}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name !== "Overview" && <span className="coming-soon">Soon</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="security-note">
            <ShieldCheck size={20} />
            <div>
              <strong>Security first</strong>
              <span>Never share your PIN or password.</span>
            </div>
          </div>
          <div className="profile">
            <div className="avatar">F</div>
            <div className="profile-info">
              <strong>FlowPay</strong>
              <span>Customer preview</span>
            </div>
            <CircleHelp size={18} className="muted-icon" />
          </div>
        </div>
      </aside>

      {menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="breadcrumb">Workspace <span>/</span> <strong>{page}</strong></div>
          <div className="topbar-right">
            <span className={`api-indicator api-${apiStatus}`}>
              <span className="status-dot" />
              {apiMessage}
            </span>
            <button className="icon-button notification-button" aria-label="Notifications">
              <Bell size={19} />
            </button>
          </div>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR MONEY, IN VIEW</div>
              <h1>{page === "Overview" ? "Welcome to FlowPay" : page}</h1>
              <p className="subtitle">
                {page === "Overview"
                  ? "A clearer view of your financial life starts here."
                  : "This feature is part of the planned FlowPay experience."}
              </p>
            </div>
            <button className="refresh-button" onClick={() => void checkApi()}>
              <RefreshCw size={16} /> Check connection
            </button>
          </div>

          <section className="notice">
            <div className="notice-icon"><ShieldCheck size={21} /></div>
            <div>
              <strong>Development preview</strong>
              <p>This dashboard is connected only to the API health endpoint. No customer balances, transactions, cards, or payment actions are available yet.</p>
            </div>
          </section>

          <section className="section-heading">
            <div>
              <h2>Account overview</h2>
              <p>Your account information will appear here when secure account services are implemented.</p>
            </div>
            <span className="preview-label">PREVIEW</span>
          </section>

          <section className="stat-grid">
            <article className="stat-card balance-card">
              <div className="stat-top"><span>Available balance</span><Wallet size={19} /></div>
              <div className="balance-value">Not available</div>
              <div className="stat-foot">Awaiting verified account data</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>Money received</span><ArrowDownLeft size={19} /></div>
              <div className="stat-value">—</div>
              <div className="stat-foot">No transaction data connected</div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span>Money sent</span><ArrowUpRight size={19} /></div>
              <div className="stat-value">—</div>
              <div className="stat-foot">No transaction data connected</div>
            </article>
          </section>

          <section className="lower-grid">
            <article className="panel activity-panel">
              <div className="panel-heading">
                <div><h2>Recent activity</h2><p>Your latest account movements</p></div>
                <Clock3 size={20} />
              </div>
              <div className="empty-state">
                <div className="empty-icon"><ArrowLeftRight size={23} /></div>
                <strong>No activity to display</strong>
                <span>Transactions will appear once the secure ledger and account services are ready.</span>
              </div>
            </article>

            <article className="panel connection-panel">
              <div className="panel-heading">
                <div><h2>System status</h2><p>Frontend to backend connectivity</p></div>
                <CheckCircle2 size={20} />
              </div>
              <div className="connection-row">
                <span>Customer interface</span><span className="status-ok"><CheckCircle2 size={15} /> Running</span>
              </div>
              <div className="connection-row">
                <span>API health endpoint</span>
                <span className={apiStatus === "connected" ? "status-ok" : apiStatus === "checking" ? "status-wait" : "status-error"}>
                  <span className="status-dot" />{apiStatus === "connected" ? "Connected" : apiStatus === "checking" ? "Checking" : "Unavailable"}
                </span>
              </div>
              <div className="connection-row">
                <span>Database-backed accounts</span><span className="status-wait">Not configured</span>
              </div>
              <div className="connection-row">
                <span>Payments</span><span className="status-wait">Disabled</span>
              </div>
              <p className="connection-help">The API indicator tests <code>/health</code>; it does not certify database readiness or payment functionality.</p>
            </article>
          </section>

          <footer>
            <span>© {new Date().getFullYear()} FlowPay</span>
            <span>Independent product · Development preview</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
