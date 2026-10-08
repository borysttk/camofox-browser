import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;
/**
 * Read-only transform: extracts metadata about every named/anonymous function
 * declaration in the source. Does not modify the code.
 * Returns analysis: { functions: FunctionInfo[] }.
 */
export function functionExtract(source) {
    const ast = parse(source, { sourceType: 'unambiguous' });
    const functions = [];
    traverse(ast, {
        FunctionDeclaration(path) {
            const node = path.node;
            functions.push({
                name: node.id ? node.id.name : null,
                paramCount: node.params.length,
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
            });
        },
        FunctionExpression(path) {
            const node = path.node;
            // Named function expressions
            const name = node.id ? node.id.name : null;
            functions.push({
                name,
                paramCount: node.params.length,
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
            });
        },
        ArrowFunctionExpression(path) {
            const node = path.node;
            functions.push({
                name: null,
                paramCount: node.params.length,
                line: node.loc?.start.line ?? 0,
                column: node.loc?.start.column ?? 0,
            });
        },
    });
    const out = generate(ast, { retainLines: false });
    return { code: out.code, changed: false, analysis: { functions } };
}
