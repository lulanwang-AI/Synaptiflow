import { NavLink } from "react-router-dom";
import {
  PERSONA_LABEL,
  PERSONA_ROUTES,
  usePersona,
  type Persona,
} from "../lib/persona";
import { isMockActive, setMockToggle } from "../mocks/enable";
import { api } from "../api/client";

// Only the most important steps live in the top bar; everything else is in the
// hideable sidebar.
const TOP_LINKS: { to: string; label: string }[] = [
  { to: "/", label: "Overview" },
  { to: "/discover", label: "Discover" },
  { to: "/workflow", label: "Workflow" },
];

export default function NavBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { persona, setPersona } = usePersona();
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
    window.location.reload();
  }

  function onToggleMock() {
    setMockToggle(!mock);
    window.location.reload();
  }

  return (
    <nav className="nav">
      <div className="nav-inner">
        <button
          className="hamburger"
          onClick={onToggleSidebar}
          title="Toggle menu"
          aria-label="Toggle menu"
        >
          ☰
        </button>
        <span className="nav-brand">
          <span className="brand-mark" aria-hidden="true" />
          SynaptiFlow
        </span>
        <div className="nav-links">
          {TOP_LINKS.map((l) => (
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
