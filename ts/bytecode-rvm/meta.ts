import type { AnimaMeta } from "../common";
import { Compiler } from "./compiler";
import { deepPrint } from "./utils";
import { AnimaVM, ByteCode } from "./vm";

export const impl: AnimaMeta = {
    id: "rvm",
    vm: () => new AnimaVM("interp"),
    compiler: () => new Compiler(),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implAot: AnimaMeta = {
    id: "rvm-aot",
    vm: () => new AnimaVM("aot"),
    compiler: () => new Compiler(),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implDebug: AnimaMeta = {
    id: "rvm-debug",
    vm: () => new AnimaVM("interp"),
    compiler: () => new Compiler(true),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implAotDebug: AnimaMeta = {
    id: "rvm-aot-debug",
    vm: () => new AnimaVM("aot"),
    compiler: () => new Compiler(true),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};