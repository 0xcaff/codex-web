#!/usr/bin/env node
/* eslint-disable no-console */

import fs from "node:fs";
import { parse, type ParseResult, type ParserPlugin } from "@babel/parser";
import generate from "@babel/generator";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

const ID_PREFIX = "r3v_";
const PARSER_PLUGINS: ParserPlugin[] = [
  "jsx",
  "typescript",
  "decorators-legacy",
];

type TaggedResult = {
  code: string;
  taggedBindings: number;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  attachAnchors --inPlace <file-1> [file-2 ...]",
      "",
      "Examples:",
      "  attachAnchors --inPlace ./dist/a.js ./dist/b.js",
    ].join("\n"),
  );
}

function parseAst(sourceCode: string): ParseResult<t.File> {
  return parse(sourceCode, {
    sourceType: "unambiguous",
    plugins: PARSER_PLUGINS,
  });
}

function tagBindingIdentifier(
  identifierPath: NodePath<t.Identifier>,
  shortId: string,
): void {
  identifierPath.node.extra = {
    ...(identifierPath.node.extra ?? {}),
    llm_id: shortId,
  };
  t.addComment(identifierPath.node, "leading", ` ${shortId} `);
}

function tagBindings(sourceCode: string): TaggedResult {
  const ast = parseAst(sourceCode);
  let idCounter = 1;

  traverse(ast, {
    Identifier(identifierPath: NodePath<t.Identifier>) {
      if (!identifierPath.isBindingIdentifier()) {
        return;
      }

      const shortId = `${ID_PREFIX}${idCounter++}`;
      tagBindingIdentifier(identifierPath, shortId);
    },
  });

  return {
    code: generate(ast, { comments: true }).code,
    taggedBindings: idCounter - 1,
  };
}

function transformFileInPlace(filePath: string): number {
  const sourceCode = fs.readFileSync(filePath, "utf8");
  const { code, taggedBindings } = tagBindings(sourceCode);

  fs.writeFileSync(filePath, code, "utf8");

  return taggedBindings;
}

function runInPlaceMode(files: string[]): void {
  if (files.length === 0) {
    printUsage();
    process.exit(1);
  }

  let totalBindings = 0;
  for (const filePath of files) {
    const taggedBindings = transformFileInPlace(filePath);
    totalBindings += taggedBindings;
    console.log(`Anchored ${taggedBindings} bindings in-place: ${filePath}`);
  }

  console.log(
    `Done. Processed ${files.length} file(s), anchored ${totalBindings} binding(s) total.`,
  );
}

function main(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.length === 0 || args[0] !== "--inPlace") {
    printUsage();
    process.exit(1);
  }

  runInPlaceMode(args.slice(1));
}

main(process.argv.slice(2));
