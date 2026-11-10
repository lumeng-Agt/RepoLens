// @ts-check

/** @typedef {{clientId: string, intentSequence: number}} RepositoryCommand */
/** @typedef {"open" | "close"} Operation */

/** @param {string} [clientId] */
export function createRepositoryCommandIssuer(clientId = globalThis.crypto.randomUUID()) {
  let intentSequence = 0;
  return {
    clientId,
    next() { intentSequence += 1; return { clientId, intentSequence }; },
    /** @param {RepositoryCommand | null | undefined} command */
    isCurrent(command) { return command?.clientId === clientId && command.intentSequence === intentSequence; },
  };
}

export function createRepositoryCommandRegistry() {
  /** @type {Map<string, {intentSequence: number, operation: Operation}>} */
  const latestByClient = new Map();
  return {
    /** @param {RepositoryCommand | null | undefined} command @param {Operation} operation */
    accept(command, operation) {
      if (typeof command?.clientId !== "string" || !command.clientId || command.clientId.length > 128
        || !Number.isSafeInteger(command.intentSequence) || command.intentSequence < 1
        || !["open", "close"].includes(operation)) return "invalid";
      const previous = latestByClient.get(command.clientId);
      if (previous && command.intentSequence < previous.intentSequence) return "stale";
      if (previous && command.intentSequence === previous.intentSequence) return previous.operation === operation ? "duplicate" : "stale";
      latestByClient.set(command.clientId, { intentSequence: command.intentSequence, operation });
      return "accepted";
    },
    /** @param {RepositoryCommand | null | undefined} command @param {Operation} operation */
    isCurrent(command, operation) {
      const current = command ? latestByClient.get(command.clientId) : undefined;
      return Boolean(command && current && current.intentSequence === command.intentSequence && current.operation === operation);
    },
  };
}
