// Hideable sidebar holding the full set of steps. The top bar keeps only the
// most important entries; everything lives here, grouped by role and toggled
// open/closed from the nav hamburger.
import { NavLink } from "react-router-dom";
import { PERSONA_ROUTES, usePersona } from "../lib/persona";

interface Item {
  to: string;
  label: string;
  n?: number;
}
interface Group {
  title: string;
  items: Item[];
}

const GROUPS: Group[] = [
  {
    title: "Monitor",
    items: [
      { to: "/", label: "Loop overview" },
      { to: "/discover", label: "Discover" },
      { to: "/screen", label: "Screening campaign" },
      { to: "/workflow", label: "Workflow" },
      { to: "/metrics", label: "Metrics" },
    ],
  },
  {
    title: "Loop steps",
    items: [
      { to: "/target", label: "Target", n: 1 },
      { to: "/submit", label: "Add data", n: 2 },
      { to: "/records", label: "Records", n: 3 },
      { to: "/acquisition", label: "Next batch", n: 4 },
      { to: "/synthesis", label: "Synthesis", n: 5 },
    ],
  },
];

export default function Sidebar({ open }: { open: boolean }) {
  const { persona } = usePersona();
  const personaRoutes = PERSONA_ROUTES[persona];
  const isPersonaHi = (to: string) =>
    personaRoutes.some((r) => (r === "/" ? to === "/" : to.startsWith(r)));

  return (
    <aside className={`sidebar${open ? "" : " closed"}`} aria-hidden={!open}>
      <div className="sidebar-inner">
        {GROUPS.map((g) => (
          <div className="sidebar-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.to === "/"}
                tabIndex={open ? 0 : -1}
                className={({ isActive }) =>
                  [
                    "sidebar-link",
                    isActive ? "active" : "",
                    isPersonaHi(it.to) ? "persona-hi" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
              >
                <span className="si-num">{it.n ?? "•"}</span>
                <span>{it.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
