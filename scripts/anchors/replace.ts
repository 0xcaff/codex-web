#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs/promises";
import path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import generate from "@babel/generator";
import traverse, {
  type Binding,
  type NodePath,
  type Scope,
} from "@babel/traverse";
import * as t from "@babel/types";
import { glob } from "glob";

type MappingPair = [string, string];

const PARSER_PLUGINS: ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
];

function extractAnchorIdFromComments(
  comments: readonly (t.CommentBlock | t.CommentLine)[] | null | undefined,
): string | null {
  if (!Array.isArray(comments)) {
    return null;
  }

  for (const comment of comments) {
    const value = String(comment.value ?? "").trim();
    if (/^r3v_[A-Za-z0-9_]+$/.test(value)) {
      return value;
    }
  }

  return null;
}

function extractAnchorId(
  identifierPath: NodePath<t.Identifier>,
): string | null {
  return (
    extractAnchorIdFromComments(identifierPath.node.leadingComments) ??
    extractAnchorIdFromComments(identifierPath.parent.leadingComments)
  );
}

function findOwnBinding(
  identifierPath: NodePath<t.Identifier>,
): { binding: Binding; scope: Scope } | null {
  let currentScope: Scope | null = identifierPath.scope;

  while (currentScope) {
    const binding = currentScope.getOwnBinding(identifierPath.node.name);
    if (binding && binding.identifier === identifierPath.node) {
      return { scope: currentScope, binding };
    }
    currentScope = currentScope.parent;
  }

  return null;
}

function applyRenames(
  sourceCode: string,
  mappingByAnchor: Map<string, string>,
): { code: string; didRename: boolean } {
  const ast = parse(sourceCode, {
    sourceType: "unambiguous",
    plugins: PARSER_PLUGINS,
  });
  const renamedBindingIdentifiers = new Set<t.Identifier>();
  let didRename = false;

  traverse(ast, {
    Identifier(identifierPath: NodePath<t.Identifier>) {
      if (!identifierPath.isBindingIdentifier()) {
        return;
      }

      const anchorId = extractAnchorId(identifierPath);
      if (!anchorId) {
        return;
      }

      const nextName = mappingByAnchor.get(anchorId);
      if (!nextName) {
        return;
      }

      if (!t.isValidIdentifier(nextName)) {
        throw new Error(
          `Invalid identifier "${nextName}" for anchor ${anchorId}`,
        );
      }

      const resolved = findOwnBinding(identifierPath);
      if (!resolved) {
        return;
      }

      const { scope, binding } = resolved;
      if (renamedBindingIdentifiers.has(binding.identifier)) {
        return;
      }

      if (binding.identifier.name !== nextName) {
        scope.rename(binding.identifier.name, nextName);
        didRename = true;
      }

      renamedBindingIdentifiers.add(binding.identifier);
    },
  });

  return {
    code: generate(ast, { comments: false }).code,
    didRename,
  };
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error(
      "Expected exactly two positional arguments: <mappings-path> <destination-path>",
    );
  }

  const mappingsRootPath = path.resolve(args[0]);
  const destinationRootPath = path.resolve(args[1]);

  for (const mappingPath of await glob(`**/*.json`, {
    cwd: mappingsRootPath,
    absolute: true,
    dot: true,
    nodir: true,
  })) {
    const relativeMappingPath = path.relative(mappingsRootPath, mappingPath);
    const parsed = path.parse(relativeMappingPath);
    const destinationRelativePath = path.join(parsed.dir, `${parsed.name}.js`);

    const sourceCode = await fs.readFile(
      path.join(destinationRootPath, destinationRelativePath),
      "utf8",
    );

    const mappings = JSON.parse(await fs.readFile(mappingPath, "utf8"));
    const { code, didRename } = applyRenames(sourceCode, new Map(mappings));

    await fs.writeFile(
      path.join(destinationRootPath, destinationRelativePath),
      code,
      "utf8",
    );

    console.log(
      [
        `Applied mapping: ${mappingPath}`,
        `Source file: ${destinationRelativePath}`,
      ].join("\n"),
    );
  }
}

main(process.argv.slice(2));
