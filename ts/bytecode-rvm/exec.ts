// The VM, by layer: bytecode.ts (code, closures) <- values.ts (frames, contexts, continuations, coroutines, Suspend)
// <- coreops.ts (the core intrinsics and control requests) <- interpreter.ts (the opcodes and the interpreter), aot/
// (the AOT compiler) <- executor.ts (VMExecutor). This module re-exports them for the rest of the VM

export { INSTRUCTION_LENGTHS, NO_REG, TAIL, UNPACK_REST, UNPACK_STRICT } from "./opcodes";
export { AotCompiler } from "./aot/compiler";
export { CodeEmitter } from "./aot/emit";
export { ByteCode, Closure, ClosureTemplate, createRegs } from "./bytecode";
export type { DirectFn, ExecutionMode, ResumeFn, UpVarLoc, UsedIntrinsic, VMHost } from "./bytecode";
export { CORE_COUNT, CORE_INTRINSICS, ControlRequest, HostTail, corePos, hostTail } from "./coreops";
export { VMExecutor } from "./executor";
export { BytecodeInterpreter, OpCode } from "./interpreter";
export { Box, CatchToken, Coroutine, EscapeContinuation, ExecutionContext, Frame, ReRaise, StackSnapshot, Suspend, VMContinuation, WindPoint, catchHere, computeWindTransition, countControlSuspend, formatTraceback, frameInfos, restValues, tailName, unpackForBinding } from "./values";
export type { CoroutineStatus, FrameInfo, PendingWindTransition, WindAction } from "./values";
