export function createRepositorySessionGate() {
  let epoch = 0;
  let active = { epoch, repositoryId: null, sequence: 0 };

  return {
    begin() {
      epoch += 1;
      active = { epoch, repositoryId: null, sequence: 0 };
      return epoch;
    },
    activate(token, snapshot) {
      if (token !== epoch || !snapshot?.id) return false;
      active = { epoch: token, repositoryId: snapshot.id, sequence: snapshot.sequence ?? 0 };
      return true;
    },
    acceptUpdate(token, snapshot) {
      if (token !== epoch || active.epoch !== token || snapshot?.id !== active.repositoryId) return false;
      if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence <= active.sequence) return false;
      active = { ...active, sequence: snapshot.sequence };
      return true;
    },
    isCurrent(token, repositoryId) {
      return token === epoch && active.epoch === token && (!repositoryId || active.repositoryId === repositoryId);
    },
    current() { return { ...active }; },
  };
}
