// Dev-only ESM resolver hook: lets Node resolve extensionless relative imports
// (e.g. './layout') to their .ts files so the real source can run under
// --experimental-strip-types without a bundler.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[mc]?[jt]s$/.test(specifier) && context.parentURL) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
