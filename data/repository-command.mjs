export function createRepositoryCommandIssuer(clientId = globalThis.crypto.randomUUID()) {
  let intentSequence = 0;
  return {
    clientId,
    next() { intentSequence += 1; return { clientId, intentSequence }; },
    isCurrent(command) { return command?.clientId === clientId && command.intentSequence === intentSequence; },
  };
}

export function createRepositoryCommandRegistry() {
  const latestByClient = new Map();
  return {
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
    isCurrent(command, operation) {
      const current = latestByClient.get(command?.clientId);
      return Boolean(current && current.intentSequence === command.intentSequence && current.operation === operation);
    },
  };
}
