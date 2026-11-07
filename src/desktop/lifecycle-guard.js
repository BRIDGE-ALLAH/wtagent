export function createLifecycleGuard() {
  let activeOperation = null;
  let idlePromise = Promise.resolve();

  return {
    enter(operation) {
      if (activeOperation) {
        const error = new Error(`Cannot start ${operation}; ${activeOperation} is already in progress.`);
        error.code = "DESKTOP_LIFECYCLE_BUSY";
        error.activeOperation = activeOperation;
        throw error;
      }

      activeOperation = operation;
      let settle;
      idlePromise = new Promise((resolve) => { settle = resolve; });
      let released = false;

      return () => {
        if (released) return;
        released = true;
        activeOperation = null;
        settle();
      };
    },

    waitForIdle() {
      return idlePromise;
    },

    get activeOperation() {
      return activeOperation;
    },
  };
}
