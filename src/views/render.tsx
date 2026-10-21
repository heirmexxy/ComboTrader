import { createContext, useContext, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Ctx } from '../lib/http';

export const CtxContext = createContext<Ctx>(null as any);
export const useC = () => useContext(CtxContext);

export function render(c: Ctx, node: ReactNode, status = 200) {
  const html = renderToStaticMarkup(<CtxContext.Provider value={c}>{node}</CtxContext.Provider>);
  c.html('<!doctype html>' + html, status);
}

/** Safe JSON for embedding in <script type="application/json">. */
export const jsonScript = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
