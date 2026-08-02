import * as Expressive from '@expressive/react';
import { Either } from 'effect';
import type { ComponentType } from 'react';
// Sanctioned react namespace imports: they exist solely to feed the Code Lab's
// module map so user TSX can resolve its JSX runtime (see Global Constraints).
import * as React from 'react';
import * as JsxDevRuntime from 'react/jsx-dev-runtime';
import * as JsxRuntime from 'react/jsx-runtime';
import { transform } from 'sucrase';
import * as Cards from '../cards';
import { CompileError } from '../contracts/errors';
import * as Ui from '../ui';

export type CompiledCard = ComponentType<Record<string, unknown>>;

/** Namespace objects lack __esModule, which breaks sucrase's default-import interop; add it. */
function asCjsModule(namespace: object): Record<string, unknown> {
  return { __esModule: true, ...namespace };
}

const MODULE_MAP: Record<string, Record<string, unknown>> = {
  react: asCjsModule(React),
  'react/jsx-runtime': asCjsModule(JsxRuntime),
  'react/jsx-dev-runtime': asCjsModule(JsxDevRuntime),
  '@expressive/react': asCjsModule(Expressive),
  'cartis/cards': asCjsModule(Cards),
  'cartis/ui': asCjsModule(Ui),
};

export const AVAILABLE_MODULES: readonly string[] = Object.keys(MODULE_MAP).filter(
  (name) => !name.includes('jsx'),
);

function sandboxRequire(name: string): Record<string, unknown> {
  const found = MODULE_MAP[name];
  if (!found) {
    throw new Error(`Cannot import "${name}" — available modules: ${AVAILABLE_MODULES.join(', ')}`);
  }
  return found;
}

export function compileCardSource(source: string): Either.Either<CompiledCard, CompileError> {
  let code: string;
  try {
    code = transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
    }).code;
  } catch (cause) {
    return Either.left(
      new CompileError({
        phase: 'transform',
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }

  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  try {
    // Deliberate dynamic evaluation of the user's own code (local tool, not a security boundary).
    const run = new Function('require', 'module', 'exports', code) as (
      require: typeof sandboxRequire,
      module: typeof moduleShim,
      exports: typeof moduleShim.exports,
    ) => void;
    run(sandboxRequire, moduleShim, moduleShim.exports);
  } catch (cause) {
    return Either.left(
      new CompileError({
        phase: 'evaluate',
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }

  const candidate = moduleShim.exports.default;
  if (typeof candidate !== 'function') {
    return Either.left(
      new CompileError({
        phase: 'shape',
        detail: 'Module needs a component default export (export default function …)',
      }),
    );
  }
  return Either.right(candidate as CompiledCard);
}
