import { ErrorObject, IProcedure, MultipleValues, OpaqueValue, Table, isDatum } from "../common";

export class ASTStringifier {
    constructor() {}

    public stringify(ast: any): string {
        // Booleans+number
        if (typeof ast === "number") {
            if (ast === Infinity) return "+inf.0";
            if (ast === -Infinity) return "-inf.0";
            if (Number.isNaN(ast)) return "+nan.0";
            return String(ast);
        } else if (typeof ast === "boolean") {
            return ast ? "#t" : "#f"
        }

        // String
        if (typeof ast === "string") {
            return JSON.stringify(ast);
        }

        // Symbol
        if (typeof ast === "symbol") {
            return /*Symbol.keyFor(ast)*/ ast.description || ast.toString();
        }

        // Lists
        if (ast === null) return "()";

        if (isDatum(ast)) return ast.stringify(v => this.stringify(v));

        // Vectors
        if (Array.isArray(ast)) {
            const parts = ast.map(x => this.stringify(x));
            return `#(${parts.join(" ")})`;
        }

        // Tables
        if (ast instanceof Table) {
            const parts: string[] = [];
            for (const [k, v] of ast.entries()) {
                parts.push(`${this.stringify(k)} ${this.stringify(v)}`);
            }
            return `{${parts.join(" ")}}`;
        }

        // Procs
        if (ast instanceof IProcedure) {
            return `<procedure>`;
        }

        if (ast instanceof MultipleValues) {
            return `(values${ast.values.map(v => " " + this.stringify(v)).join("")})`;
        }

        if (ast instanceof OpaqueValue) {
            return `<${ast.typeName}>`;
        }

        // Errors
        if (ast instanceof ErrorObject) {
            return `<error: ${ast.error?.message}>`
        }

        // Undefined
        if (ast === undefined) return `<#void>`

        throw new Error(`Cannot stringify unknown AST node: ${JSON.stringify(ast)}`);
    }
}
