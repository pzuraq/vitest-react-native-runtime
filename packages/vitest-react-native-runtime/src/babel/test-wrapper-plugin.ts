/**
 * Babel plugin: wrap test file bodies in an exports.__run function.
 *
 * Transforms *.test.{ts,tsx} files so that:
 * - Import/export declarations stay at the top level (Metro needs them)
 * - All other statements (describe, it, afterEach, etc.) get wrapped in exports.__run
 * - module.hot.accept() is added so the file is its own HMR boundary
 * - module.hot.dispose() notifies listeners with the filename when the file changes
 */

interface BabelTypes {
  isImportDeclaration(node: any): boolean;
  isExportNamedDeclaration(node: any): boolean;
  isExportDefaultDeclaration(node: any): boolean;
  isExportAllDeclaration(node: any): boolean;
  isTSTypeAliasDeclaration(node: any): boolean;
  isTSInterfaceDeclaration(node: any): boolean;
  functionExpression(id: any, params: any[], body: any): any;
  blockStatement(body: any[]): any;
  expressionStatement(expression: any): any;
  assignmentExpression(operator: string, left: any, right: any): any;
  memberExpression(object: any, property: any): any;
  identifier(name: string): any;
  ifStatement(test: any, consequent: any): any;
  callExpression(callee: any, args: any[]): any;
  arrowFunctionExpression(params: any[], body: any): any;
  stringLiteral(value: string): any;
  logicalExpression(operator: string, left: any, right: any): any;
}

function isTestFile(filename: string | undefined): boolean {
  if (!filename) return false;
  return /\.test\.(tsx?|jsx?)$/.test(filename);
}

function isTopLevelDeclaration(node: any, t: BabelTypes): boolean {
  return (
    t.isImportDeclaration(node) ||
    t.isExportNamedDeclaration(node) ||
    t.isExportDefaultDeclaration(node) ||
    t.isExportAllDeclaration(node) ||
    t.isTSTypeAliasDeclaration(node) ||
    t.isTSInterfaceDeclaration(node)
  );
}

/**
 * Extract a short key from a filename like "packages/counter/tests/counter.test.tsx"
 * → "counter/counter.test.tsx"
 */
function extractTestKey(filename: string): string {
  const match = filename.match(/packages\/([^/]+)\/tests\/(.+)$/);
  if (match) return `${match[1]}/${match[2]}`;
  // Fallback: just the basename
  const parts = filename.split('/');
  return parts[parts.length - 1] ?? filename;
}

export default function testWrapperPlugin({ types: t }: { types: BabelTypes }) {
  return {
    name: 'vitest-react-native-test-wrapper',
    visitor: {
      Program(path: any, state: any) {
        const filename: string | undefined = state.filename ?? state.file?.opts?.filename;
        if (!isTestFile(filename)) return;

        const topLevel: any[] = [];
        const body: any[] = [];

        for (const node of path.node.body) {
          if (isTopLevelDeclaration(node, t)) {
            topLevel.push(node);
          } else {
            body.push(node);
          }
        }

        if (body.length === 0) return;

        const testKey = extractTestKey(filename ?? '');

        // exports.__run = function() { ...body... }
        const runFn = t.functionExpression(null, [], t.blockStatement(body));
        const runExport = t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(t.identifier('exports'), t.identifier('__run')),
            runFn,
          ),
        );

        // exports.__testKey = "counter/counter.test.tsx"
        const keyExport = t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(t.identifier('exports'), t.identifier('__testKey')),
            t.stringLiteral(testKey),
          ),
        );

        // if (module.hot) { module.hot.accept(); module.hot.dispose(...) }
        const hmrBlock = t.ifStatement(
          t.memberExpression(t.identifier('module'), t.identifier('hot')),
          t.blockStatement([
            // module.hot.accept()
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(
                  t.memberExpression(t.identifier('module'), t.identifier('hot')),
                  t.identifier('accept'),
                ),
                [],
              ),
            ),
            // module.hot.dispose(() => { listeners?.forEach(fn => fn(testKey)) })
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(
                  t.memberExpression(t.identifier('module'), t.identifier('hot')),
                  t.identifier('dispose'),
                ),
                [
                  t.arrowFunctionExpression(
                    [],
                    t.blockStatement([
                      t.expressionStatement(
                        t.callExpression(
                          t.memberExpression(
                            t.logicalExpression(
                              '&&',
                              t.memberExpression(
                                t.identifier('globalThis'),
                                t.identifier('__TEST_HMR_LISTENERS__'),
                              ),
                              t.memberExpression(
                                t.identifier('globalThis'),
                                t.identifier('__TEST_HMR_LISTENERS__'),
                              ),
                            ),
                            t.identifier('forEach'),
                          ),
                          [
                            t.arrowFunctionExpression(
                              [t.identifier('fn')],
                              t.callExpression(t.identifier('fn'), [t.stringLiteral(testKey)]),
                            ),
                          ],
                        ),
                      ),
                    ]),
                  ),
                ],
              ),
            ),
          ]),
        );

        path.node.body = [...topLevel, runExport, keyExport, hmrBlock];
      },
    },
  };
}

module.exports = testWrapperPlugin;
