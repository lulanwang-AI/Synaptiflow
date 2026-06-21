import { createContext, useContext, useState, type ReactNode } from "react";

export type Persona = "scientist" | "ml" | "manager";

export const PERSONA_LABEL: Record<Persona, string> = {
  scientist: "Bench scientist",
  ml: "ML engineer / comp chemist",
  manager: "Engineering manager",
};

// Which routes each persona cares about (used to emphasise nav links).
export const PERSONA_ROUTES: Record<Persona, string[]> = {
  scientist: ["/records", "/compound"],
  ml: ["/acquisition", "/records"],
  manager: ["/", "/metrics"],
};

// Short per-view hint text shown when the persona is relevant to the view.
export const PERSONA_HINTS: Record<Persona, Partial<Record<string, string>>> = {
  scientist: {
    "/records":
      "Bench scientist view: is your result usable? If a row is red, open it to see exactly which fields are missing and fix them inline.",
    "/compound":
      "Bench scientist view: every measurement for this compound, grouped by what is actually comparable. Predictions are kept visually separate from measured values.",
  },
  ml: {
    "/acquisition":
      "ML engineer view: the ranked batch the loop wants made next. Watch the OOD flags and remember Boltz affinity is a ranking proxy, not ground truth.",
    "/records":
      "ML engineer view: this is the training set. Only model-ready (green) records feed the surrogate.",
  },
  manager: {
    "/":
      "Manager view: where is the loop stuck? The blocked count is the communication gap, shown as a number — click it to drill in.",
    "/metrics":
      "Manager view: throughput, blocked-by-reason, Boltz credit spend, and surrogate calibration over closed cycles.",
  },
};

interface Ctx {
  persona: Persona;
  setPersona: (p: Persona) => void;
}

const PersonaContext = createContext<Ctx | null>(null);

export function PersonaProvider({ children }: { children: ReactNode }) {
  const [persona, setPersonaState] = useState<Persona>(() => {
    try {
      return (localStorage.getItem("persona") as Persona) || "manager";
    } catch {
      return "manager";
    }
  });
  const setPersona = (p: Persona) => {
    setPersonaState(p);
    try {
      localStorage.setItem("persona", p);
    } catch {
      /* ignore */
    }
  };
  return (
    <PersonaContext.Provider value={{ persona, setPersona }}>
      {children}
    </PersonaContext.Provider>
  );
}

export function usePersona(): Ctx {
  const c = useContext(PersonaContext);
  if (!c) throw new Error("usePersona must be used within PersonaProvider");
  return c;
}

// Renders the persona hint for a given route, if relevant to the active persona.
export function PersonaHint({ route }: { route: string }) {
  const { persona } = usePersona();
  const hint = PERSONA_HINTS[persona][route];
  if (!hint) return null;
  return <div className="persona-hint">{hint}</div>;
}
