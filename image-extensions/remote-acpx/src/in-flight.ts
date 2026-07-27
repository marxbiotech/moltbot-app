// Session keys with a run_coder turn currently executing.
//
// Shared via Symbol.for because jiti can load a module more than once (plugin
// loader + gateway subsystem); a module-local Set would let each copy see an
// empty guard. Lives in its own module so session-manager can consult it
// without importing tool.ts, which imports SessionManager.

const IN_FLIGHT_KEY = Symbol.for("remote-acpx.inFlightSessions");
const globalRef = globalThis as unknown as Record<symbol, Set<string>>;
if (!globalRef[IN_FLIGHT_KEY]) {
  globalRef[IN_FLIGHT_KEY] = new Set<string>();
}

export const inFlightSessions = globalRef[IN_FLIGHT_KEY];
