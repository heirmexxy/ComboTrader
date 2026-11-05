// Names for the AI agents. Every agent is an AI and says so if asked; the names make the team easier to talk about.
export const PERSONAS = {
  chief: { name: 'Adaeze', role: 'Chief of Staff' },
  support: { name: 'Tolu', role: 'Support' },
  onboarding: { name: 'Ngozi', role: 'Onboarding' },
  treasury: { name: 'Babajide', role: 'Treasury' },
  risk: { name: 'Musa', role: 'Risk' },
  growth: { name: 'Hauwa', role: 'Growth' },
  ops: { name: 'Efe', role: 'Ops copilot' },
  social: { name: 'Temi', role: 'Social media' },
  email: { name: 'Chidi', role: 'Email marketing' },
  prospector: { name: 'Ibrahim', role: 'Prospector' },
} as const;
export type PersonaKey = keyof typeof PERSONAS;
export const agentLabel = (a: string) => { const p = PERSONAS[a as PersonaKey]; return p ? `${p.name} · ${p.role}` : a; };
/** Added to every agent's instructions. */
export const personaLine = (a: string) => { const p = PERSONAS[a as PersonaKey]; return p ? `Your name is ${p.name}, ComboTrader's ${p.role} agent. You are an AI agent, not a person: if anyone asks, say so plainly. Sign off as "${p.name}, ComboTrader" only where a sign-off is natural.` : ''; };
