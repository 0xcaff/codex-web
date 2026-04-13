#!/usr/bin/env node
/* eslint-disable no-console */

declare const require: any;
declare const process: any;

const fs = require("node:fs");
const path = require("node:path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

type MappingPair = [string, string];

function printUsage() {
  console.log(
    [
      "Usage:",
      "  replaceAnchors <root-path> <anchored-file> [output-file]",
      "",
      "Mapping path:",
      "  data/mappings/<path-inside-root>.json",
      "",
      "Example:",
      "  replaceAnchors /private/tmp/codex-unpacked-app /private/tmp/codex-unpacked-app/.vite/build/main-BctBUwXr.js",
      "  -> reads data/mappings/.vite/build/main-BctBUwXr.json",
    ].join("\n"),
  );
}

function parseAst(sourceCode: string) {
  return parser.parse(sourceCode, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
}

function isInsideRoot(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function toMappingPath(
  repoRoot: string,
  rootPath: string,
  anchoredFilePath: string,
) {
  if (!isInsideRoot(rootPath, anchoredFilePath)) {
    throw new Error(
      `Anchored file must be inside root path. root=${rootPath}, file=${anchoredFilePath}`,
    );
  }

  const relativeInsideRoot = path.relative(rootPath, anchoredFilePath);
  const parsed = path.parse(relativeInsideRoot);
  const mappingRelativePath = path.join(parsed.dir, `${parsed.name}.json`);
  return path.join(repoRoot, "data", "mappings", mappingRelativePath);
}

function loadMappings(mappingPath: string) {
  if (!fs.existsSync(mappingPath)) {
    throw new Error(`Mapping file not found: ${mappingPath}`);
  }

  const raw = fs.readFileSync(mappingPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Mapping file must be an array of [from, to] string pairs: ${mappingPath}`,
    );
  }

  const mappingByAnchor = new Map<string, string>();
  for (const entry of parsed) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) {
      throw new Error(
        `Invalid mapping entry in ${mappingPath}. Expected [string, string], got: ${JSON.stringify(
          entry,
        )}`,
      );
    }

    const [from, to] = entry as MappingPair;
    mappingByAnchor.set(from, to);
  }

  return mappingByAnchor;
}

function extractAnchorIdFromComments(comments: any): string | null {
  if (!Array.isArray(comments)) {
    return null;
  }

  for (const comment of comments) {
    const value = String(comment?.value ?? "").trim();
    if (/^r3v_[A-Za-z0-9_]+$/.test(value)) {
      return value;
    }
  }

  return null;
}

function extractAnchorId(identifierPath: any): string | null {
  return (
    extractAnchorIdFromComments(identifierPath.node?.leadingComments) ??
    extractAnchorIdFromComments(identifierPath.parent?.leadingComments)
  );
}

function findOwnBinding(identifierPath: any) {
  let currentScope = identifierPath.scope;

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
) {
  const ast = parseAst(sourceCode);
  const renamedBindingIdentifiers = new Set<any>();
  let appliedCount = 0;

  traverse(ast, {
    Identifier(identifierPath: any) {
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
      }

      renamedBindingIdentifiers.add(binding.identifier);
      appliedCount += 1;
    },
  });

  const code = generate(ast, { comments: true }).code;
  return { code, appliedCount };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.length < 2) {
    printUsage();
    process.exit(1);
  }

  const rootPath = path.resolve(args[0]);
  const anchoredFilePath = path.resolve(args[1]);
  const outputPath = path.resolve(args[2] ?? args[1]);
  const repoRoot = process.cwd();
  const mappingPath = toMappingPath(repoRoot, rootPath, anchoredFilePath);
  const mappingByAnchor = loadMappings(mappingPath);

  const sourceCode = fs.readFileSync(anchoredFilePath, "utf8");
  const { code, appliedCount } = applyRenames(sourceCode, mappingByAnchor);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, code, "utf8");

  console.log(
    [
      `Mappings: ${mappingPath}`,
      `Renamed bindings: ${appliedCount}`,
      `Wrote: ${outputPath}`,
    ].join("\n"),
  );
}

main();
