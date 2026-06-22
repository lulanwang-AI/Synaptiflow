import { createContext, useContext, useState, type ReactNode } from "react";

export type Persona = "scientist" | "ml" | "manager";

export const PERSONA_LABEL: Record<Persona, string> = {
  scientist: "Bench scientist",
  ml: "ML engineer / comp chemist",
  manager: "Engineering manager",
};

// Which routes each persona cares about (used to emphasise nav links).
export const PERSONA_ROUTES: Record<Persona, string[]> = {
  scientist: ["/discover", "/submit", "/records", "/compound"],
  ml: ["/discover", "/acquisition", "/records", "/submit", "/target", "/synthesis", "/workflow"],
  manager: ["/", "/discover", "/metrics", "/target", "/synthesis", "/workflow"],
};

// Short per-view hint text shown when the persona is relevant to the view.
export const PERSONA_HINTS: Record<Persona, Partial<Record<string, string>>> = {
  scientist: {
    "/discover":
      "Bench scientist view: insert a target, run the pipeline, and review the proposed hits. You are the human in the loop — accept the ones worth testing.",
    "/submit":
      "Bench scientist view: log a measurement with its full semantics. The status you get back is the policy talking — fill the metadata and watch it go green, leave it out and see why it blocks.",
    "/records":
      "Bench scientist view: is your result usable? If a row is red, open it to see exactly which fields are missing and fix them inline.",
    "/compound":
      "Bench scientist view: every measurement for this compound, grouped by what is actually comparable. Predictions are kept visually separate from measured values.",
  },
  ml: {
    "/discover":
      "ML engineer view: a custom target drives generation (POST /acquisition/run). Accepting hits returns ground truth and feeds the predicted-vs-measured delta back to the surrogate.",
    "/acquisition":
      "ML engineer view: the ranked batch the loop wants made next. Watch the OOD flags and remember Boltz affinity is a ranking proxy, not ground truth.",
    "/records":
      "ML engineer view: this is the training set. Only model-ready (green) records feed the surrogate.",
    "/submit":
      "ML engineer view: every record you add here is potential training data — but only model-ready (green) rows reach the surrogate.",
    "/target":
      "ML engineer view: the substrate the generator designs against. Boltz design/screen operate on this pocket — candidates are ranked relative to this construct.",
    "/synthesis":
      "ML engineer view: approved candidates awaiting results. Replaying closes the loop — returned Ki becomes training data and updates predicted-vs-measured calibration.",
    "/workflow":
      "ML engineer view: run the loop as a pipeline. Each node is a real call — generate/score/gate, approve, replay — so you can watch the data flow and the counts update.",
  },
  manager: {
    "/discover":
      "Manager view: the end-to-end story in one screen — insert a target, watch it process step by step, approve at the human gate, and see results feed back to the model.",
    "/":
      "Manager view: where is the loop stuck? The blocked count is the communication gap, shown as a number — click it to drill in.",
    "/metrics":
      "Manager view: throughput, blocked-by-reason, Boltz credit spend, and surrogate calibration over closed cycles.",
    "/workflow":
      "Manager view: the whole DMTA loop as one runnable pipeline. Press Run full loop to turn the crank once and watch each stage complete.",
    "/target":
      "Manager view: the project target. This single construct anchors the whole loop — design, scoring, and the comparability of every measurement key off it.",
    "/synthesis":
      "Manager view: how many candidates are in flight, and the lever to turn the loop — replay results to bring ground truth back and watch calibration update.",
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
