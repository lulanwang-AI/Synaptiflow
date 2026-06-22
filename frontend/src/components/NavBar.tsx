import { NavLink, useLocation } from "react-router-dom";
import {
  PERSONA_LABEL,
  PERSONA_ROUTES,
  usePersona,
  type Persona,
} from "../lib/persona";
import { isMockActive, setMockToggle } from "../mocks/enable";
import { api } from "../api/client";

const LINKS: { to: string; label: string }[] = [
  { to: "/", label: "Loop overview" },
  { to: "/workflow", label: "Workflow" },
  { to: "/target", label: "Target" },
  { to: "/submit", label: "Add data" },
  { to: "/records", label: "Records" },
  { to: "/acquisition", label: "Next batch" },
  { to: "/synthesis", label: "Synthesis" },
  { to: "/metrics", label: "Metrics" },
];

export default function NavBar() {
  const { persona, setPersona } = usePersona();
  const location = useLocation();
  const mock = isMockActive();
  const personaRoutes = PERSONA_ROUTES[persona];

  const isPersonaHi = (to: string) =>
    personaRoutes.some((r) => (r === "/" ? to === "/" : to.startsWith(r)));

  async function onReset() {
    if (!confirm("Reset demo data to the seeded state?")) return;
    try {
      await api.reset();
    } catch (e) {
      alert(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // simplest reliable refresh of all views after reset
    window.location.reload();
  }

  function onToggleMock() {
    setMockToggle(!mock);
    window.location.reload();
  }

  return (
    <nav className="nav">
      <div className="nav-inner">
        <span className="nav-brand">Closed-Loop Discovery</span>
        <div className="nav-links">
          {LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) =>
                [
                  "nav-link",
                  isActive ? "active" : "",
                  isPersonaHi(l.to) ? "persona-hi" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
            >
              {l.label}
            </NavLink>
          ))}
          {/* compound route has no top-level link; highlight when active */}
          {location.pathname.startsWith("/compound") && (
            <span className="nav-link active">Compound</span>
          )}
        </div>
        <div className="nav-spacer" />
        <div className="nav-controls">
          <span className="persona-select">
            Persona:{" "}
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value as Persona)}
            >
              {(Object.keys(PERSONA_LABEL) as Persona[]).map((p) => (
                <option key={p} value={p}>
                  {PERSONA_LABEL[p]}
                </option>
              ))}
            </select>
          </span>
          <span
            className={`badge ${mock ? "badge-mock" : "badge-live"}`}
            title={
              mock
                ? "Using the in-browser MSW mock backend"
                : "Talking to the live backend"
            }
            onClick={onToggleMock}
            style={{ cursor: "pointer" }}
          >
            {mock ? "MOCK" : "LIVE"}
          </span>
          <button className="btn" onClick={onReset}>
            Reset demo
          </button>
        </div>
      </div>
    </nav>
  );
}
