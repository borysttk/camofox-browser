import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
// Babel modules are CJS — when imported in ESM context, default is on .default.
const traverse = _traverse.default ?? _traverse;
const generate = _generate.default ?? _generate;
export function constantFold(source) {
    const ast = parse(source, { sourceType: 'unambiguous' });
    let changed = false;
    traverse(ast, {
        BinaryExpression(path) {
            const { left, right, operator } = path.node;
            if (!t.isLiteral(left) || !t.isLiteral(right))
                return;
            const lv = left.value;
            const rv = right.value;
            let folded;
            switch (operator) {
                case '+':
                    folded = lv + rv;
                    break;
                case '-':
                    folded = lv - rv;
                    break;
                case '*':
                    folded = lv * rv;
                    break;
                case '/':
                    folded = lv / rv;
                    break;
                default: return;
            }
            if (typeof folded === 'number')
                path.replaceWith(t.numericLiteral(folded));
            else if (typeof folded === 'string')
                path.replaceWith(t.stringLiteral(folded));
            else
                return;
            changed = true;
        },
        UnaryExpression(path) {
            const { operator, argument } = path.node;
            if (operator === '!' && t.isBooleanLiteral(argument)) {
                path.replaceWith(t.booleanLiteral(!argument.value));
                changed = true;
            }
        },
    });
    const out = generate(ast, { retainLines: false });
    return { code: out.code, changed };
}
