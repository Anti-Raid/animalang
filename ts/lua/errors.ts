// Luau's runtime errors: a message of the VM's (Msg.Text), so the VM records where it happened and Luau's formatter
// prefixes it with that ("file:line: "); its message is the bare text until then
import { Msg, VMError } from "../common";

export class LuauError extends VMError {
    constructor(text: string) {
        super(Msg.Text, [text]);
        this.message = text;
    }
}

export const luauError = (text: string): LuauError => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
        return new LuauError(text);
    } finally {
        Error.stackTraceLimit = limit;
    }
};
