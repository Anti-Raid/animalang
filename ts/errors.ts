// An error for Anima code to catch. Anima builds its own tracebacks, and capturing V8's stack trace is most of the cost
// of an error that a program handles, so none is captured.
export const hostError = (message: string): Error => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new Error(message);
    } finally {
        Error.stackTraceLimit = limit;
    }
};
