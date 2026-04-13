{
  description = "codex-hosted dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          asarSrc = pkgs.runCommandLocal "codex-hosted-yarn-src" { } ''
            mkdir -p "$out"
            cp ${./package.json} "$out/package.json"
            cp ${./yarn.lock} "$out/yarn.lock"
          '';

          asarOfflineCache = pkgs.fetchYarnDeps {
            yarnLock = ./yarn.lock;
            hash = "sha256-3zTR1Fv0kV1iwg1cMcbv/O/n8GLD+Bb1RStmRwbyHqE=";
          };

          asarFromYarn = pkgs.stdenvNoCC.mkDerivation {
            pname = "codex-hosted-asar";
            version = "1.0.0";
            src = asarSrc;
            yarnOfflineCache = asarOfflineCache;

            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.yarnConfigHook
              pkgs.makeWrapper
            ];

            dontBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib"
              cp -R node_modules "$out/lib/node_modules"

              mkdir -p "$out/bin"
              makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/asar" \
                --add-flags "$out/lib/node_modules/@electron/asar/bin/asar.mjs"

              runHook postInstall
            '';
          };

          src = pkgs.fetchurl {
            url = "https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-26.318.11754.zip";
            hash = "sha256-I9lgC61QrvyL/iQ7PACcNLsiO72P6oQSqvUXxtRy2aM=";
          };

          extractCodex = pkgs.writeShellScriptBin "extract-codex" ''
            set -euo pipefail

            scratch_dir="$PWD/scratch"
            app_dir="$scratch_dir/Codex.app"
            asar_dir="$scratch_dir/asar"

            mkdir -p "$scratch_dir"
            rm -rf "$app_dir" "$asar_dir"

            unzip -q -o "${src}" -d "$scratch_dir"

            ${asarFromYarn}/bin/asar extract \
              "$app_dir/Contents/Resources/app.asar" \
              "$asar_dir"

            echo "Extracted Codex.app to $app_dir"
            echo "Extracted app.asar to $asar_dir"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.yarn
              pkgs.unzip
              asarFromYarn
              extractCodex
            ];

            shellHook = ''
              echo "Run 'extract-codex' to unpack Codex.app and app.asar into ./scratch."
              echo "The 'asar' CLI is available from a fetchYarnDeps-based Nix package."
            '';
          };
        }
      );
    };
}
