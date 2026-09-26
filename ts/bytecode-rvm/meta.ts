import type { AnimaMeta } from "../common";
import { Compiler } from "./compiler";
import { deepPrint } from "./utils";
import { AnimaVM, ByteCode } from "./vm";

export const impl: AnimaMeta = {
    id: "rvm",
    vm: (_maxSteps, intrinsics) => new AnimaVM("interp", intrinsics),
    compiler: (intrinsics) => new Compiler(intrinsics),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implAot: AnimaMeta = {
    id: "rvm-aot",
    vm: (_maxSteps, intrinsics) => new AnimaVM("aot", intrinsics),
    compiler: (intrinsics) => new Compiler(intrinsics),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implDebug: AnimaMeta = {
    id: "rvm-debug",
    vm: (_maxSteps, intrinsics) => new AnimaVM("interp", intrinsics),
    compiler: (intrinsics) => new Compiler(intrinsics, true),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};

export const implAotDebug: AnimaMeta = {
    id: "rvm-aot-debug",
    vm: (_maxSteps, intrinsics) => new AnimaVM("aot", intrinsics),
    compiler: (intrinsics) => new Compiler(intrinsics, true),
    deepPrint: (bc) => deepPrint(bc as ByteCode)
};
