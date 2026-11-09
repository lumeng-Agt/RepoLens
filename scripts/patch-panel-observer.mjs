import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { deferredPanelObserver } from './panel-resize-observer.mjs';

const root = new URL('../node_modules/react-resizable-panels/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (pkg.version !== '4.12.2') throw Error('Review the nested panel observer patch before upgrading react-resizable-panels.');
for (const file of ['dist/react-resizable-panels.js', 'dist/react-resizable-panels.cjs']) {
  const url = new URL(file, root);
  const source = await readFile(url, 'utf8');
  if (source.includes('function deferredPanelObserver(')) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const helper = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'deferredPanelObserver');
    if (!helper) throw Error('Invalid installed panel patch');
    await writeFile(url, source.slice(0, helper.getStart(tree)) + deferredPanelObserver.toString() + source.slice(helper.end));
    continue;
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const matches = [];
  const visit = node => {
    if (ts.isNewExpression(node) && node.arguments?.length === 1 && node.arguments[0].getText(tree).includes('defaultLayoutDeferred')) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (matches.length !== 1) throw Error(`Unexpected panel observer structure in ${file}`);
  const node = matches[0];
  const replacement = `deferredPanelObserver(${node.expression.getText(tree)}, ${node.arguments[0].getText(tree)}, globalThis)`;
  await writeFile(url, source.slice(0, node.getStart(tree)) + replacement + source.slice(node.end) + '\n' + deferredPanelObserver.toString() + '\n');
}
