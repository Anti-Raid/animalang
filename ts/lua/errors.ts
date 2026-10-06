// Luau's runtime errors: a message of the VM's (Msg.Text), so the VM records where it happened and Luau's formatter
// prefixes it with that ("file:line: "); its message is the bare text until then
import { Msg, VMError, type SourcePos } from "../common";

export class LuauError extends VMError {
    constructor(text: string) {
        super(Msg.Text, [text]);
        this.message = text;
    }
}

// the position of an error Luau reports without one (an error raised inside a C function that is not about its
// arguments)
export const NOWHERE: SourcePos = Object.freeze({ file: "", line: 0, col: 0 });

export const luauError = (text: string): LuauError => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new LuauError(text);
    } finally {
        Error.stackTraceLimit = limit;
    }
};
